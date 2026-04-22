import React, { useEffect, useMemo, useRef, useState, memo } from "react";
import logo from "./assets/logo.png";
import friendlyBanner from "./assets/friendly-banner.png";
import friendlyChatGhost from "./assets/friendly-chat-ghost.png";

const API_BASE = (
  import.meta.env.VITE_API_BASE ||
  `${window.location.protocol}//${window.location.hostname}:8000`
).replace(/\/+$/, "");
const WS_BASE = API_BASE.replace(/^http/, "ws");

// --- localStorage keys
const LS_TOKEN = "token"; // legacy; session-only auth uses sessionStorage
const LS_LAST_SEEN = "last_seen_by_convo_v1"; // { [convoId]: lastSeenMessageId }

function loadLastSeen() {
  try {
    return JSON.parse(localStorage.getItem(LS_LAST_SEEN) || "{}") || {};
  } catch {
    return {};
  }
}

function saveLastSeen(map) {
  localStorage.setItem(LS_LAST_SEEN, JSON.stringify(map));
}

function initialsFor(name) {
  const s = (name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || "";
  return (a + b).toUpperCase();
}

function hashColor(name) {
  const s = (name || "user").toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 45%)`;
}

function AvatarLetter({ name, size = 36 }) {
  const bg = hashColor(name);
  return (
    <div
      title={name || ""}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color: "rgba(255,255,255,0.95)",
        display: "grid",
        placeItems: "center",
        fontWeight: 900,
        letterSpacing: 0.5,
        fontSize: Math.max(12, Math.round(size * 0.38)),
        border: "1px solid rgba(255,255,255,0.18)",
        boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
        flex: "0 0 auto",
        userSelect: "none",
      }}
    >
      {initialsFor(name)}
    </div>
  );
}

function Avatar({ name, avatar_url, size = 36 }) {
  const hasUrl = Boolean(avatar_url);
  if (!hasUrl) return <AvatarLetter name={name} size={size} />;

  const src = String(avatar_url).startsWith("http")
    ? avatar_url
    : `${API_BASE}${String(avatar_url)}`;

  return (
    <img
      src={src}
      alt={name || "Avatar"}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        border: "1px solid rgba(255,255,255,0.18)",
        boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
        flex: "0 0 auto",
        userSelect: "none",
      }}
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function safeJson(res) {
  return res.text().then((t) => {
    try {
      return t ? JSON.parse(t) : {};
    } catch {
      return {};
    }
  });
}

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await safeJson(res);
  if (!res.ok) {
    const msg = data?.detail || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function apiForm(path, { method = "POST", token, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: formData,
  });

  const data = await safeJson(res);
  if (!res.ok) {
    const msg = data?.detail || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function absoluteUrl(url) {
  if (!url) return "";
  const s = String(url);
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `${API_BASE}${s}`;
}

// Sidebar is outside App to avoid remount/focus bugs
const Sidebar = memo(function Sidebar({
  me,
  conversations,
  selectedId,
  loadingConvos,
  newChatName,
  userOptions,
  chatError,
  styles,
  onSelectConversation,
  onDeleteConversation,
  onLogout,
  onOpenProfile,
  onNewChatChange,
  onStartChat,
  onStartGroupChat,
  newChatRef,
  setDrawerOpen,
  convoMeta, // { [id]: { lastText, lastAt, unreadCount } }
  avatarByUsername,
}) {
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupMode, setGroupMode] = useState(false);
  const [groupUsers, setGroupUsers] = useState([]);
  const newChatWrapRef = useRef(null);

  useEffect(() => {
    if (!newChatOpen) return;
    function onDocDown(e) {
      const el = newChatWrapRef.current;
      if (!el) return;
      if (el.contains(e.target)) return;
      setNewChatOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [newChatOpen]);

  return (
    <div className="fm-sidebar">
      <div style={styles.sidebarTop}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <img src={logo} alt="Friendly" style={{ height: 50, width: "auto" }} />
          <div style={{ lineHeight: 1.05 }}>
            <div style={{ fontWeight: 950, fontSize: 18, letterSpacing: -0.6, position: "relative", display: "inline-block" }}>
              <span
                style={{
                  background: "linear-gradient(90deg, rgba(66,133,244,1) 0%, rgba(88,166,255,1) 100%)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                Friend
              </span>
              <span
                style={{
                  background: "linear-gradient(90deg, rgba(255,170,64,1) 0%, rgba(255,120,40,1) 100%)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                ly
              </span>
              <span
                style={{
                  position: "absolute",
                  top: -5,
                  right: -6,
                  fontSize: 9,
                  fontWeight: 900,
                  color: "rgba(255,255,255,0.55)",
                }}
                aria-label="Registered trademark"
                title="Registered trademark"
              >
                ®
              </span>
            </div>
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>Messenger</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={onOpenProfile}
            aria-label="Edit profile"
            title="Edit profile"
            style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", position: "relative" }}
          >
            <Avatar name={me?.display_name || me?.username} avatar_url={me?.avatar_url} size={34} />
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                right: -2,
                bottom: -2,
                width: 16,
                height: 16,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(0,0,0,0.35)",
                display: "grid",
                placeItems: "center",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ✎
            </span>
          </button>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 700,
                fontSize: 13,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "var(--text)",
              }}
            >
              {me?.display_name || me?.username}
            </div>
            <button onClick={onLogout} style={styles.linkBtn}>
              Log out
            </button>
          </div>
        </div>
      </div>

      <div style={styles.newChat}>
        <div ref={newChatWrapRef} style={{ position: "relative", flex: 1 }}>
          <input
            ref={newChatRef}
            value={newChatName}
            onClick={() => setNewChatOpen((v) => !v)}
            onChange={(e) => {
              onNewChatChange(e.target.value);
              if (!newChatOpen) setNewChatOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setNewChatOpen(false);
              }
              if (e.key === "Enter") {
                e.preventDefault();
                setNewChatOpen(false);
                if (groupMode) {
                  onStartGroupChat(groupUsers);
                } else {
                  onStartChat();
                }
              }
            }}
            placeholder={groupMode ? "Select users for group chat…" : "Start chat with… (alex)"}
            style={styles.input2}
            autoComplete="off"
            inputMode="text"
          />

          <div style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%" }}>
            <button
              type="button"
              style={{ ...styles.actionBtn, height: 24, width: 108, padding: 0, fontSize: 10, flex: "0 0 108px" }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setGroupMode((v) => !v);
                if (!groupMode) {
                  setGroupUsers([]);
                  setNewChatOpen(true);
                }
              }}
            >
              {groupMode ? "Cancel group chat" : "Start group chat"}
            </button>
            {groupMode && groupUsers.length > 0 ? (
              <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>{groupUsers.length} selected</span>
            ) : null}
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!selectedId) return;
                onDeleteConversation?.(selectedId);
              }}
              style={{ ...styles.actionDangerBtn, height: 24, width: 108, padding: 0, fontSize: 10, borderRadius: 999, flex: "0 0 108px" }}
              disabled={!selectedId}
            >
              Delete chat
            </button>
          </div>

          {newChatOpen && userOptions && userOptions.length > 0 ? (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "calc(100% + 8px)",
                background: "rgba(0,0,0,0.55)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 14,
                overflow: "hidden",
                boxShadow: "0 18px 60px rgba(0,0,0,0.40)",
                zIndex: 5,
                maxHeight: 240,
              }}
            >
              <div style={{ maxHeight: 240, overflowY: "auto" }}>
                {userOptions.slice(0, 12).map((u) => {
                  const label = u.display_name || u.username;
                  return (
                    <button
                      key={u.id || u.username}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (groupMode) {
                          setGroupUsers((prev) => {
                            const exists = prev.includes(u.username);
                            if (exists) return prev.filter((x) => x !== u.username);
                            return [...prev, u.username];
                          });
                          return;
                        }
                        onNewChatChange(u.username);
                        setNewChatOpen(false);
                        onStartChat();
                      }}
                      style={{
                        width: "100%",
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        padding: "10px 10px",
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <AvatarLetter name={label} size={30} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 850, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {label}
                        </div>
                        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          @{u.username}
                        </div>
                      </div>
                      {groupMode ? (
                        <div style={{ fontSize: 12, color: groupUsers.includes(u.username) ? "rgba(120,220,150,0.95)" : "rgba(255,255,255,0.45)" }}>
                          {groupUsers.includes(u.username) ? "✓" : "○"}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setNewChatOpen(false);
            if (groupMode) {
              onStartGroupChat(groupUsers);
            } else {
              onStartChat();
            }
          }}
          style={{ ...styles.smallBtn, height: 42, padding: "0 10px", borderRadius: 10, minWidth: 54, fontSize: 12 }}
        >
          {groupMode ? "Create Group" : "Chat"}
        </button>
      </div>

      {chatError ? (
        <div style={{ ...styles.error, margin: "0 14px 10px" }}>{chatError}</div>
      ) : null}

      <div style={styles.list}>
        {loadingConvos && conversations.length === 0 ? (
          <div style={styles.muted}>Loading conversations…</div>
        ) : null}

        {conversations.map((c) => {
          const active = c.id === selectedId;
          const meta = convoMeta?.[c.id] || {};
          const hasUnread = (meta.unreadCount || 0) > 0;

          return (
            <button
              key={c.id}
              onClick={() => {
                onSelectConversation(c.id);
                if (setDrawerOpen) setDrawerOpen(false);
              }}
              style={{ ...styles.convoRow, ...(active ? styles.convoRowActive : {}) }}
            >
              <div style={{ position: "relative" }}>
                <Avatar
                  name={c.other_username}
                  avatar_url={avatarByUsername?.[String(c.other_username || "").toLowerCase()] || null}
                  size={36}
                />
                {hasUnread ? <span className="fm-unread-dot" /> : null}
              </div>

              <div style={{ textAlign: "left", minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.other_username}
                  </div>

                  {hasUnread ? (
                    <span className="fm-unread-badge">{meta.unreadCount}</span>
                  ) : null}
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 3 }}>
                  <div className="fm-preview">
                    {meta.lastText ? meta.lastText : `Conversation #${c.id}`}
                  </div>
                  {meta.lastAt ? (
                    <div className="fm-time">{formatTime(meta.lastAt)}</div>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}

        {conversations.length === 0 && !loadingConvos ? (
          <div style={styles.muted}>No chats yet. Start one by typing a username above.</div>
        ) : null}
      </div>
    </div>
  );
});

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(LS_TOKEN) || "");
  const [me, setMe] = useState(null);

  const [authMode, setAuthMode] = useState("login");
  const [authUser, setAuthUser] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authConfirmPass, setAuthConfirmPass] = useState("");
  const [authError, setAuthError] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get("reset_token") || "");
  const [resetPass, setResetPass] = useState("");
  const [resetConfirmPass, setResetConfirmPass] = useState("");
  const [resetMsg, setResetMsg] = useState("");
  const [resetBusy, setResetBusy] = useState(false);

  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [newChatName, setNewChatName] = useState("");
  const [chatError, setChatError] = useState("");
  const [allUsers, setAllUsers] = useState([]);

  const [messages, setMessages] = useState([]);
  const [msgText, setMsgText] = useState("");
  const [msgError, setMsgError] = useState("");
  const [selectedMsgId, setSelectedMsgId] = useState(null);
  const [msgOptionsForId, setMsgOptionsForId] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMode, setAiMode] = useState(null); // "polish" | "autocorrect"
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [kodiOpen, setKodiOpen] = useState(false);
  const [kodiBubbleOpen, setKodiBubbleOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const msgInputRef = useRef(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileFile, setProfileFile] = useState(null);
  const [profilePreviewUrl, setProfilePreviewUrl] = useState(null);
  const [profileAvatarViewOpen, setProfileAvatarViewOpen] = useState(false);
  const [profileAvatarViewUrl, setProfileAvatarViewUrl] = useState("");
  const [userProfileOpen, setUserProfileOpen] = useState(false);
  const [userProfile, setUserProfile] = useState(null); // { username, display_name, avatar_url, status_* }
  const [statusViewOpen, setStatusViewOpen] = useState(false);
  const [statusViewUrl, setStatusViewUrl] = useState("");
  const statusViewTimerRef = useRef(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [statusText, setStatusText] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const imageInputRef = useRef(null);

  const [loadingConvos, setLoadingConvos] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  useEffect(() => {
    if (!msgOptionsForId) return;
    function onDocDown(e) {
      const tgt = e.target;
      if (tgt?.closest?.('[data-msg-options-root="1"]')) return;
      setMsgOptionsForId(null);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [msgOptionsForId]);

  // Mobile drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem("sidebar_width_px") || 340);
    return Number.isFinite(raw) ? Math.min(520, Math.max(0, raw)) : 340;
  });
  const sidebarCollapsed = sidebarWidth <= 0;
  const dragRef = useRef({ active: false, startX: 0, startW: 0 });

  // Realtime (ws): typing + read receipts
  const wsRef = useRef(null);
  const typingTimerRef = useRef(null);
  const [typingByUserId, setTypingByUserId] = useState({}); // { [userId]: boolean }
  const [readByUserId, setReadByUserId] = useState({}); // { [userId]: last_read_message_id }
  const [deliveredByUserId, setDeliveredByUserId] = useState({}); // { [userId]: last_delivered_message_id }

  // Scroll handling
  const listRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);

  const newChatRef = useRef(null);

  // Prevent convo jumping
  const selectedIdRef = useRef(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Unread tracking
  const [lastSeenByConvo, setLastSeenByConvo] = useState(() => loadLastSeen());

  // convoMeta: last message preview + unread counts
  const [convoMeta, setConvoMeta] = useState({}); // { [id]: { lastText, lastAt, unreadCount } }

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedId) || null,
    [conversations, selectedId]
  );

  function clampSidebarWidth(px) {
    const MIN = 240;
    const MAX = 520;
    const SNAP_COLLAPSE_AT = 120;
    if (px <= SNAP_COLLAPSE_AT) return 0;
    return Math.min(MAX, Math.max(MIN, px));
  }

  function beginSidebarDrag(clientX) {
    dragRef.current = { active: true, startX: clientX, startW: sidebarWidth };
    try {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    function onMove(e) {
      if (!dragRef.current.active) return;
      const clientX = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
      const dx = Number(clientX) - Number(dragRef.current.startX);
      const next = clampSidebarWidth(Number(dragRef.current.startW) + dx);
      setSidebarWidth(next);
    }

    function onUp() {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      try {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      } catch {
        // ignore
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("sidebar_width_px", String(sidebarWidth));
  }, [sidebarWidth]);

  function onScrollMessages() {
    const el = listRef.current;
    if (!el) return;
    const threshold = 120;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;
  }

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function markConversationSeen(conversationId, messageList) {
    if (!conversationId) return;
    const last = messageList?.length ? messageList[messageList.length - 1] : null;
    if (!last?.id) return;

    setLastSeenByConvo((prev) => {
      const next = { ...prev, [conversationId]: last.id };
      saveLastSeen(next);
      return next;
    });

    // Clear unread badge immediately for this conversation
    setConvoMeta((prev) => {
      const cur = prev?.[conversationId];
      if (!cur) return prev;
      return {
        ...prev,
        [conversationId]: {
          ...cur,
          unreadCount: 0,
        },
      };
    });
  }

  // AUTH: load me
  useEffect(() => {
    let cancelled = false;

    async function loadMe() {
      if (!token) {
        setMe(null);
        return;
      }
      try {
        const data = await api("/auth/me", { token });
        if (cancelled) return;

        setMe(data);
        setTimeout(() => newChatRef.current?.focus(), 50);
      } catch {
        sessionStorage.removeItem(LS_TOKEN);
        if (!cancelled) {
          setToken("");
          setMe(null);
        }
      }
    }

    loadMe();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Load all users for new-chat dropdown
  useEffect(() => {
    if (!token || !me) return;
    let cancelled = false;
    async function loadUsers() {
      try {
        const data = await api("/users?limit=500", { token });
        if (cancelled) return;
        setAllUsers(Array.isArray(data) ? data : []);
      } catch {
        // ignore
      }
    }
    loadUsers();
    return () => {
      cancelled = true;
    };
  }, [token, me]);

  const userOptions = useMemo(() => {
    const needle = (newChatName || "").trim().toLowerCase();
    const list = Array.isArray(allUsers) ? allUsers : [];
    if (!needle) return list;
    return list.filter((u) => {
      const a = String(u.username || "").toLowerCase();
      const b = String(u.display_name || "").toLowerCase();
      return a.includes(needle) || b.includes(needle);
    });
  }, [allUsers, newChatName]);

  const avatarByUsername = useMemo(() => {
    const out = {};
    if (me?.username) out[String(me.username).toLowerCase()] = me.avatar_url || null;
    for (const u of Array.isArray(allUsers) ? allUsers : []) {
      const k = String(u?.username || "").toLowerCase();
      if (!k) continue;
      out[k] = u?.avatar_url || null;
    }
    return out;
  }, [allUsers, me]);

  const otherUser = useMemo(() => {
    if (!selectedConversation?.other_username) return null;
    const needle = String(selectedConversation.other_username || "").toLowerCase();
    const list = Array.isArray(allUsers) ? allUsers : [];
    return list.find((u) => String(u.username || "").toLowerCase() === needle) || null;
  }, [allUsers, selectedConversation]);

  async function openOtherUserProfile(username) {
    const u0 =
      otherUser && String(otherUser.username || "").toLowerCase() === String(username || "").toLowerCase()
        ? otherUser
        : { username };
    setUserProfile(u0);
    setUserProfileOpen(true);

    try {
      const q = encodeURIComponent(String(username || "").trim());
      if (!q) return;
      const list = await api(`/users?q=${q}&limit=10`, { token });
      const needle = String(username || "").toLowerCase();
      const hit = Array.isArray(list) ? list.find((u) => String(u.username || "").toLowerCase() === needle) : null;
      if (hit) setUserProfile(hit);
    } catch {
      // ignore
    }
  }

  // Poll conversations
  useEffect(() => {
    if (!token || !me) return;

    let cancelled = false;
    let timer = null;

    async function tick() {
      try {
        setLoadingConvos(true);
        const data = await api("/conversations", { token });
        if (cancelled) return;

        setConversations(data);

        // only auto-select if nothing selected
        if (data.length > 0 && !selectedIdRef.current) {
          setSelectedId(data[0].id);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingConvos(false);
        timer = setTimeout(tick, 2500);
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, me]);

  // Poll messages for selected convo
  useEffect(() => {
    if (!token || !me || !selectedId) return;

    let cancelled = false;

    async function loadOnce() {
      try {
        setLoadingMsgs(true);
        const data = await api(`/conversations/${selectedId}/messages`, { token });
        if (cancelled) return;

        setMessages(data);
        // mark delivered once we have the messages on screen
        if (data.length) {
          try {
            const ws = wsRef.current;
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "delivered", last_delivered_message_id: Number(data[data.length - 1].id) }));
            } else {
              await api(`/conversations/${selectedId}/delivered`, {
                method: "POST",
                token,
                body: { last_delivered_message_id: Number(data[data.length - 1].id) },
              });
            }
            // Keep local delivered state in sync for this user too
            setDeliveredByUserId((prev) => ({ ...prev, [me.id]: Number(data[data.length - 1].id) }));
          } catch {
            // ignore
          }
        }

        // Update meta + unread for this convo based on lastSeen
        const last = data.length ? data[data.length - 1] : null;
        const lastSeen = lastSeenByConvo[selectedId] || 0;

        let unreadCount = 0;
        if (lastSeen) {
          unreadCount = data.filter((m) => Number(m.id) > Number(lastSeen)).length;
        } else {
          // if never opened before, treat as unread unless it's empty
          unreadCount = data.length;
        }

        setConvoMeta((prev) => ({
          ...prev,
          [selectedId]: {
            lastText: last?.text || "",
            lastAt: last?.created_at || "",
            unreadCount: unreadCount,
          },
        }));

        // auto scroll if near bottom
        if (shouldAutoScrollRef.current) {
          requestAnimationFrame(scrollToBottom);
        }
      } catch (err) {
        // If the conversation was deleted, stop retrying it.
        const msg = err?.message || "";
        if (String(msg).toLowerCase().includes("conversation not found")) {
          setSelectedId(null);
          setMessages([]);
        }
      } finally {
        if (!cancelled) setLoadingMsgs(false);
      }
    }

    loadOnce();
    return () => {
      cancelled = true;
    };
  }, [token, me, selectedId, lastSeenByConvo]);

  // Load read/delivered states for selected convo (so sender dots work even after reconnect)
  useEffect(() => {
    if (!token || !me || !selectedId) return;
    let cancelled = false;
    async function loadStates() {
      try {
        const data = await api(`/conversations/${selectedId}/states`, { token });
        if (cancelled) return;
        const readMap = {};
        const delMap = {};
        for (const r of data?.read || []) readMap[r.user_id] = Number(r.last_read_message_id || 0);
        for (const d of data?.delivered || []) delMap[d.user_id] = Number(d.last_delivered_message_id || 0);
        setReadByUserId((prev) => {
          const next = { ...(prev || {}) };
          for (const [uid, val] of Object.entries(readMap)) {
            const n = Number(val || 0);
            const cur = Number(next[uid] || 0);
            next[uid] = n > cur ? n : cur;
          }
          return next;
        });
        setDeliveredByUserId((prev) => {
          const next = { ...(prev || {}) };
          for (const [uid, val] of Object.entries(delMap)) {
            const n = Number(val || 0);
            const cur = Number(next[uid] || 0);
            next[uid] = n > cur ? n : cur;
          }
          return next;
        });
      } catch {
        // ignore
      }
    }
    loadStates();
    return () => {
      cancelled = true;
    };
  }, [token, me, selectedId]);

  // WebSocket for selected conversation (messages + typing + read receipts)
  useEffect(() => {
    if (!token || !me || !selectedId) return;

    let destroyed = false;
    let retries = 0;
    const MAX_RETRIES = 5;
    let pingInterval = null;
    let reconnectTimer = null;

    function connect() {
      if (destroyed) return;

      const ws = new WebSocket(`${WS_BASE}/ws/conversations/${selectedId}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      // Heartbeat — keeps Render from dropping the idle connection after ~55s
      ws.onopen = () => {
        retries = 0;
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
          }
        }, 25000);
      };

      ws.onmessage = (evt) => {
        try {
          const payload = JSON.parse(evt.data);
          const type = payload?.type;

          if (type === "message" && payload.message) {
            setMessages((prev) => {
              const exists = prev.some((m) => String(m.id) === String(payload.message.id));
              return exists ? prev : [...prev, payload.message];
            });
            try {
              ws.send(JSON.stringify({ type: "delivered", last_delivered_message_id: Number(payload.message.id) }));
            } catch { /* ignore */ }
          }

          if ((type === "message_updated" || type === "message_deleted") && payload.message) {
            setMessages((prev) =>
              prev.map((m) => (String(m.id) === String(payload.message.id) ? { ...m, ...payload.message } : m))
            );
          }

          if (type === "typing") {
            const uid = payload.user_id;
            const isTyping = Boolean(payload.is_typing);
            if (uid) setTypingByUserId((prev) => ({ ...prev, [uid]: isTyping }));
          }

          if (type === "read" && payload.read) {
            const uid = payload.read.user_id;
            const lastRead = Number(payload.read.last_read_message_id || 0);
            if (uid) setReadByUserId((prev) => ({ ...prev, [uid]: lastRead }));
          }

          if (type === "delivered" && payload.delivered) {
            const uid = payload.delivered.user_id;
            const lastDelivered = Number(payload.delivered.last_delivered_message_id || 0);
            if (uid) setDeliveredByUserId((prev) => ({ ...prev, [uid]: lastDelivered }));
          }
        } catch { /* ignore */ }
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };

      ws.onclose = () => {
        clearInterval(pingInterval);
        pingInterval = null;
        if (wsRef.current === ws) wsRef.current = null;
        if (!destroyed && retries < MAX_RETRIES) {
          const delay = Math.min(1000 * 2 ** retries, 30000);
          retries += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    }

    connect();

    return () => {
      destroyed = true;
      clearInterval(pingInterval);
      clearTimeout(reconnectTimer);
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
      setTypingByUserId({});
      setDeliveredByUserId({});
    };
  }, [token, me, selectedId]);

  async function updateServerReadReceipt(conversationId, messageList) {
    const last = messageList?.length ? messageList[messageList.length - 1] : null;
    if (!conversationId || !last?.id) return;
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "read", last_read_message_id: Number(last.id) }));
      } else {
        await api(`/conversations/${conversationId}/read`, {
          method: "POST",
          token,
          body: { last_read_message_id: Number(last.id) },
        });
      }
      // Keep local read state in sync for this user too
      setReadByUserId((prev) => ({ ...prev, [me.id]: Number(last.id) }));
    } catch {
      // ignore
    }
  }

  function sendTyping(isTyping) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ type: "typing", is_typing: Boolean(isTyping) }));
    } catch {
      // ignore
    }
  }

  // Background: update previews/unread for ALL conversations (lightweight)
  useEffect(() => {
    if (!token || !me || conversations.length === 0) return;

    let cancelled = false;

    async function refreshMetaForAll() {
      try {
        const updates = {};

        // small concurrency: do sequential to keep it simple/stable
        for (const c of conversations) {
          const msgs = await api(`/conversations/${c.id}/messages`, { token });
          if (cancelled) return;

          const last = msgs.length ? msgs[msgs.length - 1] : null;
          const lastSeen = lastSeenByConvo[c.id] || 0;

          let unreadCount = 0;
          if (lastSeen) unreadCount = msgs.filter((m) => Number(m.id) > Number(lastSeen)).length;
          else unreadCount = msgs.length;

          updates[c.id] = {
            lastText: last?.text || "",
            lastAt: last?.created_at || "",
            unreadCount,
          };
        }

        if (!cancelled) setConvoMeta(updates);
      } catch {
        // ignore
      }
    }

    refreshMetaForAll();
    const t = setInterval(refreshMetaForAll, 3000);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token, me, conversations, lastSeenByConvo]);

  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError("");

    if (authMode === "register") {
      const email = authEmail.trim();
      const password = authPass;
      if (!email || !password) { setAuthError("Please enter email and password."); return; }
      if (authConfirmPass !== password) { setAuthError("Passwords do not match."); return; }
      if (!acceptTerms) { setAuthError("Please accept the Terms & Conditions."); return; }
      try {
        const result = await api("/auth/register", { method: "POST", body: { email, password } });
        sessionStorage.setItem(LS_TOKEN, result.access_token);
        setToken(result.access_token);
        setAuthPass("");
        setAuthEmail("");
        setAuthConfirmPass("");
      } catch (err) {
        setAuthError(err.message || "Registration failed.");
      }
      return;
    }

    const username = authUser.trim();
    const password = authPass;
    if (!username || !password) {
      setAuthError("Please enter username and password.");
      return;
    }
    try {
      const login = await api("/auth/login", { method: "POST", body: { username, password } });
      sessionStorage.setItem(LS_TOKEN, login.access_token);
      setToken(login.access_token);
      setAuthPass("");
    } catch (err) {
      setAuthError(err.message || "Auth failed.");
    }
  }

  async function handleForgotSubmit(e) {
    e.preventDefault();
    setForgotBusy(true);
    setForgotMsg("");
    try {
      const r = await api("/auth/forgot-password", { method: "POST", body: { email: forgotEmail.trim() } });
      setForgotMsg(r.detail || "If that email is registered, a reset link has been sent.");
    } catch (err) {
      setForgotMsg(err.message || "Something went wrong.");
    } finally {
      setForgotBusy(false);
    }
  }

  async function handleResetSubmit(e) {
    e.preventDefault();
    if (resetPass !== resetConfirmPass) { setResetMsg("Passwords do not match."); return; }
    setResetBusy(true);
    setResetMsg("");
    try {
      const r = await api("/auth/reset-password", { method: "POST", body: { token: resetToken, new_password: resetPass } });
      setResetMsg(r.detail || "Password reset! Please log in.");
      setResetToken("");
      window.history.replaceState({}, "", window.location.pathname);
    } catch (err) {
      setResetMsg(err.message || "Reset failed. The link may have expired.");
    } finally {
      setResetBusy(false);
    }
  }

  function logout() {
    sessionStorage.removeItem(LS_TOKEN);
    setToken("");
    setMe(null);
    setConversations([]);
    setSelectedId(null);
    setMessages([]);
    setDrawerOpen(false);
  }

  // Auto-logout after 30 minutes of inactivity (per-tab)
  useEffect(() => {
    if (!token) return;
    const IDLE_MS = 30 * 60 * 1000;
    let t = null;

    function reset() {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        logout();
      }, IDLE_MS);
    }

    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    reset();
    return () => {
      if (t) clearTimeout(t);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function startChat() {
    setChatError("");
    const username = newChatName.trim();
    if (!username) return;

    try {
      const convo = await api("/conversations", {
        method: "POST",
        token,
        body: { username },
      });

      setNewChatName("");

      setConversations((prev) => {
        const exists = prev.some((c) => c.id === convo.id);
        return exists ? prev : [convo, ...prev];
      });

      setSelectedId(convo.id);
      setDrawerOpen(false);

      setTimeout(() => newChatRef.current?.focus(), 50);
    } catch (err) {
      setChatError(err.message || "Failed to start chat");
    }
  }

  async function startGroupChat(usernames) {
    setChatError("");
    const list = Array.isArray(usernames)
      ? Array.from(new Set(usernames.map((u) => String(u || "").trim()).filter(Boolean)))
      : [];
    if (list.length < 2) {
      setChatError("Select at least 2 users for a group chat.");
      return;
    }
    try {
      const convo = await api("/conversations/group", {
        method: "POST",
        token,
        body: { usernames: list },
      });
      setNewChatName("");
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === convo.id);
        return exists ? prev : [convo, ...prev];
      });
      setSelectedId(convo.id);
      setDrawerOpen(false);
      setTimeout(() => newChatRef.current?.focus(), 50);
    } catch (err) {
      setChatError(err.message || "Failed to start group chat");
    }
  }

  async function deleteConversation(conversationId) {
    if (!conversationId) return;
    const ok = window.confirm("Delete this chat for everyone? This will remove the conversation and messages.");
    if (!ok) return;
    try {
      await api(`/conversations/${conversationId}`, { method: "DELETE", token });
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      setConvoMeta((prev) => {
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
      if (selectedId === conversationId) {
        setSelectedId(null);
        setMessages([]);
      }
    } catch (e) {
      setChatError(e.message || "Failed to delete chat");
    }
  }

  async function sendMessage() {
    setMsgError("");
    const text = msgText.trim();
    if (!text || !selectedId) return;

    try {
      const tempId = `temp-${Date.now()}`;
      const optimistic = {
        id: tempId,
        conversation_id: selectedId,
        sender_username: me.username,
        text,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, optimistic]);
      setMsgText("");

      shouldAutoScrollRef.current = true;
      requestAnimationFrame(scrollToBottom);

      await api(`/conversations/${selectedId}/messages`, {
        method: "POST",
        token,
        body: { text },
      });

      // stop typing after sending
      sendTyping(false);
    } catch (err) {
      setMsgError(err.message || "Failed to send");
    }
  }

  async function runAiPolish(mode) {
    if (!msgText.trim()) return;
    setAiBusy(true);
    setAiMode(mode);
    try {
      const data = await api("/ai/polish", {
        method: "POST",
        token,
        body: { text: msgText, mode },
      });
      if (data?.text) setMsgText(data.text);
    } catch (err) {
      setMsgError(err.message || "AI failed");
    } finally {
      setAiBusy(false);
      setAiMode(null);
    }
  }

  async function fetchAiSuggestions() {
    if (!selectedId) return;
    setAiBusy(true);
    setAiMode("suggest");
    try {
      const data = await api("/ai/suggestions", {
        method: "POST",
        token,
        body: { conversation_id: selectedId },
      });
      setAiSuggestions(data?.suggestions || []);
    } catch (err) {
      setMsgError(err.message || "AI failed");
    } finally {
      setAiBusy(false);
      setAiMode(null);
    }
  }

  const EMOJIS = [
    "😀",
    "😁",
    "😂",
    "🤣",
    "😃",
    "😄",
    "😅",
    "😆",
    "😉",
    "😊",
    "😋",
    "😎",
    "😍",
    "😘",
    "🥰",
    "😗",
    "😙",
    "😚",
    "🙂",
    "🙃",
    "😇",
    "🤩",
    "🤔",
    "🧐",
    "😮",
    "😯",
    "😲",
    "😣",
    "😤",
    "😫",
    "😩",
    "😭",
    "😤",
    "😡",
    "😠",
    "🤬",
    "👍",
    "👎",
    "👌",
    "✌️",
    "🤝",
    "👏",
    "🙌",
    "🙏",
    "💪",
    "💯",
    "🔥",
    "🌟",
    "✨",
    "🎉",
    "🎊",
    "🎈",
    "🚀",
    "⭐",
    "💫",
    "✅",
    "✔️",
    "❌",
    "⚠️",
    "🟢",
    "🔴",
    "🟡",
    "💬",
    "🫶",
    "❤️",
    "🧡",
    "💛",
    "💚",
    "💙",
    "💜",
    "🩷",
    "🤍",
    "🖤",
    "💔",
    "😴",
    "🤗",
    "🫡",
    "😬",
    "🤐",
    "😳",
    "😌",
    "😌",
    "🫠",
    "🙈",
    "🙉",
    "🙊",
    "🐶",
    "🐱",
    "🐻",
    "🐼",
    "🐸",
    "🦊",
    "🐵",
    "🐯",
    "🦁",
    "🍕",
    "🍔",
    "🍟",
    "🌮",
    "🍣",
    "☕",
    "🍪",
    "🎮",
    "📌",
    "🧠",
    "📎",
    "🧩",
    "🗓️",
    "🕒",
    "🎧",
    "💡",
    "🫡",
    "✋",
    "🤙",
  ];

  function insertEmoji(emoji) {
    setMsgText((prev) => `${prev}${emoji}`);
    setEmojiOpen(false);
    setTimeout(() => msgInputRef.current?.focus?.(), 0);
  }

  function openProfileModal() {
    setProfileError("");
    setProfileBusy(false);
    setProfileName(me?.display_name || "");
    setProfileEmail(me?.email || "");
    setStatusError("");
    setStatusBusy(false);
    setStatusText(me?.status_text || "");
    setProfileFile(null);
    if (profilePreviewUrl) URL.revokeObjectURL(profilePreviewUrl);
    setProfilePreviewUrl(null);
    setProfileOpen(true);
  }

  function closeProfileModal() {
    setProfileOpen(false);
    setProfileError("");
    setProfileBusy(false);
    if (profilePreviewUrl) URL.revokeObjectURL(profilePreviewUrl);
    setProfilePreviewUrl(null);
    setProfileFile(null);
  }

  async function saveProfile() {
    if (profileBusy) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      const fd = new FormData();
      fd.append("display_name", profileName);
      fd.append("email", profileEmail);
      if (profileFile) fd.append("avatar", profileFile);

      const updated = await apiForm("/me/profile", {
        method: "POST",
        token,
        formData: fd,
      });

      setMe(updated);
      setProfileOpen(false);
    } catch (err) {
      setProfileError(err.message || "Failed to save profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteMyProfile() {
    const ans = window.prompt('Are you sure? Type "yes" to delete your profile or "no" to cancel.', "no");
    if (!ans || String(ans).trim().toLowerCase() !== "yes") return;
    try {
      await api("/me", { method: "DELETE", token });
      closeProfileModal();
      logout();
    } catch (e) {
      setProfileError(e.message || "Failed to delete profile");
    }
  }

  async function saveStatus({ file, text }) {
    if (statusBusy) return;
    setStatusBusy(true);
    setStatusError("");
    try {
      const fd = new FormData();
      if (file) fd.append("image", file);
      fd.append("text_value", text || "");
      const updated = await apiForm("/me/status", {
        method: "POST",
        token,
        formData: fd,
      });
      setMe(updated);
    } catch (err) {
      setStatusError(err.message || "Failed to update status");
    } finally {
      setStatusBusy(false);
    }
  }

  async function deleteStatus() {
    if (statusBusy) return;
    const ok = window.confirm("Delete current status?");
    if (!ok) return;
    setStatusBusy(true);
    setStatusError("");
    try {
      const updated = await api("/me/status", {
        method: "DELETE",
        token,
      });
      setMe(updated);
      setStatusText("");
    } catch (err) {
      setStatusError(err.message || "Failed to delete status");
    } finally {
      setStatusBusy(false);
    }
  }

  async function sendImageMessage(file) {
    if (!selectedId || !file) return;
    setImageBusy(true);
    setMsgError("");
    try {
      const fd = new FormData();
      fd.append("image", file);

      const out = await apiForm(`/conversations/${selectedId}/messages/image`, {
        method: "POST",
        token,
        formData: fd,
      });

      setMessages((prev) => {
        const exists = prev.some((m) => String(m.id) === String(out.id));
        return exists ? prev : [...prev, out];
      });
    } catch (err) {
      setMsgError(err.message || "Failed to send image");
    } finally {
      setImageBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  // Mark selected conversation as "seen" when user opens it AND when user scrolls to bottom
  useEffect(() => {
    if (!selectedId) return;
    // once it loads, mark as seen
    markConversationSeen(selectedId, messages);
    updateServerReadReceipt(selectedId, messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Also mark as seen when user is at bottom (prevents unread staying forever)
  useEffect(() => {
    if (!selectedId || messages.length === 0) return;
    if (shouldAutoScrollRef.current) {
      markConversationSeen(selectedId, messages);
      updateServerReadReceipt(selectedId, messages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // ---------- UI ----------
  if (!token || !me) {
    return (
      <>
      <div style={styles.fullCenter}>
        <img
          src={friendlyBanner}
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "48%",
            top: "50%",
            transform: "translate(-50%, -52%)",
            width: "min(1900px, 170vw)",
            maxWidth: "none",
            opacity: 0.18,
            filter: "blur(2px)",
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
        <img
          src={friendlyChatGhost}
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            right: "-8%",
            bottom: "-6%",
            width: "min(1900px, 170vw)",
            maxWidth: "none",
            opacity: 0.18,
            filter: "blur(2px)",
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, rgba(8,14,46,0.98) 0%, rgba(8,14,46,0.82) 16%, rgba(8,14,46,0.48) 30%, rgba(8,14,46,0.0) 44%)",
            pointerEvents: "none",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, rgba(9,14,44,0) 62%, rgba(9,14,44,0.35) 76%, rgba(9,14,44,0.78) 88%, rgba(9,14,44,0.98) 100%)",
            pointerEvents: "none",
          }}
        />
        <div style={styles.authCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 1, marginBottom: 6 }}>
            <img src={logo} alt="Friendly" style={{ height: 54, width: "auto" }} />
            <div style={{ lineHeight: 1.05 }}>
              <div style={{ fontWeight: 950, fontSize: 20, letterSpacing: -0.7, position: "relative", display: "inline-block" }}>
                <span
                  style={{
                    background: "linear-gradient(90deg, rgba(66,133,244,1) 0%, rgba(88,166,255,1) 100%)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                  }}
                >
                  Friend
                </span>
                <span
                  style={{
                    background: "linear-gradient(90deg, rgba(255,170,64,1) 0%, rgba(255,120,40,1) 100%)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                  }}
                >
                  ly
                </span>
                <span
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -7,
                    fontSize: 10,
                    fontWeight: 900,
                    color: "rgba(255,255,255,0.55)",
                  }}
                  aria-label="Registered trademark"
                  title="Registered trademark"
                >
                  ®
                </span>
              </div>
            </div>
          </div>

          <div style={styles.tabs}>
            <button
              onClick={() => setAuthMode("login")}
              style={{ ...styles.tab, ...(authMode === "login" ? styles.tabActive : {}) }}
            >
              Log in
            </button>
            <button
              onClick={() => setAuthMode("register")}
              style={{ ...styles.tab, ...(authMode === "register" ? styles.tabActive : {}) }}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleAuthSubmit}>
            {authMode === "terms" ? (
              <div style={{ marginTop: 6, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 10, background: "rgba(0,0,0,0.18)", fontSize: 11, color: "var(--muted)", lineHeight: 1.45 }}>
                <div style={{ fontSize: 13, fontWeight: 850, color: "rgba(255,255,255,0.9)", marginBottom: 8 }}>Terms & Conditions</div>
                <div><b>1. Acceptable Use:</b> You agree not to use Friendly Messenger for harassment, abuse, spam, illegal activity, or sharing harmful content.</div>
                <div style={{ marginTop: 6 }}><b>2. Account Security:</b> You are responsible for keeping your password secure and for all activity under your account.</div>
                <div style={{ marginTop: 6 }}><b>3. User Content:</b> You retain responsibility for messages, images, and status uploads. Do not upload unlawful or infringing content.</div>
                <div style={{ marginTop: 6 }}><b>4. Moderation:</b> Accounts that violate these terms may be suspended or removed.</div>
                <div style={{ marginTop: 6 }}><b>5. Availability:</b> Service may be interrupted for updates, maintenance, or technical issues.</div>
                <div style={{ marginTop: 6 }}><b>6. Privacy:</b> Your profile and status data may be visible to other users according to app features and settings.</div>
                <div style={{ marginTop: 6 }}><b>7. Liability:</b> The service is provided “as is” without warranties; use at your own risk.</div>
                <div style={{ marginTop: 6 }}><b>8. Changes:</b> Terms may be updated. Continued use means you accept revised terms.</div>
                <div style={{ marginTop: 6 }}><b>9. Contact:</b> Created by Tarquin F. G, copyright © 2026.</div>
              </div>
            ) : authMode === "register" ? (
              <>
                <label style={styles.label}>Email</label>
                <input
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="you@example.com"
                  style={styles.input}
                  type="email"
                  autoComplete="email"
                />
                <label style={styles.label}>Password</label>
                <input
                  value={authPass}
                  onChange={(e) => setAuthPass(e.target.value)}
                  placeholder="••••••••"
                  style={styles.input}
                  type="password"
                  autoComplete="new-password"
                />
                <label style={styles.label}>Confirm password</label>
                <input
                  value={authConfirmPass}
                  onChange={(e) => setAuthConfirmPass(e.target.value)}
                  placeholder="••••••••"
                  style={styles.input}
                  type="password"
                  autoComplete="new-password"
                />
              </>
            ) : (
              <>
                <label style={styles.label}>Username</label>
                <input
                  value={authUser}
                  onChange={(e) => setAuthUser(e.target.value)}
                  placeholder="e.g. Tom"
                  style={styles.input}
                  autoComplete="username"
                />
                <label style={styles.label}>Password</label>
                <input
                  value={authPass}
                  onChange={(e) => setAuthPass(e.target.value)}
                  placeholder="••••••••"
                  style={styles.input}
                  type="password"
                  autoComplete="current-password"
                />
                <div style={{ textAlign: "right", marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => { setForgotOpen(true); setForgotEmail(""); setForgotMsg(""); }}
                    style={{ background: "none", border: "none", color: "rgba(120,185,255,0.9)", fontSize: 12, cursor: "pointer", padding: 0 }}
                  >
                    Forgot password?
                  </button>
                </div>
              </>
            )}

            {authError ? <div style={styles.error}>{authError}</div> : null}

            {authMode !== "terms" ? (
              <button style={styles.primaryBtn} type="submit">
                {authMode === "login" ? "Log in" : "Create account"}
              </button>
            ) : null}

            {authMode !== "terms" ? (
              <label style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(Boolean(e.target.checked))}
                />
                <span>
                  I accept the{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("terms")}
                    style={{ border: "none", background: "transparent", color: "rgba(120,185,255,0.95)", textDecoration: "underline", padding: 0, cursor: "pointer", fontSize: 12 }}
                  >
                    Terms & Conditions
                  </button>
                </span>
              </label>
            ) : null}
          </form>
        </div>
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 14,
            transform: "translateX(-50%)",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          &copy; 2026 Created by Tarquin F. G
        </div>
      </div>

      {resetToken ? (
        <div style={styles.profileOverlay}>
          <div style={{ ...styles.profileModal, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.profileHeader}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>Reset your password</div>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {resetMsg ? (
                <div style={{ color: "rgba(120,255,160,0.9)", fontSize: 13, marginBottom: 12 }}>{resetMsg}</div>
              ) : (
                <form onSubmit={handleResetSubmit}>
                  <label style={styles.label}>New password</label>
                  <input value={resetPass} onChange={(e) => setResetPass(e.target.value)} type="password" style={styles.input} autoComplete="new-password" placeholder="••••••••" />
                  <label style={styles.label}>Confirm new password</label>
                  <input value={resetConfirmPass} onChange={(e) => setResetConfirmPass(e.target.value)} type="password" style={styles.input} autoComplete="new-password" placeholder="••••••••" />
                  {resetMsg && <div style={styles.error}>{resetMsg}</div>}
                  <button style={{ ...styles.primaryBtn, marginTop: 12 }} type="submit" disabled={resetBusy}>{resetBusy ? "Resetting…" : "Set new password"}</button>
                </form>
              )}
              {resetMsg && <button style={{ ...styles.actionBtn, marginTop: 10, width: "100%" }} onClick={() => { setResetToken(""); setResetMsg(""); }}>Back to login</button>}
            </div>
          </div>
        </div>
      ) : null}

      {forgotOpen ? (
        <div style={styles.profileOverlay} onClick={() => setForgotOpen(false)}>
          <div style={{ ...styles.profileModal, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.profileHeader}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>Forgot password</div>
              <button type="button" style={styles.linkMini} onClick={() => setForgotOpen(false)}>✕</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {forgotMsg ? (
                <div style={{ color: "rgba(120,255,160,0.9)", fontSize: 13 }}>{forgotMsg}</div>
              ) : (
                <form onSubmit={handleForgotSubmit}>
                  <label style={styles.label}>Your email address</label>
                  <input value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} type="email" style={styles.input} autoComplete="email" placeholder="you@example.com" />
                  <button style={{ ...styles.primaryBtn, marginTop: 12 }} type="submit" disabled={forgotBusy}>{forgotBusy ? "Sending…" : "Send reset link"}</button>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
    );
  }

  return (
    <>
      {drawerOpen ? <div className="fm-overlay" onClick={() => setDrawerOpen(false)} /> : null}

      {resetToken ? (
        <div style={styles.profileOverlay}>
          <div style={{ ...styles.profileModal, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.profileHeader}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>Reset your password</div>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {resetMsg ? (
                <div style={{ color: "rgba(120,255,160,0.9)", fontSize: 13, marginBottom: 12 }}>{resetMsg}</div>
              ) : (
                <form onSubmit={handleResetSubmit}>
                  <label style={styles.label}>New password</label>
                  <input value={resetPass} onChange={(e) => setResetPass(e.target.value)} type="password" style={styles.input} autoComplete="new-password" placeholder="••••••••" />
                  <label style={styles.label}>Confirm new password</label>
                  <input value={resetConfirmPass} onChange={(e) => setResetConfirmPass(e.target.value)} type="password" style={styles.input} autoComplete="new-password" placeholder="••••••••" />
                  {resetMsg && <div style={styles.error}>{resetMsg}</div>}
                  <button style={{ ...styles.primaryBtn, marginTop: 12 }} type="submit" disabled={resetBusy}>{resetBusy ? "Resetting…" : "Set new password"}</button>
                </form>
              )}
              {resetMsg && <button style={{ ...styles.actionBtn, marginTop: 10, width: "100%" }} onClick={() => { setResetToken(""); setResetMsg(""); }}>Back to login</button>}
            </div>
          </div>
        </div>
      ) : null}

      {forgotOpen ? (
        <div style={styles.profileOverlay} onClick={() => setForgotOpen(false)}>
          <div style={{ ...styles.profileModal, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.profileHeader}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>Forgot password</div>
              <button type="button" style={styles.linkMini} onClick={() => setForgotOpen(false)}>✕</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {forgotMsg ? (
                <div style={{ color: "rgba(120,255,160,0.9)", fontSize: 13 }}>{forgotMsg}</div>
              ) : (
                <form onSubmit={handleForgotSubmit}>
                  <label style={styles.label}>Your email address</label>
                  <input value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} type="email" style={styles.input} autoComplete="email" placeholder="you@example.com" />
                  <button style={{ ...styles.primaryBtn, marginTop: 12 }} type="submit" disabled={forgotBusy}>{forgotBusy ? "Sending…" : "Send reset link"}</button>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {profileOpen ? <div style={styles.profileOverlay} onClick={closeProfileModal} /> : null}
      {profileOpen ? (
        <div style={styles.profileModal} role="dialog" aria-modal="true" aria-label="Profile">
          <div style={styles.profileHeader}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>Profile</div>
            <button type="button" style={styles.linkMini} onClick={closeProfileModal} aria-label="Close profile">
              ✕
            </button>
          </div>

          <div style={styles.profileBody}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              {profilePreviewUrl ? (
                <img
                  src={profilePreviewUrl}
                  alt="Preview avatar"
                  style={styles.profileAvatarImg}
                  onClick={() => {
                    setProfileAvatarViewUrl(profilePreviewUrl);
                    setProfileAvatarViewOpen(true);
                  }}
                />
              ) : (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (!me?.avatar_url) return;
                    setProfileAvatarViewUrl(absoluteUrl(me.avatar_url));
                    setProfileAvatarViewOpen(true);
                  }}
                  style={{ border: "none", background: "transparent", padding: 0, cursor: me?.avatar_url ? "pointer" : "default" }}
                  aria-label="Enlarge profile picture"
                >
                  <Avatar
                    name={me.display_name || me.username}
                    avatar_url={me.avatar_url}
                    size={64}
                  />
                </button>
              )}

              <input
                id="fm-avatar-upload"
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                  if (!f) return;
                  if (profilePreviewUrl) URL.revokeObjectURL(profilePreviewUrl);
                  setProfileFile(f);
                  setProfilePreviewUrl(URL.createObjectURL(f));
                  e.currentTarget.value = "";
                }}
                disabled={profileBusy}
              />
              <button
                type="button"
                onClick={() => document.getElementById("fm-avatar-upload")?.click?.()}
                style={styles.actionBtn}
                disabled={profileBusy}
              >
                Change profile photo
              </button>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>Display name</div>
              <input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                style={styles.input2}
                disabled={profileBusy}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>Email</div>
              <input
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
                style={styles.input2}
                type="email"
                placeholder="Used for password reset"
                disabled={profileBusy}
              />
              {!profileEmail && <div style={{ fontSize: 11, color: "rgba(255,200,80,0.85)", marginTop: 4 }}>Add email to enable password recovery</div>}
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>Status (24 hours)</div>

              {me?.status_expires_at ? (
                <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, marginBottom: 8 }}>
                  Expires at {formatTime(me.status_expires_at)}
                </div>
              ) : null}

              {me?.status_image_url ? (
                <div style={{ borderRadius: 14, overflow: "hidden", border: "1px solid rgba(255,255,255,0.14)" }}>
                  <img
                    src={absoluteUrl(me.status_image_url)}
                    alt="Status"
                    style={{ width: "100%", maxHeight: 240, objectFit: "cover", display: "block" }}
                  />
                  {me?.status_text ? (
                    <div style={{ padding: 10, background: "rgba(0,0,0,0.18)", fontSize: 13 }}>
                      {me.status_text}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!me?.status_expires_at ? (
                <>
                  <input
                    id="fm-status-upload"
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    disabled={statusBusy}
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                      if (!f) return;
                      saveStatus({ file: f, text: statusText });
                      e.currentTarget.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => document.getElementById("fm-status-upload")?.click?.()}
                    style={styles.actionBtn}
                    disabled={statusBusy}
                  >
                    Add status image
                  </button>
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      value={statusText}
                      onChange={(e) => setStatusText(e.target.value)}
                      placeholder="Add a short status text (optional)…"
                      style={{ ...styles.input2, minHeight: 64, resize: "vertical" }}
                      disabled={statusBusy}
                      maxLength={300}
                    />
                  </div>
                  <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      style={styles.actionBtn}
                      disabled={statusBusy || (!statusText.trim() && !statusText)}
                      onClick={() => saveStatus({ file: null, text: statusText })}
                    >
                      {statusBusy ? "Saving…" : "Post status"}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 8 }}>
                  You can add a new status after the current one expires.
                </div>
              )}

              {me?.status_expires_at || me?.status_image_url || me?.status_text ? (
                <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" style={styles.actionDangerBtn} onClick={deleteStatus} disabled={statusBusy}>
                    Delete status
                  </button>
                </div>
              ) : null}

              {statusError ? <div style={{ ...styles.error, marginTop: 10 }}>{statusError}</div> : null}
            </div>

            {profileError ? <div style={{ ...styles.error, marginTop: 10 }}>{profileError}</div> : null}

            <div style={{ display: "flex", justifyContent: "center", gap: 14, marginTop: 14 }}>
              <button type="button" style={styles.actionBtn} onClick={closeProfileModal} disabled={profileBusy}>
                Cancel
              </button>
              <button type="button" style={styles.actionBtn} onClick={saveProfile} disabled={profileBusy}>
                {profileBusy ? "Saving..." : "Save"}
              </button>
              <button type="button" style={styles.actionDangerBtn} onClick={deleteMyProfile} disabled={profileBusy}>
                Delete profile
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {profileAvatarViewOpen ? (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", zIndex: 120, display: "grid", placeItems: "center", padding: 18 }}
          onClick={() => {
            setProfileAvatarViewOpen(false);
            setProfileAvatarViewUrl("");
          }}
        >
          {profileAvatarViewUrl ? (
            <img
              src={profileAvatarViewUrl}
              alt="Profile picture"
              style={{ display: "block", maxWidth: "92vw", maxHeight: "82vh", borderRadius: 18, objectFit: "contain" }}
            />
          ) : null}
        </div>
      ) : null}

      {userProfileOpen ? (
        <div
          style={styles.profileOverlay}
          onClick={() => {
            setUserProfileOpen(false);
            setUserProfile(null);
          }}
        />
      ) : null}
      {userProfileOpen ? (
        <div style={styles.profileModal} role="dialog" aria-modal="true" aria-label="User profile">
          <div style={styles.profileHeader}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>{userProfile?.display_name || userProfile?.username || "Profile"}</div>
            <button
              type="button"
              style={styles.linkMini}
              onClick={() => {
                setUserProfileOpen(false);
                setUserProfile(null);
              }}
              aria-label="Close profile"
            >
              ✕
            </button>
          </div>

          <div style={styles.profileBody}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              {userProfile?.avatar_url ? (
                <img
                  src={absoluteUrl(userProfile.avatar_url)}
                  alt="Profile avatar"
                  style={{ display: "block", maxWidth: "100%", maxHeight: 420, borderRadius: 18, objectFit: "contain", border: "1px solid rgba(255,255,255,0.14)" }}
                  onClick={() => {
                    setProfileAvatarViewUrl(absoluteUrl(userProfile.avatar_url));
                    setProfileAvatarViewOpen(true);
                  }}
                />
              ) : (
                <Avatar name={userProfile?.display_name || userProfile?.username || "User"} avatar_url={null} size={96} />
              )}

              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {userProfile?.username ? `@${userProfile.username}` : ""}
              </div>

              <button
                type="button"
                style={styles.linkMini}
                onClick={async () => {
                  try {
                    const q = encodeURIComponent(String(userProfile?.username || "").trim());
                    if (!q) return;
                    const list = await api(`/users?q=${q}&limit=10`, { token });
                    const needle = String(userProfile?.username || "").toLowerCase();
                    const hit = Array.isArray(list) ? list.find((u) => String(u.username || "").toLowerCase() === needle) : null;
                    if (hit) setUserProfile(hit);
                    const statusUrl = hit?.status_image_url || userProfile?.status_image_url;
                    const statusExp = hit?.status_expires_at || userProfile?.status_expires_at;
                    if (!statusUrl || !statusExp) return;
                    if (statusViewTimerRef.current) window.clearTimeout(statusViewTimerRef.current);
                    setStatusViewUrl(absoluteUrl(statusUrl));
                    setStatusViewOpen(true);
                    statusViewTimerRef.current = window.setTimeout(() => {
                      setStatusViewOpen(false);
                      setStatusViewUrl("");
                    }, 5000);
                  } catch {
                    // ignore
                  }
                }}
              >
                View status
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {statusViewOpen ? (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", zIndex: 120, display: "grid", placeItems: "center", padding: 18 }}
          onClick={() => {
            if (statusViewTimerRef.current) window.clearTimeout(statusViewTimerRef.current);
            setStatusViewOpen(false);
            setStatusViewUrl("");
          }}
        >
          {statusViewUrl ? (
            <img src={statusViewUrl} alt="Status" style={{ display: "block", maxWidth: "92vw", maxHeight: "82vh", borderRadius: 18, objectFit: "contain" }} />
          ) : null}
        </div>
      ) : null}

      <div className={`fm-drawer ${drawerOpen ? "open" : ""}`}>
        <Sidebar
          me={me}
          conversations={conversations}
          selectedId={selectedId}
          loadingConvos={loadingConvos}
          newChatName={newChatName}
          userOptions={userOptions}
          chatError={chatError}
          styles={styles}
          onSelectConversation={(id) => {
            setSelectedId(id);
            // mark as seen immediately on open
            const meta = convoMeta[id];
            if (meta && messages.length) markConversationSeen(id, messages);
          }}
          onDeleteConversation={deleteConversation}
          onLogout={logout}
          onOpenProfile={openProfileModal}
          onNewChatChange={setNewChatName}
          onStartChat={startChat}
          onStartGroupChat={startGroupChat}
          newChatRef={newChatRef}
          setDrawerOpen={setDrawerOpen}
          convoMeta={convoMeta}
          avatarByUsername={avatarByUsername}
        />
      </div>

      <div className="fm-shell" style={{ display: "flex" }}>
        {!sidebarCollapsed ? (
          <div className="fm-desktop-only" style={{ width: sidebarWidth, minWidth: 0, flex: "0 0 auto" }}>
            <Sidebar
              me={me}
              conversations={conversations}
              selectedId={selectedId}
              loadingConvos={loadingConvos}
              newChatName={newChatName}
              userOptions={userOptions}
              chatError={chatError}
              styles={styles}
              onSelectConversation={(id) => {
                setSelectedId(id);
              }}
              onDeleteConversation={deleteConversation}
              onLogout={logout}
              onOpenProfile={openProfileModal}
              onNewChatChange={setNewChatName}
              onStartChat={startChat}
              onStartGroupChat={startGroupChat}
              newChatRef={newChatRef}
              setDrawerOpen={null}
              convoMeta={convoMeta}
              avatarByUsername={avatarByUsername}
            />
          </div>
        ) : null}

        {sidebarCollapsed ? (
          <div
            className="fm-desktop-only"
            role="separator"
            aria-orientation="vertical"
            title="Drag to show chats"
            onMouseDown={(e) => beginSidebarDrag(e.clientX)}
            onTouchStart={(e) => {
              const x = e.touches && e.touches[0] ? e.touches[0].clientX : 0;
              beginSidebarDrag(x);
            }}
            style={{
              width: 18,
              cursor: "col-resize",
              flex: "0 0 auto",
              background: "transparent",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 4,
                top: "50%",
                transform: "translateY(-50%)",
                width: 10,
                height: 44,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(255,255,255,0.06)",
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <span style={{ width: 2, height: 10, background: "rgba(255,255,255,0.35)", borderRadius: 99 }} />
                <span style={{ width: 2, height: 10, background: "rgba(255,255,255,0.35)", borderRadius: 99 }} />
              </div>
            </div>
          </div>
        ) : (
          <div
            className="fm-desktop-only"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize chats"
            onMouseDown={(e) => beginSidebarDrag(e.clientX)}
            onTouchStart={(e) => {
              const x = e.touches && e.touches[0] ? e.touches[0].clientX : 0;
              beginSidebarDrag(x);
            }}
            style={{
              width: 10,
              cursor: "col-resize",
              flex: "0 0 auto",
              background: "transparent",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: 0,
                bottom: 0,
                width: 2,
                transform: "translateX(-50%)",
                background: "rgba(255,255,255,0.10)",
              }}
            />
          </div>
        )}

        <div className="fm-chatpanel" style={{ flex: "1 1 auto", minWidth: 0 }}>
          {/* Profile / presence strip */}
          <div style={{ padding: 10, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Avatar name={me.display_name || me.username} avatar_url={me.avatar_url} size={30} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                  {me.display_name || me.username}
                  <span
                    aria-label={token ? "Online" : "Offline"}
                    title={token ? "Online" : "Offline"}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      display: "inline-block",
                      border: "1px solid rgba(255,255,255,0.22)",
                      background: token ? "rgba(64, 220, 120, 0.95)" : "rgba(148,148,148,0.95)",
                    }}
                  />
                </div>
                {me.last_active_at ? (
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    Active at {formatTime(me.last_active_at)}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="fm-topbar">
            <button className="fm-topbar-btn" onClick={() => setDrawerOpen(true)} aria-label="Open chats">
              ☰
            </button>

            <div className="title">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!selectedConversation?.other_username) return;
                  openOtherUserProfile(selectedConversation.other_username);
                }}
                style={{ border: "none", background: "transparent", padding: 0, cursor: selectedConversation?.other_username ? "pointer" : "default" }}
                aria-label="Open user profile"
              >
                <Avatar name={selectedConversation?.other_username || me.username} avatar_url={otherUser?.avatar_url || null} size={34} />
              </button>
              <div style={{ minWidth: 0 }}>
                <div className="name">{selectedConversation?.other_username || "Select a chat"}</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  {selectedConversation ? "Chat" : "Open chats to select"}
                </div>
              </div>
            </div>

            <button className="fm-topbar-btn" onClick={logout} aria-label="Log out">
              ⎋
            </button>
          </div>

          <div style={styles.chatTop}>
            {selectedConversation ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    openOtherUserProfile(selectedConversation.other_username);
                  }}
                  style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
                  aria-label="Open user profile"
                >
                  <Avatar name={selectedConversation.other_username} avatar_url={otherUser?.avatar_url || null} size={36} />
                </button>
                <div>
                  <div style={{ fontWeight: 850, fontSize: 14 }}>{selectedConversation.other_username}</div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    {(() => {
                      const otherTyping = Object.entries(typingByUserId).some(([uid, v]) => v && String(uid) !== String(me.id));
                      if (otherTyping) return "Typing…";
                      return "Messages update automatically";
                    })()}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ color: "var(--muted)" }}>Select a conversation</div>
            )}
          </div>

          <div ref={listRef} onScroll={onScrollMessages} style={styles.messages}>
            {selectedId && loadingMsgs && messages.length === 0 ? (
              <div style={styles.muted}>Loading messages…</div>
            ) : null}

            {!selectedId ? <div style={styles.muted}>Pick a chat (☰ on mobile).</div> : null}

            {messages.map((m) => {
              const mine = m.sender_username?.toLowerCase() === me.username.toLowerCase();
              const msgSelected = String(selectedMsgId) === String(m.id);
              const optionsOpen = String(msgOptionsForId) === String(m.id);
              const otherReadLevel = Math.max(
                0,
                ...Object.entries(readByUserId)
                  .filter(([uid]) => String(uid) !== String(me.id))
                  .map(([, v]) => Number(v || 0))
              );
              const otherDeliveredLevel = Math.max(
                0,
                ...Object.entries(deliveredByUserId)
                  .filter(([uid]) => String(uid) !== String(me.id))
                  .map(([, v]) => Number(v || 0))
              );
              const msgIdNum = Number(m.id || 0);
              const showDot = mine && Number.isFinite(msgIdNum) && !String(m.id).startsWith("temp-");
              const dotState = showDot
                ? msgIdNum <= otherReadLevel
                  ? "read"
                  : msgIdNum <= otherDeliveredLevel
                    ? "delivered"
                    : null
                : null;
              return (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    gap: 10,
                    marginBottom: 12,
                    flexDirection: mine ? "row" : "row-reverse",
                  }}
                >
                  <Avatar
                    name={m.sender_username}
                    avatar_url={avatarByUsername[String(m.sender_username || "").toLowerCase()] || null}
                    size={32}
                  />
                  <div style={{ maxWidth: "72%" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: mine ? "flex-start" : "flex-end",
                        gap: 10,
                        marginBottom: 4,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{mine ? "You" : m.sender_username}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{formatTime(m.created_at)}</div>
                      {m.edited_at ? <div style={{ fontSize: 12, color: "var(--muted)" }}>edited</div> : null}
                    </div>

                    <div
                      onClick={() => {
                        setSelectedMsgId(m.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedMsgId(m.id);
                        if (mine && !m.deleted) setMsgOptionsForId(m.id);
                      }}
                      style={{
                        ...styles.bubble,
                        ...(mine ? styles.bubbleMine : styles.bubbleTheirs),
                        ...(msgSelected
                          ? {
                              outline: "2px solid rgba(88,166,255,0.55)",
                              boxShadow: "0 0 0 3px rgba(88,166,255,0.12)",
                            }
                          : {}),
                        cursor: "pointer",
                        position: "relative",
                      }}
                    >
                      {mine && !m.deleted && msgSelected ? (
                        <div
                          data-msg-options-root="1"
                          style={{
                            position: "absolute",
                            top: 8,
                            right: 10,
                            zIndex: 2,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                        >
                          {optionsOpen ? (
                            <div
                              style={{
                                position: "absolute",
                                top: 0,
                                right: 0,
                                minWidth: 150,
                                background: "rgba(0,0,0,0.62)",
                                border: "1px solid rgba(255,255,255,0.14)",
                                borderRadius: 12,
                                padding: 10,
                                boxShadow: "0 18px 60px rgba(0,0,0,0.40)",
                              }}
                            >
                              <button
                                type="button"
                                style={styles.actionBtn}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={async (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setMsgOptionsForId(null);
                                  const next = window.prompt("Edit message", m.text);
                                  if (next == null) return;
                                  const t = String(next).trim();
                                  if (!t) return;
                                  try {
                                    await api(`/messages/${m.id}`, { method: "PATCH", token, body: { text: t } });
                                  } catch (err) {
                                    setMsgError(err.message || "Failed to edit");
                                  }
                                }}
                              >
                                Edit message
                              </button>
                              <div style={{ height: 8 }} />
                              <button
                                type="button"
                                style={styles.actionDangerBtn}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={async (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setMsgOptionsForId(null);
                                  if (!window.confirm("Delete this message?")) return;
                                  try {
                                    await api(`/messages/${m.id}`, { method: "DELETE", token });
                                  } catch (err) {
                                    setMsgError(err.message || "Failed to delete");
                                  }
                                }}
                              >
                                Delete message
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {m && !m.deleted && m.image_url ? (
                        <img
                          src={absoluteUrl(m.image_url)}
                          alt="Sent image"
                          style={styles.messageImage}
                        />
                      ) : null}
                      {m.text ? m.text : null}
                    </div>

                    {mine && dotState ? (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                        <div
                          title={dotState === "read" ? "Read" : "Delivered"}
                          style={{ display: "flex", gap: 4, alignItems: "center" }}
                        >
                          <span
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: 999,
                              display: "inline-block",
                              border: "1px solid rgba(255,255,255,0.22)",
                              background: "rgba(64, 220, 120, 0.95)",
                              boxShadow: "0 0 0 2px rgba(64, 220, 120, 0.18)",
                            }}
                          />
                          {dotState === "read" ? (
                            <span
                              style={{
                                width: 9,
                                height: 9,
                                borderRadius: 999,
                                display: "inline-block",
                                border: "1px solid rgba(255,255,255,0.22)",
                                background: "rgba(64, 220, 120, 0.95)",
                                boxShadow: "0 0 0 2px rgba(64, 220, 120, 0.18)",
                              }}
                            />
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                  </div>
                </div>
              );
            })}
          </div>

          <div style={styles.composer}>
            {msgError ? <div style={{ ...styles.error, marginBottom: 8 }}>{msgError}</div> : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                  if (!f) return;
                  sendImageMessage(f);
                }}
              />

              {emojiOpen && selectedId ? (
                <div style={styles.emojiPicker}>
                  <div style={styles.emojiGrid}>
                    {EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        style={styles.emojiItem}
                        onClick={() => insertEmoji(e)}
                        aria-label={`Insert emoji ${e}`}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "min(980px, 100%)", margin: "0 auto" }}>
                <div style={{ position: "relative", display: "flex", gap: 8, alignItems: "center", flex: 1, minWidth: 0 }}>
                {kodiBubbleOpen ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 6,
                      bottom: "calc(100% + 10px)",
                      width: 290,
                      padding: "10px 12px",
                      borderRadius: 14,
                      background: "rgba(0,0,0,0.92)",
                      border: "1px solid rgba(255,255,255,0.14)",
                      color: "var(--text)",
                      fontSize: 12,
                      boxShadow: "0 18px 60px rgba(0,0,0,0.40)",
                      zIndex: 10,
                      pointerEvents: "none",
                    }}
                  >
                    Hi! I am Kodi! your "Friendly" AI assistant
                  </div>
                ) : null}
                <input
                  value={msgText}
                  ref={msgInputRef}
                  onChange={(e) => setMsgText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                    if (e.key === "Escape") {
                      setKodiOpen(false);
                    }
                  }}
                  placeholder={selectedId ? "Type a message…" : "Select a conversation first…"}
                  style={{ ...styles.input2, flex: 1, paddingRight: 102, borderRadius: 999, minHeight: 42 }}
                  disabled={!selectedId}
                  onInput={() => {
                    if (!selectedId) return;
                    sendTyping(true);
                    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                    typingTimerRef.current = setTimeout(() => sendTyping(false), 900);
                  }}
                  onFocus={() => setKodiOpen(false)}
                />

                <button
                  type="button"
                  aria-label="Open emoji picker"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setEmojiOpen((v) => !v)}
                  disabled={!selectedId || aiBusy}
                  style={{
                    position: "absolute",
                    right: 72,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    border: "1px solid rgba(88,166,255,0.45)",
                    background: "rgba(88,166,255,0.12)",
                    color: "var(--text)",
                    padding: 0,
                    lineHeight: 1,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    fontSize: 12,
                  }}
                >
                  😊
                </button>

                <button
                  type="button"
                  aria-label="Send image"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => imageInputRef.current?.click?.()}
                  disabled={!selectedId || imageBusy || aiBusy}
                  style={{
                    position: "absolute",
                    right: 41,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    border: "1px solid rgba(88,166,255,0.45)",
                    background: "rgba(88,166,255,0.12)",
                    color: "var(--text)",
                    padding: 0,
                    lineHeight: 1,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    fontSize: 12,
                  }}
                >
                  📎
                </button>

                <button
                  type="button"
                  aria-label="Kodi AI"
                  title="Hello, I'm Kodi — your friendly AI assistant."
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setKodiBubbleOpen(true)}
                  onMouseLeave={() => setKodiBubbleOpen(false)}
                  onClick={() => setKodiOpen((v) => !v)}
                  disabled={!selectedId || aiBusy}
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    border: "1px solid rgba(88,166,255,0.45)",
                    background: "rgba(88,166,255,0.12)",
                    color: "var(--text)",
                    fontWeight: 900,
                    padding: 0,
                    lineHeight: 1,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    fontSize: 12,
                  }}
                >
                  🤖
                </button>

                {kodiOpen ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 6,
                      bottom: "calc(100% + 10px)",
                      width: 220,
                      background: "rgba(0,0,0,0.55)",
                      border: "1px solid rgba(255,255,255,0.14)",
                      borderRadius: 14,
                      overflow: "hidden",
                      boxShadow: "0 18px 60px rgba(0,0,0,0.40)",
                      zIndex: 10,
                    }}
                  >
                    <button
                      type="button"
                      style={{ width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer" }}
                      disabled={!msgText.trim() || aiBusy}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setKodiOpen(false);
                        runAiPolish("autocorrect");
                      }}
                    >
                      Autocorrect
                    </button>
                    <button
                      type="button"
                      style={{ width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderTop: "1px solid rgba(255,255,255,0.10)" }}
                      disabled={!msgText.trim() || aiBusy}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setKodiOpen(false);
                        runAiPolish("polish");
                      }}
                    >
                      Polish tone
                    </button>
                    <button
                      type="button"
                      style={{ width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", borderTop: "1px solid rgba(255,255,255,0.10)" }}
                      disabled={!selectedId || aiBusy}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setKodiOpen(false);
                        fetchAiSuggestions();
                      }}
                    >
                      Suggest replies
                    </button>
                  </div>
                ) : null}
                </div>
                <button
                  onClick={sendMessage}
                  disabled={!selectedId || !msgText.trim() || imageBusy}
                  aria-label="Send message"
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 999,
                    border: "1px solid rgba(79, 124, 255, 0.55)",
                    background: "linear-gradient(180deg, rgba(79,124,255,0.95), rgba(79,124,255,0.75))",
                    color: "#fff",
                    cursor: "pointer",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 16,
                    padding: 0,
                  }}
                >
                  ➤
                </button>
              </div>
            </div>

            {aiSuggestions.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {aiSuggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    style={styles.suggestionChip}
                    onClick={() => setMsgText(s.text)}
                  >
                    {s.text}
                  </button>
                ))}
              </div>
            )}

            <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 12 }}>
              Tip: Press <b>Enter</b> to send.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const styles = {
  fullCenter: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 20,
    position: "relative",
    overflow: "hidden",
    background:
      "radial-gradient(1200px 700px at 22% 45%, rgba(14,32,96,0.22) 0%, rgba(9,17,54,0.12) 42%, rgba(8,12,34,0.0) 72%), linear-gradient(180deg, rgba(8,14,46,0.96), rgba(8,14,46,0.96))",
  },
  authCard: {
    width: "min(420px, 92vw)",
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 18,
    padding: "8px 18px 18px",
    boxShadow: "var(--shadow)",
    backdropFilter: "blur(10px)",
  },
  tabs: {
    display: "flex",
    gap: 8,
    background: "var(--panel2)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 6,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    border: "none",
    background: "transparent",
    color: "var(--text)",
    padding: "10px 12px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 750,
  },
  tabActive: {
    background: "var(--brand2)",
    border: "1px solid rgba(79, 124, 255, 0.35)",
  },
  label: {
    display: "block",
    marginTop: 10,
    marginBottom: 6,
    color: "var(--muted)",
    fontSize: 12,
    fontWeight: 700,
  },
  input: {
    width: "100%",
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "rgba(0,0,0,0.25)",
    color: "var(--text)",
    outline: "none",
  },
  input2: {
    width: "100%",
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "rgba(0,0,0,0.18)",
    color: "var(--text)",
    outline: "none",
  },
  aiBtn: {
    border: "1px solid rgba(88,166,255,0.45)",
    borderRadius: 999,
    padding: "6px 10px",
    background: "rgba(88,166,255,0.10)",
    color: "var(--text)",
    fontSize: 11,
    cursor: "pointer",
  },
  primaryBtn: {
    marginTop: 14,
    width: "100%",
    border: "none",
    borderRadius: 12,
    padding: "12px 12px",
    background: "linear-gradient(180deg, rgba(79,124,255,0.95), rgba(79,124,255,0.75))",
    color: "white",
    fontWeight: 850,
    cursor: "pointer",
  },
  smallBtn: {
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 12,
    padding: "10px 14px",
    background: "rgba(79,124,255,0.20)",
    color: "var(--text)",
    fontWeight: 850,
    cursor: "pointer",
  },
  error: {
    marginTop: 10,
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255, 80, 80, 0.35)",
    background: "rgba(255, 80, 80, 0.10)",
    color: "rgba(255, 210, 210, 0.95)",
    fontSize: 13,
    fontWeight: 650,
  },
  muted: {
    color: "var(--muted)",
    fontSize: 13,
    padding: 14,
  },
  sidebarTop: {
    padding: 14,
    borderBottom: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    gap: 14,
    alignItems: "center",
  },
  linkBtn: {
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    padding: 0,
    cursor: "pointer",
    fontSize: 12,
    textDecoration: "underline",
  },
  linkMini: {
    border: "none",
    background: "transparent",
    color: "rgba(255,255,255,0.75)",
    padding: 0,
    cursor: "pointer",
    fontSize: 12,
    textDecoration: "underline",
  },
  linkMiniDanger: {
    border: "none",
    background: "transparent",
    color: "rgba(255, 160, 160, 0.95)",
    padding: 0,
    cursor: "pointer",
    fontSize: 12,
    textDecoration: "underline",
  },
  actionBtn: {
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.92)",
    padding: "6px 10px",
    borderRadius: 999,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
  },
  actionDangerBtn: {
    border: "1px solid rgba(255,120,120,0.45)",
    background: "rgba(255,120,120,0.16)",
    color: "rgba(255,210,210,0.98)",
    padding: "6px 10px",
    borderRadius: 999,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
  },
  newChat: {
    padding: 14,
    display: "flex",
    gap: 10,
    borderBottom: "1px solid var(--border)",
  },
  list: {
    overflow: "auto",
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  convoRow: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    background: "rgba(0,0,0,0.16)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "var(--text)",
    cursor: "pointer",
  },
  convoRowActive: {
    background: "rgba(79,124,255,0.24)",
    border: "1px solid rgba(79, 124, 255, 0.70)",
    boxShadow: "0 0 0 2px rgba(79,124,255,0.18)",
  },
  chatTop: {
    padding: 14,
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  messages: {
    flex: 1,
    overflow: "auto",
    padding: 16,
  },
  bubble: {
    padding: "10px 12px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.10)",
    lineHeight: 1.35,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  messageImage: {
    display: "block",
    maxWidth: "100%",
    maxHeight: 360,
    borderRadius: 14,
    marginBottom: 8,
    objectFit: "cover",
  },
  bubbleMine: {
    background: "var(--mine)",
  },
  bubbleTheirs: {
    background: "var(--theirs)",
  },
  composer: {
    padding: 14,
    borderTop: "1px solid var(--border)",
    background: "rgba(0,0,0,0.10)",
  },
  suggestionChip: {
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.20)",
    background: "rgba(255,255,255,0.08)",
    color: "var(--text)",
    fontSize: 11,
    padding: "6px 10px",
    cursor: "pointer",
    maxWidth: "100%",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  emojiPicker: {
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.30)",
    borderRadius: 12,
    padding: 6,
    marginTop: 2,
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
    maxHeight: 160,
    overflowY: "auto",
  },
  emojiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(10, 1fr)",
    gap: 4,
  },
  emojiItem: {
    border: "none",
    borderRadius: 9,
    background: "rgba(255,255,255,0.06)",
    color: "var(--text)",
    cursor: "pointer",
    padding: "5px 0",
    fontSize: 16,
    lineHeight: 1,
  },
  profileOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.55)",
    zIndex: 100,
  },
  profileModal: {
    position: "fixed",
    zIndex: 110,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(520px, 92vw)",
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 18,
    boxShadow: "var(--shadow)",
    padding: 14,
    backdropFilter: "blur(10px)",
  },
  profileHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
    padding: "0 2px",
  },
  profileBody: {
    padding: 2,
  },
  profileAvatarImg: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,0.18)",
    boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
  },
};