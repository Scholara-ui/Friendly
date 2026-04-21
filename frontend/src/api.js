const API_BASE = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";

async function request(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const msg = data?.detail || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return data;
}

export async function register(username, password) {
  return request("/auth/register", { method: "POST", body: { username, password } });
}

export async function login(username, password) {
  // matches your backend: /auth/login expects JSON
  return request("/auth/login", { method: "POST", body: { username, password } });
}

export async function me(token) {
  return request("/auth/me", { token });
}

export async function listConversations(token) {
  return request("/conversations", { token });
}

export async function createConversation(token, username) {
  return request("/conversations", { method: "POST", token, body: { username } });
}

export async function listMessages(token, conversationId) {
  return request(`/conversations/${conversationId}/messages`, { token });
}

export async function sendMessage(token, conversationId, text) {
  return request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    token,
    body: { text },
  });
}

/**
 * Opens a websocket that pushes new messages in real-time.
 * Returns the WebSocket instance (caller can close it).
 */
export function openConversationSocket({ token, conversationId, onMessage, onOpen, onClose, onError }) {
  const url = `${WS_BASE}/ws/conversations/${conversationId}?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);

  ws.onopen = () => onOpen?.();
  ws.onclose = () => onClose?.();
  ws.onerror = (e) => onError?.(e);

  ws.onmessage = (evt) => {
    try {
      const payload = JSON.parse(evt.data);
      onMessage?.(payload);
    } catch {
      // ignore non-json messages
    }
  };

  return ws;
}