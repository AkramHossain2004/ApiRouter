/**
 * Connection settings.
 *
 * The router token is the one secret this UI legitimately handles. It is kept
 * in `localStorage` so the operator logs in once per browser instead of once
 * per tab; it is scoped to this origin only and is removed by "log out" (clear
 * the token in Connection settings). A token left in `sessionStorage` by an
 * older build is migrated on first read. It is never written to logs, and
 * never rendered in full (see `lib/mask.js`).
 */

const TOKEN_KEY = "apirouter.routerToken";
const THEME_KEY = "apirouter.theme";

/** sessionStorage throws in some privacy modes; degrade rather than crash. */
function safeSession() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function safeLocal() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getRouterToken() {
  try {
    const persisted = safeLocal()?.getItem(TOKEN_KEY);
    if (persisted) return persisted;
  } catch {
    /* blocked: fall through to the tab session */
  }

  let legacy = "";
  try {
    legacy = safeSession()?.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
  if (!legacy) return "";

  // Migrate a token saved by the previous (tab-only) behaviour. If localStorage
  // is blocked the token simply stays in the tab session.
  try {
    const local = safeLocal();
    if (local) {
      local.setItem(TOKEN_KEY, legacy);
      safeSession()?.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage full or blocked: still usable for this page load */
  }
  return legacy;
}

export function setRouterToken(token) {
  const value = String(token ?? "").trim();
  try {
    if (value) {
      // If localStorage is unavailable, fall back to the tab session so login
      // still works (it just will not persist).
      const local = safeLocal();
      if (local) local.setItem(TOKEN_KEY, value);
      else safeSession()?.setItem(TOKEN_KEY, value);
    } else {
      clearRouterToken();
    }
  } catch {
    safeSession()?.setItem(TOKEN_KEY, value);
  }
}

export function clearRouterToken() {
  try { safeLocal()?.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  try { safeSession()?.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/**
 * Theme is not a secret, so it may persist. Only the resolved name is stored —
 * never user content.
 */
export function getStoredTheme() {
  const value = safeLocal()?.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : null;
}

export function setStoredTheme(theme) {
  if (theme === "light" || theme === "dark") safeLocal()?.setItem(THEME_KEY, theme);
}

export function preferredTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}
