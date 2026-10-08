import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { mediaItemTags, mediaItems, tags } from "../db/schema.js";
import { logActivity } from "../activity/log.js";

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tags", async () => {
    const rows = await db.select().from(tags).orderBy(tags.name);
    return { tags: rows };
  });

  // Replaces the full tag set for an item in one call (rather than separate
  // add/remove endpoints) — matches how a tag editor UI naturally works: you
  // edit the whole list, then save. Unknown tag names are created on the fly.
  app.put<{ Params: { id: string }; Body: { tagNames: string[] } }>(
    "/api/media-items/:id/tags",
    async (request, reply) => {
      const itemId = Number(request.params.id);
      const tagNames = [...new Set(request.body.tagNames.map((n) => n.trim()).filter(Boolean))];

      const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId));
      if (!item) {
        reply.code(404);
        return { error: "Not found" };
      }

      const tagIds: number[] = [];
      for (const name of tagNames) {
        const [existing] = await db.select().from(tags).where(eq(tags.name, name));
        if (existing) {
          tagIds.push(existing.id);
        } else {
          const [created] = await db.insert(tags).values({ name }).returning();
          tagIds.push(created.id);
        }
      }

      await db.delete(mediaItemTags).where(eq(mediaItemTags.mediaItemId, itemId));
      if (tagIds.length > 0) {
        await db
          .insert(mediaItemTags)
          .values(tagIds.map((tagId) => ({ mediaItemId: itemId, tagId })));
      }

      const assigned = tagIds.length > 0 ? await db.select().from(tags).where(inArray(tags.id, tagIds)) : [];

      await logActivity(
        "tag",
        `Tags on "${item.title}" set to ${tagNames.length > 0 ? tagNames.join(", ") : "(none)"}`,
        { tagNames },
        itemId,
      );

      return { tags: assigned };
    }
  );
}
