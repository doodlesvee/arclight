import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { mediaItems, playbackHeatmap, playbackStates, watchLog } from "../db/schema.js";
import { logActivity } from "../activity/log.js";

const HEATMAP_BUCKETS = 50;

/**
 * How much of a progress report counts as watching.
 *
 * The player reports its position every few seconds. The distance moved
 * since the last report is time watched — but only when it's no more than
 * the time that actually passed, give or take, so a seek forward isn't
 * counted as having watched what it skipped. Going backwards counts nothing,
 * and so does a report arriving long after the last (a tab left open).
 */
export function secondsWatched(
  previous: { positionSeconds: number; updatedAt: Date } | undefined,
  positionSeconds: number,
  now: Date,
): number {
  if (!previous) return 0;
  const moved = positionSeconds - previous.positionSeconds;
  const elapsed = (now.getTime() - previous.updatedAt.getTime()) / 1000;
  if (moved <= 0 || elapsed <= 0 || elapsed > 120) return 0;
  // Slack for playback running at 2× and for reports arriving a little late.
  if (moved > elapsed * 2 + 3) return 0;
  return Math.round(moved);
}

export async function playbackRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { id: string }; Body: { positionSeconds: number } }>(
    "/api/media-items/:id/playback",
    async (request, reply) => {
      const mediaItemId = Number(request.params.id);
      const { positionSeconds } = request.body;

      if (typeof positionSeconds !== "number" || positionSeconds < 0) {
        reply.code(400);
        return { error: "positionSeconds must be a non-negative number" };
      }

      const now = new Date();
      const [previous] = await db
        .select({
          positionSeconds: playbackStates.positionSeconds,
          updatedAt: playbackStates.updatedAt,
        })
        .from(playbackStates)
        .where(eq(playbackStates.mediaItemId, mediaItemId));

      await db
        .insert(playbackStates)
        .values({ mediaItemId, positionSeconds })
        .onConflictDoUpdate({
          target: playbackStates.mediaItemId,
          set: { positionSeconds, updatedAt: now },
        });

      const watched = secondsWatched(previous, positionSeconds, now);
      if (watched > 0) {
        const hour = new Date(now);
        hour.setUTCMinutes(0, 0, 0);
        try {
          await db
            .insert(watchLog)
            .values({ mediaItemId, hour, seconds: watched })
            .onConflictDoUpdate({
              target: [watchLog.mediaItemId, watchLog.hour],
              set: { seconds: sql`${watchLog.seconds} + ${watched}` },
            });
        } catch (error) {
          request.log.warn({ error }, "watch log: could not record");
        }

        try {
          const [item] = await db
            .select({ durationSeconds: mediaItems.durationSeconds })
            .from(mediaItems)
            .where(eq(mediaItems.id, mediaItemId));
          if (item?.durationSeconds && item.durationSeconds > 0) {
            const bucket = Math.min(
              HEATMAP_BUCKETS - 1,
              Math.floor((positionSeconds / item.durationSeconds) * HEATMAP_BUCKETS),
            );
            await db
              .insert(playbackHeatmap)
              .values({ mediaItemId, bucket })
              .onConflictDoUpdate({
                target: [playbackHeatmap.mediaItemId, playbackHeatmap.bucket],
                set: { count: sql`${playbackHeatmap.count} + 1` },
              });
          }
        } catch (error) {
          request.log.warn({ error }, "heatmap: could not record");
        }
      }

      return { ok: true };
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/media-items/:id/heatmap",
    async (request) => {
      const mediaItemId = Number(request.params.id);
      const rows = await db
        .select({ bucket: playbackHeatmap.bucket, count: playbackHeatmap.count })
        .from(playbackHeatmap)
        .where(eq(playbackHeatmap.mediaItemId, mediaItemId))
        .orderBy(playbackHeatmap.bucket);

      const buckets = new Array(HEATMAP_BUCKETS).fill(0);
      for (const row of rows) {
        if (row.bucket >= 0 && row.bucket < HEATMAP_BUCKETS) {
          buckets[row.bucket] = row.count;
        }
      }
      return { buckets };
    },
  );

  /**
   * Empties Continue Watching.
   *
   * Resets the resume position rather than deleting the playback row: that
   * row also carries `playCount` and `completedAt`, which are a record of
   * what you actually watched. Clearing where you got to in a few unfinished
   * videos should not quietly erase that you finished thirty others.
   *
   * Scoped to unfinished videos for the same reason — a completed one isn't
   * in the row anyway, and its position is already 0.
   */
  app.delete("/api/continue-watching", async () => {
    const cleared = await db
      .update(playbackStates)
      .set({ positionSeconds: 0, updatedAt: new Date() })
      .where(and(gt(playbackStates.positionSeconds, 0), isNull(playbackStates.completedAt)))
      .returning({ id: playbackStates.id });

    return { cleared: cleared.length };
  });

  /**
   * Marks a video finished, or puts it back in the unwatched pile.
   *
   * Separate from the position endpoint on purpose: that one fires every few
   * seconds during playback, and folding a play-count increment into it would
   * count one viewing dozens of times.
   */
  app.put<{ Params: { id: string }; Body: { watched: boolean } }>(
    "/api/media-items/:id/watched",
    async (request, reply) => {
      const mediaItemId = Number(request.params.id);
      const { watched } = request.body;

      if (typeof watched !== "boolean") {
        reply.code(400);
        return { error: "watched must be a boolean" };
      }

      if (!watched) {
        // Un-marking leaves the play count alone — it's a record of what
        // actually happened, not a toggle.
        await db
          .update(playbackStates)
          .set({ completedAt: null, positionSeconds: 0, updatedAt: new Date() })
          .where(eq(playbackStates.mediaItemId, mediaItemId));
        return { ok: true, watched: false };
      }

      const now = new Date();
      // Position resets to 0 so reopening starts from the top rather than
      // offering to resume from the final seconds.
      const [row] = await db
        .insert(playbackStates)
        .values({ mediaItemId, positionSeconds: 0, completedAt: now, playCount: 1 })
        .onConflictDoUpdate({
          target: playbackStates.mediaItemId,
          set: {
            positionSeconds: 0,
            completedAt: now,
            // Watching something twice counts twice; re-marking something
            // already flagged watched doesn't.
            playCount: sql`case when ${playbackStates.completedAt} is null
              then ${playbackStates.playCount} + 1
              else ${playbackStates.playCount} end`,
            updatedAt: now,
          },
        })
        .returning({ playCount: playbackStates.playCount });

      const [item] = await db
        .select({ title: mediaItems.title })
        .from(mediaItems)
        .where(eq(mediaItems.id, mediaItemId));
      await logActivity(
        "watch",
        `Watched "${item?.title ?? `#${mediaItemId}`}"`,
        { playCount: row?.playCount ?? 1 },
        mediaItemId,
      );

      return { ok: true, watched: true, playCount: row?.playCount ?? 1 };
    }
  );
}
