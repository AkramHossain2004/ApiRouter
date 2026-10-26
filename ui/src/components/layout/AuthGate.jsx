import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon.jsx";
import { useConnection } from "../../context/ConnectionContext.jsx";
import { useSystemStatus } from "../../context/SystemStatusContext.jsx";

/**
 * Login gate.
 *
 * When the gateway is configured with `APIROUTER_API_KEYS`, every /api route
 * answers 401 until the browser presents a valid key. The system poll already
 * surfaces that as `connection.state === "auth"`, so the gate reuses it:
 *
 *   - auth required  -> a full-screen API key page replaces the whole panel
 *   - key accepted   -> the panel mounts (and only then starts its own polls)
 *   - key rejected later (rotated, wrong) -> back to the key page
 *
 * When no key is configured the gateway never returns 401, so the gate is
 * invisible and the panel opens directly, exactly as before.
 */
export function AuthGate({ children }) {
  const { connection } = useSystemStatus();
  const { hasToken, setToken } = useConnection();
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Until the first verdict arrives, show a neutral splash instead of
  // flashing the panel (or the key page) for a few hundred milliseconds.
  const resolved = useRef(false);
  if (connection.state !== "connecting") resolved.current = true;

  useEffect(() => {
    if (connection.state === "ok") {
      setSubmitted(false);
      setDraft("");
    }
  }, [connection.state]);

  if (!resolved.current) {
    return (
      <div className="auth-gate" role="status" aria-live="polite">
        <div className="auth-gate__card">
          <div className="auth-gate__brand">
            <Icon name="route" size={22} />
            <span>ApiRouter</span>
          </div>
          <p className="field__hint">Connecting…</p>
        </div>
      </div>
    );
  }

  if (connection.state !== "auth") return children;

  const verifying = submitted && connection.state === "connecting";
  const rejected = submitted && hasToken;

  const submit = (event) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setSubmitted(true);
    setToken(value);
  };

  return (
    <div className="auth-gate">
      <form className="auth-gate__card stack" onSubmit={submit}>
        <div className="auth-gate__brand">
          <Icon name="route" size={22} />
          <span>ApiRouter</span>
        </div>

        <div>
          <h1 className="auth-gate__title">API key required</h1>
          <p className="field__hint">
            This gateway is protected. Enter an API key from <code>APIROUTER_API_KEYS</code> to open the dashboard.
          </p>
        </div>

        {rejected && !verifying ? (
          <div className="notice notice--warn" role="alert">
            <Icon name="info" className="notice__icon" size={15} />
            <div>That API key was not accepted. Check it and try again.</div>
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="auth-gate-key">API key</label>
          <input
            id="auth-gate-key"
            className="input input--mono"
            type="password"
            autoComplete="off"
            spellCheck="false"
            autoFocus
            placeholder="Paste your API key"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="field__hint">Saved in this browser, so you only need to log in once. Use Connection settings to log out.</span>
        </div>

        <button type="submit" className="btn btn--primary" disabled={!draft.trim() || verifying}>
          {verifying ? "Checking…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
