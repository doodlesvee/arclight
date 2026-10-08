export type VaultStatus = { hasPin: boolean; unlocked: boolean; count: number | null };

export type VaultItem = {
  id: number;
  title: string;
  itemType: string;
  thumbnailFile: string | null;
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  thumbnailScale: number;
  durationSeconds: number | null;
  hiddenAt: string | null;
};

export type VaultItemsPage = { items: VaultItem[]; page: number; pageSize: number; hasMore: boolean };

/** Thrown when the PIN is wrong; carries what the server said about further tries. */
export class PinError extends Error {
  attemptsLeft?: number;
  retryAfterSeconds?: number;

  constructor(message: string, attemptsLeft?: number, retryAfterSeconds?: number) {
    super(message);
    this.attemptsLeft = attemptsLeft;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function failure(res: Response, fallback: string): Promise<Error> {
  const detail = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(detail?.error ?? `${fallback}: ${res.status}`);
}

export async function fetchVault(): Promise<VaultStatus> {
  const res = await fetch("/api/vault");
  if (!res.ok) throw await failure(res, "Failed to load the vault");
  return res.json();
}

export async function unlockVault(pin: string): Promise<void> {
  const res = await fetch("/api/vault/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    attemptsLeft?: number;
    retryAfterSeconds?: number;
  } | null;
  throw new PinError(body?.error ?? "Could not unlock", body?.attemptsLeft, body?.retryAfterSeconds);
}

export async function setVaultPin(pin: string, accountPassword: string): Promise<void> {
  const res = await fetch("/api/vault/pin", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, accountPassword }),
  });
  if (!res.ok) throw await failure(res, "Failed to set the PIN");
}

export async function lockVault(): Promise<void> {
  await fetch("/api/vault/lock", { method: "POST", keepalive: true });
}

export async function fetchVaultItems(): Promise<VaultItemsPage> {
  const res = await fetch("/api/vault/items");
  if (!res.ok) throw await failure(res, "Failed to load hidden items");
  return res.json();
}

export function describePinError(err: unknown): string {
  if (err instanceof PinError) {
    if (err.retryAfterSeconds !== undefined) {
      return `Too many attempts. Try again in ${err.retryAfterSeconds}s.`;
    }
    if (err.attemptsLeft !== undefined) {
      return `Wrong PIN. ${err.attemptsLeft} ${err.attemptsLeft === 1 ? "try" : "tries"} left.`;
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
