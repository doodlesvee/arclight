import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

export const VAULT_KEY = "vault";

/**
 * Which sessions have opened the vault recently.
 *
 * In memory like the privacy unlock: a restart locks everyone again, which is
 * the safe direction. Shorter than the privacy window because what this guards
 * is being looked at, not a one-off delete.
 */
const unlocked = new Map<string, number>();
const UNLOCK_TTL_MS = 10 * 60 * 1000;

export function unlockVault(sessionId: string): void {
  unlocked.set(sessionId, Date.now() + UNLOCK_TTL_MS);
}

export function isVaultUnlocked(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const expires = unlocked.get(sessionId);
  if (expires === undefined) return false;
  if (expires <= Date.now()) {
    unlocked.delete(sessionId);
    return false;
  }
  return true;
}

export function lockVault(sessionId: string): void {
  unlocked.delete(sessionId);
}

export async function getVaultPinHash(): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, VAULT_KEY));
  const value = row?.value as { pinHash?: unknown } | null;
  return typeof value?.pinHash === "string" ? value.pinHash : null;
}

/** With no PIN set there is nothing to prove, so nothing to gate. */
export async function vaultPinConfigured(): Promise<boolean> {
  return (await getVaultPinHash()) !== null;
}
