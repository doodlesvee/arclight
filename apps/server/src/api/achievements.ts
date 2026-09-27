import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

const ACHIEVEMENTS_KEY = "achievements";

/**
 * When each badge was first unlocked.
 *
 * The badges themselves are worked out in the browser from /api/insights —
 * streaks and "night owl" depend on the viewer's time zone — so the server
 * only keeps the record of what has already been announced. That is what
 * lets an unlock toast fire exactly once, on whichever device sees it first.
 *
 * `seeded` is false until the first save. The client uses it to record the
 * badges that were already earned before this existed without toasting
 * every one of them at once.
 */
export type AchievementRecord = { unlocked: Record<string, string>; seeded: boolean };

// Completionist ids carry a studio name, so ids are free text — bounded,
// not patterned.
const MAX_ID_LENGTH = 200;
const MAX_IDS_PER_SAVE = 500;
const MAX_STORED = 5000;

export async function getAchievements(): Promise<AchievementRecord> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, ACHIEVEMENTS_KEY));
  const value = row?.value as Partial<AchievementRecord> | null;
  // Re-validated on read: a hand-edited row keeps only well-formed entries.
  const unlocked: Record<string, string> = {};
  if (value?.unlocked && typeof value.unlocked === "object") {
    for (const [id, at] of Object.entries(value.unlocked)) {
      if (typeof at === "string" && !Number.isNaN(Date.parse(at))) unlocked[id] = at;
    }
  }
  return { unlocked, seeded: value?.seeded === true };
}

/**
 * Records ids not seen before, stamped now. An id already recorded keeps its
 * original date, so a second device reporting the same badge changes nothing.
 */
export async function recordUnlocks(ids: string[]): Promise<AchievementRecord> {
  const current = await getAchievements();
  const now = new Date().toISOString();
  const unlocked = { ...current.unlocked };
  for (const id of ids) {
    if (Object.keys(unlocked).length >= MAX_STORED) break;
    if (!(id in unlocked)) unlocked[id] = now;
  }
  const value: AchievementRecord = { unlocked, seeded: true };
  await db
    .insert(appSettings)
    .values({ key: ACHIEVEMENTS_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return value;
}

export async function achievementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/achievements", async () => getAchievements());

  app.post<{ Body: { ids?: unknown } }>("/api/achievements/unlock", async (request, reply) => {
    const ids = request.body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_IDS_PER_SAVE ||
      !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH)
    ) {
      reply.code(400);
      return { error: `ids must be up to ${MAX_IDS_PER_SAVE} non-empty strings` };
    }
    return recordUnlocks(ids as string[]);
  });
}
