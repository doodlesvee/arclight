import { eq } from "drizzle-orm";
import { type FastifyInstance } from "fastify";
import { logActivity } from "../activity/log.js";
import { isVaultUnlocked, vaultPinConfigured } from "../auth/vaultUnlock.js";
import { db } from "../db/client.js";
import { mediaItems } from "../db/schema.js";
import { categorySlugs, clampPercent, ensureStudioId } from "./mediaItemQueries.js";

export async function mediaItemEditRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{
    Params: { id: string };
    Body: {
      parentId?: number | null;
      title?: string;
      description?: string | null;
      isFavorite?: boolean;
      kind?: string;
      studio?: string | null;
      thumbnailPositionX?: number;
      thumbnailPositionY?: number;
      thumbnailScale?: number;
      /** 'landscape' | 'portrait', or null to follow the Appearance setting. */
      tileShape?: string | null;
      /** 1–5 stars, or null to clear. */
      rating?: number | null;
      seriesId?: number | null;
      seasonNumber?: number | null;
      episodeNumber?: number | null;
      episodeTitle?: string | null;
    };
  }>("/api/media-items/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const {
      parentId,
      title,
      description,
      isFavorite,
      kind,
      studio,
      thumbnailPositionX,
      thumbnailPositionY,
      thumbnailScale,
      tileShape,
      rating,
      seriesId,
      seasonNumber,
      episodeNumber,
      episodeTitle,
    } = request.body;

    if (parentId === id) {
      reply.code(400);
      return { error: "An item cannot be its own parent" };
    }
    if (title !== undefined && !title.trim()) {
      reply.code(400);
      return { error: "title cannot be empty" };
    }

    const patch: Partial<typeof mediaItems.$inferInsert> = { updatedAt: new Date() };
    if (parentId !== undefined) patch.parentId = parentId;
    if (title !== undefined) {
      patch.title = title.trim();
      // From here on the scanner leaves this title alone, even across renames.
      patch.titleSource = "user";
    }
    if (description !== undefined) patch.description = description;
    if (isFavorite !== undefined) patch.isFavorite = isFavorite;
    if (kind !== undefined) {
      // Checked against the categories table, so a category you created is
      // assignable — the old constant rejected everything but the three
      // seeded slugs, which meant the modal's own dropdown offered options
      // the save then refused.
      if (!(await categorySlugs()).has(kind)) {
        reply.code(400);
        return { error: "Unknown category" };
      }
      patch.kind = kind;
    }
    // Clamped rather than rejected: these come from a drag and a slider, so a
    // value a fraction outside the range is a rounding artefact, not a reason
    // to fail the save. Matches how the category cover framing is handled.
    if (thumbnailPositionX !== undefined) {
      patch.thumbnailPositionX = clampPercent(thumbnailPositionX, 0, 100);
    }
    if (thumbnailPositionY !== undefined) {
      patch.thumbnailPositionY = clampPercent(thumbnailPositionY, 0, 100);
    }
    // Floor of 100: below it the image stops covering its frame and shows
    // bars. Ceiling keeps a poster from being magnified into mush.
    if (thumbnailScale !== undefined) {
      patch.thumbnailScale = clampPercent(thumbnailScale, 100, 300);
    }
    // Rejected rather than clamped, unlike the framing above: those arrive
    // from a drag and a slider where a value just outside the range is a
    // rounding artefact, but this comes from a menu with two entries. A third
    // value is a bug or a hand-built request, and silently coercing it to
    // 'landscape' would hide which.
    //
    // null is a real value here — "follow the Appearance setting" — so it has
    // to pass through rather than being treated as "not supplied".
    if (tileShape !== undefined) {
      if (tileShape !== null && tileShape !== "landscape" && tileShape !== "portrait") {
        reply.code(400);
        return { error: "tileShape must be 'landscape', 'portrait', or null" };
      }
      patch.tileShape = tileShape;
    }
    // Rejected rather than clamped, for the same reason as tileShape: stars
    // come from five buttons, so 0 or 3.5 is a bug worth surfacing.
    if (rating !== undefined) {
      if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
        reply.code(400);
        return { error: "rating must be a whole number from 1 to 5, or null" };
      }
      patch.rating = rating;
    }
    if (studio !== undefined) {
      const name = studio?.trim();
      patch.studioId = name ? await ensureStudioId(name) : null;
      // From here the filename brackets stop deciding this item's studio.
      patch.studioSource = "user";
    }
    if (seriesId !== undefined) patch.seriesId = seriesId;
    if (seasonNumber !== undefined) patch.seasonNumber = seasonNumber;
    if (episodeNumber !== undefined) patch.episodeNumber = episodeNumber;
    if (episodeTitle !== undefined) patch.episodeTitle = episodeTitle?.trim() || null;

    const updated = await db
      .update(mediaItems)
      .set(patch)
      .where(eq(mediaItems.id, id))
      .returning();

    if (updated.length === 0) {
      reply.code(404);
      return { error: "Not found" };
    }

    const changes: string[] = [];
    if (title !== undefined) changes.push(`title → "${title}"`);
    if (rating !== undefined) changes.push(rating ? `rated ${rating}★` : "rating cleared");
    if (isFavorite !== undefined) changes.push(isFavorite ? "favorited" : "unfavorited");
    if (studio !== undefined) changes.push(studio ? `studio → "${studio}"` : "studio cleared");
    if (description !== undefined) changes.push("description updated");
    if (changes.length > 0) {
      const itemTitle = updated[0].title;
      await logActivity(
        "edit",
        `Edited "${itemTitle}": ${changes.join(", ")}`,
        { fields: changes },
        id,
      );
    }

    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { hidden: boolean } }>(
    "/api/media-items/:id/hidden",
    async (request, reply) => {
      const id = Number(request.params.id);
      const { hidden } = request.body;

      if (typeof hidden !== "boolean") {
        reply.code(400);
        return { error: "hidden must be a boolean" };
      }

      // Bringing something back out of the vault is what the PIN protects.
      if (!hidden && (await vaultPinConfigured()) && !isVaultUnlocked(request.user?.sessionId)) {
        reply.code(403);
        return { error: "Unlock the vault to restore hidden items" };
      }

      const updated = await db
        .update(mediaItems)
        .set({ hiddenAt: hidden ? new Date() : null })
        .where(eq(mediaItems.id, id))
        .returning({ id: mediaItems.id, title: mediaItems.title });

      if (updated.length === 0) {
        reply.code(404);
        return { error: "Not found" };
      }

      await logActivity(
        "hide",
        hidden ? `Hidden "${updated[0].title}"` : `Unhidden "${updated[0].title}"`,
        { hidden },
        id,
      );

      return { ok: true, hidden };
    }
  );
}
