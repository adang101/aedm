/** localStorage wrappers that never throw (private windows, blocked storage). */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the app works without it */
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

const NAME_KEY = "aedm.display_name";
const tokenKey = (code: string) => `aedm.auth.${code.toUpperCase()}`;

export interface StoredAuth {
  auth_token: string;
  player_id: string;
}

export const loadDisplayName = (): string => storageGet(NAME_KEY) ?? "";
export const saveDisplayName = (name: string): void => storageSet(NAME_KEY, name);

export function loadAuth(code: string): StoredAuth | null {
  const raw = storageGet(tokenKey(code));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredAuth>;
    if (typeof v.auth_token === "string" && typeof v.player_id === "string") return { auth_token: v.auth_token, player_id: v.player_id };
  } catch {
    /* fall through */
  }
  return null;
}

export const saveAuth = (code: string, auth: StoredAuth): void => storageSet(tokenKey(code), JSON.stringify(auth));
export const clearAuth = (code: string): void => storageRemove(tokenKey(code));
