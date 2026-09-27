import { aliasedTable, and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  mediaItemPerformers,
  mediaItems,
  mediaItemTypes,
  performers,
  playbackStates,
  studios,
} from "../db/schema.js";
import { affinityEdges } from "../library/affinity.js";

// The co-performer query joins media_item_performers and performers to
// themselves — once for the performer whose page this is, once for everyone
// else on the same video. Without aliases both sides resolve to the same
// table and the join condition is meaningless.
const otherCredits = aliasedTable(mediaItemPerformers, "other_credits");
const coPerformer = aliasedTable(performers, "co_performer");
import {
  deletePerformerImage,
  performerImagePath,
  savePerformerImage,
  type PerformerImageKind,
} from "../media/performerImages.js";
import { streamFile } from "../media/streamer.js";
import { normalizeName } from "../scanner/performerNames.js";

/**
 * Resolves a name to a performer id, creating the row when it's new.
 * Mirrors the scanner's helper: conflict-tolerant insert then re-select, so
 * two concurrent saves of the same new name can't raise a unique violation.
 */
async function ensurePerformerId(rawName: string): Promise<number> {
  const name = normalizeName(rawName);

  const findId = async (): Promise<number | null> => {
    const [row] = await db
      .select({ id: performers.id })
      .from(performers)
      .where(sql`lower(${performers.name}) = lower(${name})`);
    return row?.id ?? null;
  };

  const existing = await findId();
  if (existing !== null) return existing;

  const [created] = await db
    .insert(performers)
    .values({ name })
    .onConflictDoNothing()
    .returning();
  if (created) return created.id;

  const raced = await findId();
  if (raced === null) throw new Error(`Could not resolve performer "${name}"`);
  return raced;
}

