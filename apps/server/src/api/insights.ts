import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  bookmarks,
  mediaItemPerformers,
  mediaItems,
  mediaItemTypes,
  performers,
  playbackStates,
  studios,
  watchLog,
} from "../db/schema.js";

/**
 * Everything the Stats page works from, in one read.
 *
 * The calendar, streaks, recap, hall of fame and achievements are all
 * different views of the same few facts — when you watched, what, and how
 * much of each performer and studio you've finished — so the server hands
 * over those facts and the page does the arithmetic. Grouping by day, week
 * or month has to happen in the viewer's own time zone anyway, which only
 * the browser knows.
 */
export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/insights", async () => {
    const videoTypeIds = db
      .select({ id: mediaItemTypes.id })
      .from(mediaItemTypes)
      .where(eq(mediaItemTypes.name, "video"));
    const visibleVideo = and(
      eq(mediaItems.inScope, true),
      isNull(mediaItems.missingSince),
      inArray(mediaItems.itemTypeId, videoTypeIds)
    );

    const log = await db
      .select({
        mediaItemId: watchLog.mediaItemId,
        hour: watchLog.hour,
        seconds: watchLog.seconds,
      })
      .from(watchLog)
      .orderBy(watchLog.hour);

    // Every video with any history worth showing: in the log, finished,
    // played, or rated.
    const loggedIds = [...new Set(log.map((row) => row.mediaItemId))];
    const items = await db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        thumbnailFile: mediaItems.thumbnailFile,
        durationSeconds: mediaItems.durationSeconds,
        rating: mediaItems.rating,
        studio: studios.name,
        playCount: sql<number>`coalesce(${playbackStates.playCount}, 0)::int`,
        completedAt: playbackStates.completedAt,
      })
      .from(mediaItems)
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id))
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .where(
        and(
          inArray(mediaItems.itemTypeId, videoTypeIds),
          or(
            loggedIds.length > 0 ? inArray(mediaItems.id, loggedIds) : undefined,
            isNotNull(playbackStates.completedAt),
            sql`${playbackStates.playCount} > 0`,
            isNotNull(mediaItems.rating)
          )
        )
      );

    const itemIds = items.map((item) => item.id);
    const credits =
      itemIds.length === 0
        ? []
        : await db
            .select({
              mediaItemId: mediaItemPerformers.mediaItemId,
              performerId: mediaItemPerformers.performerId,
            })
            .from(mediaItemPerformers)
            .where(inArray(mediaItemPerformers.mediaItemId, itemIds));
    const performersByItem = new Map<number, number[]>();
    for (const credit of credits) {
      const list = performersByItem.get(credit.mediaItemId) ?? [];
      list.push(credit.performerId);
      performersByItem.set(credit.mediaItemId, list);
    }

    // Per performer and per studio: how many videos there are, and how many
    // you've finished — the "watched every video of…" badges need both.
    const performerRows = await db
      .select({
        id: performers.id,
        name: performers.name,
        hasImage: sql<boolean>`(${performers.imageFile} is not null)`,
        hasBanner: sql<boolean>`(${performers.bannerFile} is not null)`,
        imagePositionX: performers.imagePositionX,
        imagePositionY: performers.imagePositionY,
        imageScale: performers.imageScale,
        avatarPositionX: performers.avatarPositionX,
        avatarPositionY: performers.avatarPositionY,
        avatarScale: performers.avatarScale,
        representativeItemId: sql<number | null>`max(${mediaItems.id})`,
        videoCount: sql<number>`count(*)::int`,
        finishedCount: sql<number>`count(${playbackStates.completedAt})::int`,
      })
      .from(performers)
      .innerJoin(mediaItemPerformers, eq(mediaItemPerformers.performerId, performers.id))
      .innerJoin(mediaItems, and(eq(mediaItems.id, mediaItemPerformers.mediaItemId), visibleVideo))
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id))
      .groupBy(performers.id);

    const studioRows = await db
      .select({
        name: studios.name,
        videoCount: sql<number>`count(*)::int`,
        finishedCount: sql<number>`count(${playbackStates.completedAt})::int`,
      })
      .from(mediaItems)
      .innerJoin(studios, eq(studios.id, mediaItems.studioId))
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id))
      .where(visibleVideo)
      .groupBy(studios.name);

    const [{ bookmarkCount }] = await db
      .select({ bookmarkCount: sql<number>`count(*)::int` })
      .from(bookmarks);

    return {
      log: log.map((row) => ({ ...row, hour: row.hour.toISOString() })),
      items: items.map((item) => ({
        ...item,
        completedAt: item.completedAt?.toISOString() ?? null,
        performerIds: performersByItem.get(item.id) ?? [],
      })),
      performers: performerRows,
      studios: studioRows,
      bookmarkCount,
    };
  });
}
