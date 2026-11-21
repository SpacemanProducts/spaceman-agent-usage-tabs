// Keeps the Antigravity login usable without this plugin ever touching its
// credentials. agy refreshes its own token whenever it runs, so when the token
// has lapsed (or is about to) we run `agy models` once in the background and
// read the keyring again. All I/O is injected so this is testable.
export const MARGIN_MS = 2 * 60 * 1000;      // treat "expires within 2 min" as lapsing
export const KICK_COOLDOWN_MS = 10 * 60 * 1000; // never run agy more than once per 10 min

export const isFresh = (login, now) =>
  !!login && !!login.access && (!Number.isFinite(login.expiresMs) || login.expiresMs - now > MARGIN_MS);

// read(): {access, expiresMs} | null     kick(): void (runs agy briefly)
// state: {get(): number, set(ms)}        returns {login, kicked, lapsed}
export function resolveLogin({ read, kick, now = Date.now(), state }) {
  let login = read();
  if (isFresh(login, now)) return { login, kicked: false, lapsed: false };
  if (!login || !login.access) return { login, kicked: false, lapsed: false, missing: true };
  const last = state.get();
  if (!(now - last < KICK_COOLDOWN_MS)) {
    state.set(now);
    try { kick(); } catch {}
    login = read();
    if (isFresh(login, Date.now())) return { login, kicked: true, lapsed: false };
    return { login, kicked: true, lapsed: true };
  }
  return { login, kicked: false, lapsed: true, cooledDown: true };
}
