import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { activityEvents } from "../db/schema.js";

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
  | "hide";

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

export async function listActivity(limit = 100, type?: string) {
  const conditions = type ? eq(activityEvents.type, type) : undefined;
  return db
    .select()
    .from(activityEvents)
    .where(conditions)
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(Math.min(500, Math.max(1, limit)));
}