/** Collapses case-only and whitespace-only duplicates within one request. */
function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export async function performerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/performers", async () => {
    const videoTypeIds = db
      .select({ id: mediaItemTypes.id })
      .from(mediaItemTypes)
      .where(eq(mediaItemTypes.name, "video"));

    const rows = await db
      .select({
        id: performers.id,
        name: performers.name,
        isFavorite: performers.isFavorite,
        hasImage: sql<boolean>`(${performers.imageFile} is not null)`,
        hasBanner: sql<boolean>`(${performers.bannerFile} is not null)`,
        imagePositionX: performers.imagePositionX,
        imagePositionY: performers.imagePositionY,
        imageScale: performers.imageScale,
        avatarPositionX: performers.avatarPositionX,
        avatarPositionY: performers.avatarPositionY,
        avatarScale: performers.avatarScale,
        // count(<column>) rather than count(*): on a LEFT JOIN with no match,
        // count(*) counts the NULL-padded row and reports 1.
        videoCount: sql<number>`count(${mediaItems.id})::int`,
        representativeItemId: sql<number | null>`max(${mediaItems.id})`,
      })
      .from(performers)
      .leftJoin(mediaItemPerformers, eq(mediaItemPerformers.performerId, performers.id))
      // These predicates belong in the join condition, not a WHERE — in a
      // WHERE they would drop performers with no videos entirely, and a
      // zero-video performer is a valid state we rely on (you create one by
      // hand so the scanner's filename pass can match it next scan).
      .leftJoin(
        mediaItems,
        and(
          eq(mediaItems.id, mediaItemPerformers.mediaItemId),
          eq(mediaItems.inScope, true),
          isNull(mediaItems.missingSince),
          inArray(mediaItems.itemTypeId, videoTypeIds)
        )
      )
      .groupBy(
        performers.id,
        performers.name,
        performers.isFavorite,
        performers.imageFile,
        performers.bannerFile
      )
      // Favourites first, then alphabetically within each group. Plain name
      // ordering is ASCII, which sorts "Zoe" before "alice".
      .orderBy(desc(performers.isFavorite), sql`lower(${performers.name})`);

    return { performers: rows };
  });

  // The whole library as a graph: every performer with at least one video,
  // and one edge per connected pair. `by` picks what connects them — videos
  // they appear in together (the default), or studios they have in
  // common, which link people who have never shared a scene. Built from flat
  // queries stitched together here, rather than one query with nested
  // aggregates, so each stays a plain GROUP BY.
  app.get<{ Querystring: { by?: string } }>(
    "/api/performers/network",
    async (request) => {
      const by = request.query.by === "studios" ? "studios" : "videos";
      const videoTypeIds = db
        .select({ id: mediaItemTypes.id })
        .from(mediaItemTypes)
        .where(eq(mediaItemTypes.name, "video"));

      const visibleVideoItem = and(
        eq(mediaItems.inScope, true),
        isNull(mediaItems.missingSince),
        inArray(mediaItems.itemTypeId, videoTypeIds)
      );
      const visibleVideo = and(
        eq(mediaItems.id, mediaItemPerformers.mediaItemId),
        visibleVideoItem
      );

      // Inner joins this time: a performer with no videos has nothing to be
      // connected by, so there is no node to draw for them.
      const nodes = await db
        .select({
          id: performers.id,
          name: performers.name,
          isFavorite: performers.isFavorite,
          hasImage: sql<boolean>`(${performers.imageFile} is not null)`,
          hasBanner: sql<boolean>`(${performers.bannerFile} is not null)`,
          imagePositionX: performers.imagePositionX,
          imagePositionY: performers.imagePositionY,
          imageScale: performers.imageScale,
          avatarPositionX: performers.avatarPositionX,
          avatarPositionY: performers.avatarPositionY,
          avatarScale: performers.avatarScale,
          videoCount: sql<number>`count(*)::int`,
          representativeItemId: sql<number | null>`max(${mediaItems.id})`,
          // For the graph's highlights and hover cards.
          studioCount: sql<number>`count(distinct ${mediaItems.studioId})::int`,
          // Finished videos count their full length once per play; one in
          // progress counts as far as you got.
          watchedSeconds: sql<number>`coalesce(sum(case
            when ${playbackStates.playCount} > 0
              then coalesce(${mediaItems.durationSeconds}, 0) * ${playbackStates.playCount}
            else coalesce(${playbackStates.positionSeconds}, 0)
          end), 0)::int`,
          averageRating: sql<number | null>`round(avg(${mediaItems.rating}), 1)::float`,
        })
        .from(performers)
        .innerJoin(mediaItemPerformers, eq(mediaItemPerformers.performerId, performers.id))
        .innerJoin(mediaItems, visibleVideo)
        .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id))
        .groupBy(performers.id)
        .orderBy(sql`lower(${performers.name})`);

      // `performer_id < other` counts each pair once, not once from each end.
      const videoEdges = async () => db
        .select({
          source: mediaItemPerformers.performerId,
          target: otherCredits.performerId,
          together: sql<number>`count(*)::int`,
        })
        .from(mediaItemPerformers)
        .innerJoin(mediaItems, visibleVideo)
        .innerJoin(
          otherCredits,
          and(
            eq(otherCredits.mediaItemId, mediaItemPerformers.mediaItemId),
            sql`${otherCredits.performerId} > ${mediaItemPerformers.performerId}`
          )
        )
        .groupBy(mediaItemPerformers.performerId, otherCredits.performerId);

      // Distinct (performer, studio) pairs across their visible videos.
      const studioEdges = async () =>
        affinityEdges(
          await db
            .selectDistinct({
              performerId: mediaItemPerformers.performerId,
              key: studios.id,
              label: studios.name,
            })
            .from(mediaItemPerformers)
            .innerJoin(mediaItems, visibleVideo)
            .innerJoin(studios, eq(studios.id, mediaItems.studioId))
        );

      const edges =
        by === "studios" ? await studioEdges() : await videoEdges();

      // Each performer's most frequent studio, which the graph colours them by
      // so studio clusters are visible at a glance. Ties go to the name first
      // alphabetically, so the colour doesn't flicker between loads.
      const studioCounts = await db
        .select({
          performerId: mediaItemPerformers.performerId,
          studioId: studios.id,
          studio: studios.name,
          count: sql<number>`count(*)::int`,
        })
        .from(mediaItemPerformers)
        .innerJoin(mediaItems, visibleVideo)
        .innerJoin(studios, eq(studios.id, mediaItems.studioId))
        .groupBy(mediaItemPerformers.performerId, studios.id, studios.name)
        .orderBy(desc(sql`count(*)`), sql`lower(${studios.name})`);

      const topStudio = new Map<number, string>();
      for (const row of studioCounts) {
        if (!topStudio.has(row.performerId)) topStudio.set(row.performerId, row.studio);
      }

      // In studio mode the graph can draw the studios themselves, each linked
      // to the performers who have worked for it — the same rows as above,
      // plus each studio's own size for the circle.
      const studioGraph =
        by === "studios"
          ? {
              studios: await db
                .select({
                  id: studios.id,
                  name: studios.name,
                  videoCount: sql<number>`count(*)::int`,
                })
                .from(mediaItems)
                .innerJoin(studios, eq(studios.id, mediaItems.studioId))
                .where(visibleVideoItem)
                .groupBy(studios.id, studios.name)
                .orderBy(sql`lower(${studios.name})`),
              memberships: studioCounts.map((row) => ({
                performerId: row.performerId,
                studioId: row.studioId,
                videos: row.count,
              })),
            }
          : {};

      return {
        by,
        nodes: nodes.map((node) => ({ ...node, topStudio: topStudio.get(node.id) ?? null })),
        edges,
        ...studioGraph,
      };
    }
  );

  // Backs the profile page: the performer plus enough aggregate to render the
  // header without a second round trip.
  app.get<{ Params: { id: string } }>("/api/performers/:id", async (request, reply) => {
    const id = Number(request.params.id);

    const [performer] = await db.select().from(performers).where(eq(performers.id, id));
    if (!performer) {
      reply.code(404);
      return { error: "Not found" };
    }

    const videoTypeIds = db
      .select({ id: mediaItemTypes.id })
      .from(mediaItemTypes)
      .where(eq(mediaItemTypes.name, "video"));

    const [totals] = await db
      .select({
        videoCount: sql<number>`count(*)::int`,
        totalDurationSeconds: sql<number>`coalesce(sum(${mediaItems.durationSeconds}), 0)::int`,
      })
      .from(mediaItemPerformers)
      .innerJoin(
        mediaItems,
        and(
          eq(mediaItems.id, mediaItemPerformers.mediaItemId),
          eq(mediaItems.inScope, true),
          isNull(mediaItems.missingSince),
          inArray(mediaItems.itemTypeId, videoTypeIds)
        )
      )
      .where(eq(mediaItemPerformers.performerId, id));

    // The performer's videos, as one reusable join condition. Every aggregate
    // below counts exactly the same set the profile grid will show, so the
    // section counts can't disagree with what's rendered.
    const performerVideos = and(
      eq(mediaItems.id, mediaItemPerformers.mediaItemId),
      eq(mediaItems.inScope, true),
      isNull(mediaItems.missingSince),
      inArray(mediaItems.itemTypeId, videoTypeIds)
    );

    // `name` is nullable here on purpose — a LEFT JOIN leaves it null for
    // videos with no studio, and that bucket has to exist or those videos
    // vanish from a grouped view.
    const studioBreakdown = await db
      .select({ name: studios.name, count: sql<number>`count(*)::int` })
      .from(mediaItemPerformers)
      .innerJoin(mediaItems, performerVideos)
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .where(eq(mediaItemPerformers.performerId, id))
      .groupBy(studios.name)
      // Alphabetical, matching GET /api/studios — ordering by count meant the
      // sections reshuffled as the library grew, so a studio was never in the
      // same place twice. "No studio" sorts last: it isn't a name.
      .orderBy(sql`lower(${studios.name}) asc nulls last`);

    const yearBreakdown = await db
      .select({
        year: sql<number | null>`extract(year from ${mediaItems.releaseDate})::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(mediaItemPerformers)
      .innerJoin(mediaItems, performerVideos)
      .where(eq(mediaItemPerformers.performerId, id))
      .groupBy(sql`extract(year from ${mediaItems.releaseDate})`)
      .orderBy(desc(sql`extract(year from ${mediaItems.releaseDate})`));

    const [watch] = await db
      .select({
        watched: sql<number>`count(*) filter (where ${playbackStates.completedAt} is not null)::int`,
        inProgress: sql<number>`count(*) filter (
          where ${playbackStates.positionSeconds} > 15 and ${playbackStates.completedAt} is null
        )::int`,
        unwatched: sql<number>`count(*) filter (where ${playbackStates.id} is null)::int`,
      })
      .from(mediaItemPerformers)
      .innerJoin(mediaItems, performerVideos)
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id))
      .where(eq(mediaItemPerformers.performerId, id));

    // Self-join on the join table: anyone credited on a video this performer
    // is also on. Aggregated with GROUP BY rather than a correlated subquery
    // in the select list — drizzle renders `performers.id` unqualified when
    // the outer query has one table, which is ambiguous inside a subquery and
    // fails outright. That exact mistake broke search suggestions before.
    const coPerformerRows = await db
      .select({
        id: coPerformer.id,
        name: coPerformer.name,
        isFavorite: coPerformer.isFavorite,
        hasImage: sql<boolean>`(${coPerformer.imageFile} is not null)`,
        hasBanner: sql<boolean>`(${coPerformer.bannerFile} is not null)`,
        imagePositionX: coPerformer.imagePositionX,
        imagePositionY: coPerformer.imagePositionY,
        imageScale: coPerformer.imageScale,
        avatarPositionX: coPerformer.avatarPositionX,
        avatarPositionY: coPerformer.avatarPositionY,
        avatarScale: coPerformer.avatarScale,
        representativeItemId: sql<number | null>`max(${mediaItems.id})`,
        together: sql<number>`count(*)::int`,
      })
      .from(mediaItemPerformers)
      .innerJoin(mediaItems, performerVideos)
      .innerJoin(
        otherCredits,
        and(
          eq(otherCredits.mediaItemId, mediaItemPerformers.mediaItemId),
          ne(otherCredits.performerId, mediaItemPerformers.performerId)
        )
      )
      .innerJoin(coPerformer, eq(coPerformer.id, otherCredits.performerId))
      .where(eq(mediaItemPerformers.performerId, id))
      .groupBy(
        coPerformer.id,
        coPerformer.name,
        coPerformer.isFavorite,
        coPerformer.imageFile,
        coPerformer.bannerFile,
        coPerformer.imagePositionX,
        coPerformer.imagePositionY,
        coPerformer.imageScale,
        coPerformer.avatarPositionX,
        coPerformer.avatarPositionY,
        coPerformer.avatarScale
      )
      .orderBy(desc(sql`count(*)`), sql`lower(${coPerformer.name})`);

    // Their own video totals, in one grouped query rather than a correlated
    // subquery per row. A subquery here rendered `from "co_performer"` — the
    // alias, not a real table — and failed outright. Aliases are only valid
    // in the query that declares them.
    const coPerformerIds = coPerformerRows.map((row) => row.id);
    const coTotals =
      coPerformerIds.length === 0
        ? []
        : await db
            .select({
              performerId: mediaItemPerformers.performerId,
              videoCount: sql<number>`count(*)::int`,
            })
            .from(mediaItemPerformers)
            .innerJoin(
              mediaItems,
              and(
                eq(mediaItems.id, mediaItemPerformers.mediaItemId),
                eq(mediaItems.inScope, true),
                isNull(mediaItems.missingSince),
                inArray(mediaItems.itemTypeId, videoTypeIds)
              )
            )
            .where(inArray(mediaItemPerformers.performerId, coPerformerIds))
            .groupBy(mediaItemPerformers.performerId);

    const totalByPerformerId = new Map(coTotals.map((r) => [r.performerId, r.videoCount]));

    // Two different frames where possible, so the blurred backdrop isn't the
    // same picture as the portrait sitting on top of it.
    const recentItems = await db
      .select({ id: mediaItems.id })
      .from(mediaItemPerformers)
      .innerJoin(
        mediaItems,
        and(
          eq(mediaItems.id, mediaItemPerformers.mediaItemId),
          eq(mediaItems.inScope, true),
          isNull(mediaItems.missingSince),
          inArray(mediaItems.itemTypeId, videoTypeIds)
        )
      )
      .where(eq(mediaItemPerformers.performerId, id))
      .orderBy(desc(mediaItems.id))
      .limit(2);

    return {
      id: performer.id,
      name: performer.name,
      hasImage: performer.imageFile !== null,
      hasBanner: performer.bannerFile !== null,
      isFavorite: performer.isFavorite,
      // Detail only, deliberately: a bio is prose, and the performers grid
      // renders every performer as a card that would carry text nothing shows.
      bio: performer.bio,
      studios: studioBreakdown,
      years: yearBreakdown,
      watch: watch ?? { watched: 0, inProgress: 0, unwatched: 0 },
      coPerformers: coPerformerRows.map((row) => ({
        ...row,
        videoCount: totalByPerformerId.get(row.id) ?? 0,
      })),
      bannerPositionY: performer.bannerPositionY,
      imagePositionX: performer.imagePositionX,
      imagePositionY: performer.imagePositionY,
      imageScale: performer.imageScale,
      avatarPositionX: performer.avatarPositionX,
      avatarPositionY: performer.avatarPositionY,
      avatarScale: performer.avatarScale,
      videoCount: totals?.videoCount ?? 0,
      totalDurationSeconds: totals?.totalDurationSeconds ?? 0,
      representativeItemId: recentItems[0]?.id ?? null,
      bannerItemId: recentItems[1]?.id ?? recentItems[0]?.id ?? null,
    };
  });

  // 404 rather than a placeholder when nothing has been uploaded — the client
  // uses the failure to fall back to a frame from one of their videos.
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/api/performers/:id/image",
    async (request, reply) => {
      const id = Number(request.params.id);
      const kind: PerformerImageKind = request.query.kind === "banner" ? "banner" : "avatar";

      const [performer] = await db.select().from(performers).where(eq(performers.id, id));
      const fileName = kind === "banner" ? performer?.bannerFile : performer?.imageFile;
      if (!performer || !fileName) {
        reply.code(404);
        return { error: "No image" };
      }

      // Safe to cache hard: the filename carries a random suffix, so a
      // replacement is served from a different URL entirely.
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      await streamFile(reply, performerImagePath(fileName), "image/jpeg", undefined, false);
    }
  );

  app.post<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/api/performers/:id/image",
    async (request, reply) => {
      const id = Number(request.params.id);
      const kind: PerformerImageKind = request.query.kind === "banner" ? "banner" : "avatar";

      const [performer] = await db.select().from(performers).where(eq(performers.id, id));
      if (!performer) {
        reply.code(404);
        return { error: "Not found" };
      }

      const upload = await request.file();
      if (!upload) {
        reply.code(400);
        return { error: "No file uploaded" };
      }

      let buffer: Buffer;
      try {
        buffer = await upload.toBuffer();
      } catch {
        // Thrown when the multipart limit is exceeded.
        reply.code(413);
        return { error: "Image is too large" };
      }

      let fileName: string;
      try {
        fileName = await savePerformerImage(buffer, id, kind);
      } catch {
        // sharp refuses anything it can't decode, which is what rejects a
        // non-image with the right extension.
        reply.code(400);
        return { error: "That file could not be read as an image" };
      }

      const previous = kind === "banner" ? performer.bannerFile : performer.imageFile;
      await db
        .update(performers)
        .set(
          kind === "banner"
            ? // Reset the framing: a position chosen for the previous picture
              // is meaningless against a new one.
              { bannerFile: fileName, bannerPositionY: 50 }
            : { imageFile: fileName }
        )
        .where(eq(performers.id, id));
      // Only after the row points at the new file, so a failure here leaves a
      // stray file rather than a broken reference.
      await deletePerformerImage(previous);

      return { ok: true, kind };
    }
  );

  app.delete<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/api/performers/:id/image",
    async (request, reply) => {
      const id = Number(request.params.id);
      const kind: PerformerImageKind = request.query.kind === "banner" ? "banner" : "avatar";

      const [performer] = await db.select().from(performers).where(eq(performers.id, id));
      if (!performer) {
        reply.code(404);
        return { error: "Not found" };
      }

      const previous = kind === "banner" ? performer.bannerFile : performer.imageFile;
      await db
        .update(performers)
        .set(kind === "banner" ? { bannerFile: null } : { imageFile: null })
        .where(eq(performers.id, id));
      await deletePerformerImage(previous);

      return { ok: true, kind };
    }
  );

  // Replaces an item's whole performer set, matching how the editor works:
  // you edit the list, then save. Unknown names are created on the fly.
  app.put<{ Params: { id: string }; Body: { performerNames: string[] } }>(
    "/api/media-items/:id/performers",
    async (request, reply) => {
      const itemId = Number(request.params.id);
      const names = dedupeNames(request.body.performerNames ?? []);

      const [item] = await db.select().from(mediaItems).where(eq(mediaItems.id, itemId));
      if (!item) {
        reply.code(404);
        return { error: "Not found" };
      }

      const performerIds = await Promise.all(names.map(ensurePerformerId));

      // Transactional because a crash between the delete and the insert would
      // lose the set *and* leave performersSource = 'user', so the scanner
      // would never restore it.
      await db.transaction(async (tx) => {
        await tx
          .delete(mediaItemPerformers)
          .where(eq(mediaItemPerformers.mediaItemId, itemId));
        if (performerIds.length > 0) {
          await tx
            .insert(mediaItemPerformers)
            .values(performerIds.map((performerId) => ({ mediaItemId: itemId, performerId })))
            .onConflictDoNothing();
        }
        // From here the folder layout no longer decides this item's
        // performers — including when the list is now deliberately empty.
        await tx
          .update(mediaItems)
          .set({ performersSource: "user", updatedAt: new Date() })
          .where(eq(mediaItems.id, itemId));
      });

      const assigned =
        performerIds.length > 0
          ? await db
              .select({ id: performers.id, name: performers.name })
              .from(performers)
              .where(inArray(performers.id, performerIds))
          : [];
      return { performers: assigned };
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      bio?: string | null;
      isFavorite?: boolean;
      bannerPositionY?: number;
      imagePositionX?: number;
      imagePositionY?: number;
      imageScale?: number;
      /** The circle's own framing; null clears it back to the tile's. */
      avatarPositionX?: number | null;
      avatarPositionY?: number | null;
      avatarScale?: number | null;
    };
  }>(
    "/api/performers/:id",
    async (request, reply) => {
      const id = Number(request.params.id);
      const {
        bio,
        isFavorite,
        bannerPositionY,
        imagePositionX,
        imagePositionY,
        imageScale,
        avatarPositionX,
        avatarPositionY,
        avatarScale,
      } = request.body;

      // Everything that can be saved on its own, without re-sending the name:
      // the drag controls and the bio editor both patch a single field.
      const partial: Partial<typeof performers.$inferInsert> = {};

      if (isFavorite !== undefined) partial.isFavorite = isFavorite;

      if (bio !== undefined) {
        const trimmed = bio?.trim();
        // Empty string stored as null, so "cleared" and "never written" are
        // one state rather than two that render identically.
        partial.bio = trimmed ? trimmed : null;
      }

      // Clamped rather than rejected — a value outside range is a client
      // rounding artefact, not something worth failing a save over.
      const clamp = (v: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
      if (bannerPositionY !== undefined) partial.bannerPositionY = clamp(bannerPositionY, 0, 100);
      if (imagePositionX !== undefined) partial.imagePositionX = clamp(imagePositionX, 0, 100);
      if (imagePositionY !== undefined) partial.imagePositionY = clamp(imagePositionY, 0, 100);
      // Floor of 100: below it the portrait stops covering its tile.
      if (imageScale !== undefined) partial.imageScale = clamp(imageScale, 100, 300);
      if (avatarPositionX !== undefined)
        partial.avatarPositionX = avatarPositionX === null ? null : clamp(avatarPositionX, 0, 100);
      if (avatarPositionY !== undefined)
        partial.avatarPositionY = avatarPositionY === null ? null : clamp(avatarPositionY, 0, 100);
      if (avatarScale !== undefined)
        partial.avatarScale = avatarScale === null ? null : clamp(avatarScale, 100, 300);

      if (request.body.name === undefined && Object.keys(partial).length > 0) {
        const updated = await db
          .update(performers)
          .set(partial)
          .where(eq(performers.id, id))
          .returning();
        if (updated.length === 0) {
          reply.code(404);
          return { error: "Not found" };
        }
        return { performer: updated[0] };
      }

      const name = normalizeName(request.body.name ?? "");
      if (!name) {
        reply.code(400);
        return { error: "name cannot be empty" };
      }

      // Checked up front so a collision reads as a 409 rather than surfacing
      // the raw unique-index violation as a 500.
      const [clash] = await db
        .select({ id: performers.id })
        .from(performers)
        .where(sql`lower(${performers.name}) = lower(${name}) and ${performers.id} <> ${id}`);
      if (clash) {
        reply.code(409);
        return { error: `A performer named "${name}" already exists` };
      }

      const updated = await db
        .update(performers)
        .set({ name })
        .where(eq(performers.id, id))
        .returning();
      if (updated.length === 0) {
        reply.code(404);
        return { error: "Not found" };
      }
      return { performer: updated[0] };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/performers/:id", async (request, reply) => {
    const id = Number(request.params.id);

    const [existing] = await db.select().from(performers).where(eq(performers.id, id));
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }

    // No FK in this schema cascades, so the join rows have to go first.
    const unlinked = await db
      .delete(mediaItemPerformers)
      .where(eq(mediaItemPerformers.performerId, id))
      .returning();
    await db.delete(performers).where(eq(performers.id, id));
    await deletePerformerImage(existing.imageFile);
    await deletePerformerImage(existing.bannerFile);

    // Worth surfacing in the UI: a performer derived from a folder comes back
    // on the next scan for any item still marked 'scanner'. That's correct —
    // the folder still says so — but it looks like the delete failed.
    return { ok: true, unlinkedCount: unlinked.length };
  });
}
