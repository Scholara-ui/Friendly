import React, { useEffect, useRef } from "react";

export default function GoogleSignInButton({
  clientId,
  apiBase,
  onSuccess,
  onError,
  text = "continue_with",
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!clientId || !containerRef.current) return;

    let cancelled = false;

    function initialize() {
      if (cancelled) return;
      const google = window.google;
      if (!google?.accounts?.id) {
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
              const raw = await res.text();
              const data = raw ? JSON.parse(raw) : null;
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

        google.accounts.id.renderButton(containerRef.current, {
          type: "standard",
          theme: "filled_black",
          size: "large",
          text,
          shape: "pill",
          logo_alignment: "center",
          width: 320,
        });
      } catch (err) {
        onError?.(err?.message || "Failed to initialize Google sign-in.");
      }
    }

    initialize();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (!clientId) return null;

  return (
    <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
      <div ref={containerRef} style={{ minHeight: 44 }} />
    </div>
  );
}
