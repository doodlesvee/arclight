import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  mediaItems,
  mediaItemPerformers,
  mediaItemTags,
  mediaItemTypes,
  performers,
  playbackStates,
  studios,
  tags,
} from "../db/schema.js";
import { visibleItems } from "../library/visibility.js";

export async function inboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/inbox/count", async () => {
    const videoTypeIds = db
      .select({ id: mediaItemTypes.id })
      .from(mediaItemTypes)
      .where(eq(mediaItemTypes.name, "video"));

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(
        and(visibleItems(), inArray(mediaItems.itemTypeId, videoTypeIds), isNull(mediaItems.triagedAt)),
      );
    return { count: row?.count ?? 0 };
  });

  app.get<{ Querystring: { page?: string } }>("/api/inbox", async (request) => {
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = 50;

    const videoTypeIds = db
      .select({ id: mediaItemTypes.id })
      .from(mediaItemTypes)
      .where(eq(mediaItemTypes.name, "video"));

    const items = await db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        thumbnailFile: mediaItems.thumbnailFile,
        thumbnailPositionX: mediaItems.thumbnailPositionX,
        thumbnailPositionY: mediaItems.thumbnailPositionY,
        thumbnailScale: mediaItems.thumbnailScale,
        durationSeconds: mediaItems.durationSeconds,
        releaseDate: mediaItems.releaseDate,
        itemType: sql<string>`'video'`,
        studioId: mediaItems.studioId,
        studioName: studios.name,
        rating: mediaItems.rating,
        isFavorite: mediaItems.isFavorite,
        createdAt: mediaItems.createdAt,
      })
      .from(mediaItems)
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .where(
        and(visibleItems(), inArray(mediaItems.itemTypeId, videoTypeIds), isNull(mediaItems.triagedAt)),
      )
      .orderBy(desc(mediaItems.createdAt), desc(mediaItems.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const itemIds = items.map((i) => i.id);
    const itemPerformers =
      itemIds.length === 0
        ? []
        : await db
            .select({
              mediaItemId: mediaItemPerformers.mediaItemId,
              performerId: performers.id,
              performerName: performers.name,
            })
            .from(mediaItemPerformers)
            .innerJoin(performers, eq(performers.id, mediaItemPerformers.performerId))
            .where(inArray(mediaItemPerformers.mediaItemId, itemIds));

    const itemTags =
      itemIds.length === 0
        ? []
        : await db
            .select({
              mediaItemId: mediaItemTags.mediaItemId,
              tagId: tags.id,
              tagName: tags.name,
            })
            .from(mediaItemTags)
            .innerJoin(tags, eq(tags.id, mediaItemTags.tagId))
            .where(inArray(mediaItemTags.mediaItemId, itemIds));

    const enriched = items.map((item) => ({
      ...item,
      performers: itemPerformers
        .filter((p) => p.mediaItemId === item.id)
        .map((p) => ({ id: p.performerId, name: p.performerName })),
      tags: itemTags
        .filter((t) => t.mediaItemId === item.id)
        .map((t) => ({ id: t.tagId, name: t.tagName })),
    }));

    return { items: enriched, page, pageSize, hasMore: items.length === pageSize };
  });

  app.post<{ Body: { ids: number[] } }>("/api/inbox/triage", async (request, reply) => {
    const { ids } = request.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      reply.code(400);
      return { error: "ids must be a non-empty array" };
    }

    await db
      .update(mediaItems)
      .set({ triagedAt: new Date() })
      .where(inArray(mediaItems.id, ids.slice(0, 500)));

    return { ok: true, count: Math.min(ids.length, 500) };
  });

  app.post("/api/inbox/triage-all", async () => {
    const videoTypeIds = db
      .select({ id: mediaItemTypes.id })
      .from(mediaItemTypes)
      .where(eq(mediaItemTypes.name, "video"));

    const result = await db
      .update(mediaItems)
      .set({ triagedAt: new Date() })
      .where(
        and(visibleItems(), inArray(mediaItems.itemTypeId, videoTypeIds), isNull(mediaItems.triagedAt)),
      )
      .returning({ id: mediaItems.id });

    return { ok: true, count: result.length };
  });
}
