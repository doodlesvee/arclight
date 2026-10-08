export type AuthUser = { id: number; username: string };
export type AuthStatus = { needsSetup: boolean; user: AuthUser | null };

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed: ${res.status}`);
  return data as T;
}

/**
 * Thrown when the server is refusing this device outright.
 *
 * Distinct from any other failure because the answer is different: nothing is
 * broken and signing in will not help — the switch is off, and it can only be
 * turned back on from the machine the server runs on.
 */
export class LanBlockedError extends Error {
  constructor() {
    super("Local network access is turned off for this server.");
    this.name = "LanBlockedError";
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status");
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    if (body?.code === "lan_disabled") throw new LanBlockedError();
  }
  if (!res.ok) throw new Error(`Failed to load auth status: ${res.status}`);
  return res.json();
}

export function login(username: string, password: string) {
  return postJson<{ user: AuthUser }>("/api/auth/login", { username, password });
}

export function setupAccount(username: string, password: string) {
  return postJson<{ user: AuthUser }>("/api/auth/setup", { username, password });
}

export async function updateUsername(username: string): Promise<{ user: AuthUser }> {
  const res = await fetch("/api/auth/account", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  const data = (await res.json().catch(() => null)) as { user?: AuthUser; error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed: ${res.status}`);
  return data as { user: AuthUser };
}

export function changePassword(currentPassword: string, newPassword: string) {
  return postJson<{ ok: true }>("/api/auth/password", { currentPassword, newPassword });
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to sign out: ${res.status}`);
}
