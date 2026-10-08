import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { activityEvents, mediaItems } from "../db/schema.js";

export type ActivityType =
  | "scan"
  | "backup"
  | "metadata"
  | "collection"
  | "privacy"
  | "cache"
  | "library"
  | "watch"
  | "add"
  | "edit"
  | "tag"
  | "performer"
  | "hide"
  | "duel"
  | "vault";

export async function logActivity(
  type: ActivityType,
  message: string,
  metadata?: Record<string, unknown>,
  mediaItemId?: number,
): Promise<void> {
  try {
    await db
      .insert(activityEvents)
      .values({ type, message, metadata: metadata ?? null, mediaItemId: mediaItemId ?? null });
  } catch {
    // Activity is observability, never a reason to fail the operation being observed.
  }
}

/**
 * Events about items that are currently hidden are left out unless the vault
 * is open, so the log doesn't name what the vault is there to conceal.
 */
export async function listActivity(limit = 100, type?: string, includeHidden = false) {
  const conditions: SQL[] = [];
  if (type) conditions.push(eq(activityEvents.type, type));
  if (!includeHidden) {
    conditions.push(
      sql`not exists (select 1 from ${mediaItems} where ${mediaItems.id} = ${activityEvents.mediaItemId} and ${mediaItems.hiddenAt} is not null)`,
    );
  }
  return db
    .select()
    .from(activityEvents)
    .where(and(...conditions))
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(Math.min(500, Math.max(1, limit)));
}
