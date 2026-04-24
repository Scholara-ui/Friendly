import React, { useEffect, useRef, useState } from "react";

/**
 * Renders Google's official "Sign in with Google" button using Google Identity
 * Services (GIS). When a user signs in, Google returns a signed ID token
 * (JWT) which we forward to the backend at POST /auth/google for verification.
 *
 * Props:
 *   - clientId:   Google OAuth 2.0 Client ID (Web application)
 *   - apiBase:    Backend base URL (e.g. https://api.example.com)
 *   - onSuccess:  (accessToken: string) => void  — called with our JWT
 *   - onError:    (message: string) => void
 *   - text:       "signin_with" | "signup_with" | "continue_with"
 */
export default function GoogleSignInButton({
  clientId,
  apiBase,
  onSuccess,
  onError,
  text = "continue_with",
}) {
  const containerRef = useRef(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!clientId) return;

    let cancelled = false;

    function initialize() {
      if (cancelled) return;
      const google = window.google;
      if (!google?.accounts?.id) {
        // GIS script not ready yet; retry shortly
        window.setTimeout(initialize, 120);
        return;
      }

      try {
        google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            if (!response?.credential) {
              onError?.("Google sign-in failed (no credential returned).");
              return;
            }
            try {
              const res = await fetch(`${apiBase}/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id_token: response.credential }),
              });
              const text = await res.text();
              const data = text ? JSON.parse(text) : null;
              if (!res.ok) {
                const msg = data?.detail || `HTTP ${res.status}`;
                throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
              }
              onSuccess?.(data.access_token);
            } catch (err) {
              onError?.(err?.message || "Google sign-in failed.");
            }
          },
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: true,
        });

        if (containerRef.current) {
          containerRef.current.innerHTML = "";
          google.accounts.id.renderButton(containerRef.current, {
            type: "standard",
            theme: "filled_black",
            size: "large",
            text,
            shape: "pill",
            logo_alignment: "center",
            width: Math.min(containerRef.current.clientWidth || 320, 360),
          });
        }
        setInitialized(true);
      } catch (err) {
        onError?.(err?.message || "Failed to initialize Google sign-in.");
      }
    }

    initialize();
    return () => {
      cancelled = true;
    };
  }, [clientId, apiBase, onSuccess, onError, text]);

  if (!clientId) {
    return null; // Feature not configured; render nothing
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
      <div ref={containerRef} style={{ minHeight: 44 }}>
        {!initialized ? (
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
            Loading Google sign-in…
          </div>
        ) : null}
      </div>
    </div>
  );
}
