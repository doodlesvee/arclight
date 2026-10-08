import { and, asc, desc, eq, gte, gt, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  duels,
  mediaItemPerformers,
  mediaItemTypes,
  mediaItems,
  performers,
  studios,
} from "../db/schema.js";
import { logActivity } from "../activity/log.js";
import { applyDuel } from "../library/elo.js";
import { visibleItems } from "../library/visibility.js";

/** A video needs this many duels before its score says anything about it. */
export const MIN_DUELS_FOR_RATING = 3;
/** Fewer ranked videos than this and the star buckets would be arbitrary. */
export const MIN_RANKED_FOR_RATING = 5;

const NEAREST_POOL = 5;
const MAX_EXCLUDE = 20;
const LEADERBOARD_MAX = 200;

function eligibleVideos(): SQL {
  const videoTypeIds = db
    .select({ id: mediaItemTypes.id })
    .from(mediaItemTypes)
    .where(eq(mediaItemTypes.name, "video"));
  return and(visibleItems(), inArray(mediaItems.itemTypeId, videoTypeIds))!;
}

const cardColumns = {
  id: mediaItems.id,
  title: mediaItems.title,
  thumbnailFile: mediaItems.thumbnailFile,
  thumbnailPositionX: mediaItems.thumbnailPositionX,
  thumbnailPositionY: mediaItems.thumbnailPositionY,
  thumbnailScale: mediaItems.thumbnailScale,
  durationSeconds: mediaItems.durationSeconds,
  releaseDate: mediaItems.releaseDate,
  studioName: studios.name,
  rating: mediaItems.rating,
  duelScore: mediaItems.duelScore,
  duelCount: mediaItems.duelCount,
};

async function withPerformers<T extends { id: number }>(rows: T[]) {
  const ids = rows.map((r) => r.id);
  const links =
    ids.length === 0
      ? []
      : await db
          .select({
            mediaItemId: mediaItemPerformers.mediaItemId,
            id: performers.id,
            name: performers.name,
          })
          .from(mediaItemPerformers)
          .innerJoin(performers, eq(performers.id, mediaItemPerformers.performerId))
          .where(inArray(mediaItemPerformers.mediaItemId, ids));
  return rows.map((row) => ({
    ...row,
    performers: links
      .filter((l) => l.mediaItemId === row.id)
      .map((l) => ({ id: l.id, name: l.name })),
  }));
}

function parseIds(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_EXCLUDE);
}

