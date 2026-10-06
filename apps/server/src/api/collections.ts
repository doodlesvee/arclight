import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import { visibleItems } from "../library/visibility.js";
import type { FastifyInstance } from "fastify";
import { compileSmartRule, smartRuleError, type SmartRule } from "../collections/ruleCompiler.js";
import { db } from "../db/client.js";
import { collectionItems, collections, mediaItemTypes, mediaItems } from "../db/schema.js";
import { playbackWarningFor } from "../media/compatibility.js";

const PAGE_SIZE = 50;

const itemColumns = {
  id: mediaItems.id,
  itemType: mediaItemTypes.name,
  title: mediaItems.title,
  durationSeconds: mediaItems.durationSeconds,
  extraMetadata: mediaItems.extraMetadata,
  missingSince: mediaItems.missingSince,
  createdAt: mediaItems.createdAt,
};

function withPlaybackWarning<T extends { itemType: string; extraMetadata: unknown }>(item: T) {
  return {
    ...item,
    playbackWarning: playbackWarningFor(
      item.itemType,
      item.extraMetadata as Record<string, unknown> | null
    ),
  };
}

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/collections", async () => {
    const rows = await db.select().from(collections).orderBy(collections.name);
    return { collections: rows };
  });

  app.post<{
    Body: { name: string; description?: string; type: "manual" | "smart"; smartRule?: SmartRule };
  }>("/api/collections", async (request, reply) => {
    const { name, description, type, smartRule } = request.body;

    if (type === "smart" && !smartRule) {
      reply.code(400);
      return { error: "smartRule is required for a smart collection" };
    }
    const ruleError = type === "smart" ? smartRuleError(smartRule) : null;
    if (ruleError) {
      reply.code(400);
      return { error: ruleError };
    }

    const [collection] = await db
      .insert(collections)
      .values({
        name,
        description: description ?? null,
        type,
        smartRule: type === "smart" ? smartRule : null,
      })
      .returning();

    reply.code(201);
    return collection;
  });

  app.delete<{ Params: { id: string } }>("/api/collections/:id", async (request, reply) => {
    const id = Number(request.params.id);

    // Membership rows first: collection_items has a foreign key to
    // collections, so the parent cannot be removed while they exist.
    //
    // Every row, not just the in-scope ones. This previously filtered on
    // `mediaItems.inScope` while deleting from collection_items alone — a
    // table the statement never joins — so Postgres rejected it outright
    // ("missing FROM-clause entry") and deleting a collection did nothing at
    // all. Scope is a display concern anyway; a hidden item's membership
    // still has to go when its collection does.
    await db.delete(collectionItems).where(eq(collectionItems.collectionId, id));

    const deleted = await db.delete(collections).where(eq(collections.id, id)).returning();
    if (deleted.length === 0) {
      reply.code(404);
      return { error: "Not found" };
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>(
    "/api/collections/:id/items",
    async (request, reply) => {
      const id = Number(request.params.id);
      const pageNum = Math.max(1, Number(request.query.page) || 1);

      const [collection] = await db.select().from(collections).where(eq(collections.id, id));
      if (!collection) {
        reply.code(404);
        return { error: "Not found" };
      }

      const baseQuery = db
        .select(itemColumns)
        .from(mediaItems)
        .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id));

      const defaultOrder = [desc(mediaItems.createdAt), desc(mediaItems.id)];

      let rows;
      if (collection.type === "manual") {
        rows = await baseQuery
          .innerJoin(collectionItems, eq(collectionItems.mediaItemId, mediaItems.id))
          .where(and(eq(collectionItems.collectionId, id), visibleItems()))
          .orderBy(asc(collectionItems.position), ...defaultOrder)
          .limit(PAGE_SIZE + 1)
          .offset((pageNum - 1) * PAGE_SIZE);
      } else {
        const rule = collection.smartRule as SmartRule;
        rows = await baseQuery
          .where(and(compileSmartRule(rule), visibleItems()))
          .orderBy(...defaultOrder)
          .limit(PAGE_SIZE + 1)
          .offset((pageNum - 1) * PAGE_SIZE);
      }

      const hasMore = rows.length > PAGE_SIZE;
      const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

      return {
        items: pageRows.map(withPlaybackWarning),
        page: pageNum,
        pageSize: PAGE_SIZE,
        hasMore,
      };
    }
  );

  app.post<{ Params: { id: string }; Body: { mediaItemId: number } }>(
    "/api/collections/:id/items",
    async (request, reply) => {
      const collectionId = Number(request.params.id);
      const { mediaItemId } = request.body;

      const [collection] = await db
        .select()
        .from(collections)
        .where(eq(collections.id, collectionId));
      if (!collection) {
        reply.code(404);
        return { error: "Not found" };
      }
      if (collection.type !== "manual") {
        reply.code(400);
        return { error: "Cannot manually add items to a smart collection" };
      }

      const [{ nextPos }] = await db
        .select({ nextPos: sql<number>`coalesce(max(${collectionItems.position}), 0) + 1` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionId, collectionId));

      await db
        .insert(collectionItems)
        .values({ collectionId, mediaItemId, position: nextPos })
        .onConflictDoNothing();

      reply.code(201);
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string; mediaItemId: string } }>(
    "/api/collections/:id/items/:mediaItemId",
    async (request) => {
      await db
        .delete(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, Number(request.params.id)),
            eq(collectionItems.mediaItemId, Number(request.params.mediaItemId))
          )
        );
      return { ok: true };
    }
  );

  app.put<{ Params: { id: string }; Body: { orderedIds: number[] } }>(
    "/api/collections/:id/items/reorder",
    async (request, reply) => {
      const collectionId = Number(request.params.id);
      const { orderedIds } = request.body;

      const [collection] = await db
        .select()
        .from(collections)
        .where(eq(collections.id, collectionId));
      if (!collection) {
        reply.code(404);
        return { error: "Not found" };
      }
      if (collection.type !== "manual") {
        reply.code(400);
        return { error: "Cannot reorder a smart collection" };
      }

      await db.transaction(async (tx) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await tx
            .update(collectionItems)
            .set({ position: i })
            .where(
              and(
                eq(collectionItems.collectionId, collectionId),
                eq(collectionItems.mediaItemId, orderedIds[i]),
              ),
            );
        }
      });

      return { ok: true };
    }
  );
}