export async function duelRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The next two videos to compare.
   *
   * The anchor is whichever video has been compared least, so everything gets
   * placed quickly. Its opponent is drawn from the few closest in score that
   * it has not already faced: close scores are the matchups that teach the
   * ranking the most, and a repeat teaches it nothing.
   */
  app.get<{ Querystring: { exclude?: string } }>("/api/duels/pair", async (request) => {
    const exclude = parseIds(request.query.exclude);
    const notExcluded = exclude.length > 0 ? notInArray(mediaItems.id, exclude) : undefined;

    const [anchor] = await db
      .select({ id: mediaItems.id, score: mediaItems.duelScore })
      .from(mediaItems)
      .where(and(eligibleVideos(), notExcluded))
      .orderBy(asc(mediaItems.duelCount), sql`random()`)
      .limit(1);
    if (!anchor) return { pair: null };

    const history = await db
      .select({ winnerId: duels.winnerId, loserId: duels.loserId })
      .from(duels)
      .where(or(eq(duels.winnerId, anchor.id), eq(duels.loserId, anchor.id)));
    const faced = history.map((d) => (d.winnerId === anchor.id ? d.loserId : d.winnerId));

    async function nearest(skip: number[]) {
      return db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(
          and(
            eligibleVideos(),
            sql`${mediaItems.id} <> ${anchor.id}`,
            notExcluded,
            skip.length > 0 ? notInArray(mediaItems.id, skip) : undefined,
          ),
        )
        .orderBy(sql`abs(${mediaItems.duelScore} - ${anchor.score})`, sql`random()`)
        .limit(NEAREST_POOL);
    }

    let pool = await nearest(faced);
    if (pool.length === 0) pool = await nearest([]);
    if (pool.length === 0) return { pair: null };

    const opponent = pool[Math.floor(Math.random() * pool.length)];
    const cards = await db
      .select(cardColumns)
      .from(mediaItems)
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .where(inArray(mediaItems.id, [anchor.id, opponent.id]));

    const enriched = await withPerformers(cards);
    const ordered = Math.random() < 0.5 ? enriched : [...enriched].reverse();
    return { pair: ordered };
  });

  app.post<{ Body: { winnerId?: number; loserId?: number } }>(
    "/api/duels",
    async (request, reply) => {
      const { winnerId, loserId } = request.body ?? {};
      if (
        !Number.isInteger(winnerId) ||
        !Number.isInteger(loserId) ||
        winnerId === loserId
      ) {
        reply.code(400);
        return { error: "winnerId and loserId must be two different item ids" };
      }

      const result = await db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: mediaItems.id,
            title: mediaItems.title,
            score: mediaItems.duelScore,
          })
          .from(mediaItems)
          .where(and(inArray(mediaItems.id, [winnerId!, loserId!]), eligibleVideos()))
          .for("update");
        const winner = rows.find((r) => r.id === winnerId);
        const loser = rows.find((r) => r.id === loserId);
        if (!winner || !loser) return null;

        const next = applyDuel(winner.score, loser.score);
        await tx
          .update(mediaItems)
          .set({ duelScore: next.winner, duelCount: sql`${mediaItems.duelCount} + 1` })
          .where(eq(mediaItems.id, winner.id));
        await tx
          .update(mediaItems)
          .set({ duelScore: next.loser, duelCount: sql`${mediaItems.duelCount} + 1` })
          .where(eq(mediaItems.id, loser.id));
        await tx.insert(duels).values({
          winnerId: winner.id,
          loserId: loser.id,
          winnerScoreBefore: winner.score,
          loserScoreBefore: loser.score,
        });
        return { winner, loser, next };
      });

      if (!result) {
        reply.code(404);
        return { error: "Both items must be videos you can see" };
      }

      await logActivity(
        "duel",
        `Picked "${result.winner.title}" over "${result.loser.title}"`,
        { winnerScore: result.next.winner, loserScore: result.next.loser },
        result.winner.id,
      );

      return {
        ok: true,
        winner: { id: result.winner.id, score: result.next.winner },
        loser: { id: result.loser.id, score: result.next.loser },
      };
    },
  );

  /** Takes back the most recent duel, restoring both scores exactly. */
  app.post("/api/duels/undo", async (_request, reply) => {
    const undone = await db.transaction(async (tx) => {
      const [last] = await tx.select().from(duels).orderBy(desc(duels.id)).limit(1);
      if (!last) return null;

      await tx
        .update(mediaItems)
        .set({
          duelScore: last.winnerScoreBefore,
          duelCount: sql`greatest(${mediaItems.duelCount} - 1, 0)`,
        })
        .where(eq(mediaItems.id, last.winnerId));
      await tx
        .update(mediaItems)
        .set({
          duelScore: last.loserScoreBefore,
          duelCount: sql`greatest(${mediaItems.duelCount} - 1, 0)`,
        })
        .where(eq(mediaItems.id, last.loserId));
      await tx.delete(duels).where(eq(duels.id, last.id));
      return last;
    });

    if (!undone) {
      reply.code(404);
      return { error: "No duels to undo" };
    }
    return { ok: true, undone: { winnerId: undone.winnerId, loserId: undone.loserId } };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/duels/leaderboard", async (request) => {
    const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number(request.query.limit ?? 50) || 50));

    const rows = await db
      .select(cardColumns)
      .from(mediaItems)
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .where(and(eligibleVideos(), gt(mediaItems.duelCount, 0)))
      .orderBy(desc(mediaItems.duelScore), desc(mediaItems.duelCount), asc(mediaItems.id))
      .limit(limit);

    const [totals] = await db
      .select({
        ranked: sql<number>`count(*) filter (where ${mediaItems.duelCount} >= ${MIN_DUELS_FOR_RATING})::int`,
        compared: sql<number>`count(*)::int`,
      })
      .from(mediaItems)
      .where(and(eligibleVideos(), gt(mediaItems.duelCount, 0)));
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(duels);

    const items = (await withPerformers(rows)).map((row, i) => ({ ...row, rank: i + 1 }));
    return {
      items,
      totalDuels: total,
      comparedCount: totals?.compared ?? 0,
      rankedCount: totals?.ranked ?? 0,
      minDuels: MIN_DUELS_FOR_RATING,
      canApply: (totals?.ranked ?? 0) >= MIN_RANKED_FOR_RATING,
    };
  });

  /**
   * Turns the ranking into 1–5 stars, a fifth of the ranked videos per star.
   *
   * Only videos with enough duels take part; a score from one comparison is
   * mostly noise. Existing ratings are kept unless `overwrite` is set.
   */
  app.post<{ Body: { overwrite?: boolean } }>("/api/duels/apply-ratings", async (request, reply) => {
    const overwrite = request.body?.overwrite === true;

    const ranked = await db
      .select({ id: mediaItems.id, rating: mediaItems.rating })
      .from(mediaItems)
      .where(and(eligibleVideos(), gte(mediaItems.duelCount, MIN_DUELS_FOR_RATING)))
      .orderBy(desc(mediaItems.duelScore), asc(mediaItems.id));

    if (ranked.length < MIN_RANKED_FOR_RATING) {
      reply.code(400);
      return {
        error: `Rank at least ${MIN_RANKED_FOR_RATING} videos with ${MIN_DUELS_FOR_RATING}+ duels each first`,
      };
    }

    const byStars = new Map<number, number[]>();
    ranked.forEach((row, index) => {
      if (!overwrite && row.rating !== null) return;
      const stars = 5 - Math.floor((index * 5) / ranked.length);
      const ids = byStars.get(stars) ?? [];
      ids.push(row.id);
      byStars.set(stars, ids);
    });

    let updated = 0;
    for (const [stars, ids] of byStars) {
      await db
        .update(mediaItems)
        .set({ rating: stars, updatedAt: new Date() })
        .where(inArray(mediaItems.id, ids));
      updated += ids.length;
    }

    if (updated > 0) {
      await logActivity("edit", `Applied duel ranking to ${updated} star ratings`, {
        updated,
        overwrite,
      });
    }
    return { ok: true, updated, ranked: ranked.length };
  });
}
