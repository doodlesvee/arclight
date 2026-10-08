import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { type FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  mediaFiles,
  mediaItemPerformers,
  mediaItemTags,
  mediaItemTypes,
  mediaItems,
  playbackStates,
  studios,
} from "../db/schema.js";
import { visibleItems } from "../library/visibility.js";
import {
  GALLERY_PREVIEW_LIMIT,
  RELATED_LIMIT,
  fetchRelated,
  itemColumns,
  playbackColumns,
  withComputedFields,
  withPlayback,
} from "./mediaItemQueries.js";

export async function mediaItemDetailRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/media-items/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const [item] = await db
      .select({
        ...itemColumns,
        ...playbackColumns,
        // The detail view is the only place these are shown, so the join
        // stays here rather than on every listing query.
        fileModifiedAt: mediaFiles.mtime,
        fileSizeBytes: mediaFiles.sizeBytes,
      })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id))
      .leftJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(and(eq(mediaItems.id, id), eq(mediaItems.inScope, true)));
    if (!item) {
      reply.code(404);
      return { error: "Not found" };
    }
    const related = await fetchRelated([id]);
    return withPlayback(item, related);
  });

  /**
   * The still images that live in the same folder as this item's file.
   *
   * A studio folder holds a scene and its gallery, so "same directory" is the
   * whole relationship — no new table, no manual linking, and moving the
   * folder keeps it intact because it was never stored anywhere.
   *
   * Compared as an exact directory string rather than a LIKE prefix: `_` and
   * `%` are wildcards and both are legal in a folder name, so a prefix match
   * would quietly pull in the wrong folder's photos.
   */
  app.get<{ Params: { id: string } }>("/api/media-items/:id/gallery", async (request) => {
    const id = Number(request.params.id);

    const [file] = await db
      .select({ path: mediaFiles.path })
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaItemId, id));
    if (!file) return { albumId: null, total: 0, images: [] };

    const directory = file.path.slice(0, file.path.lastIndexOf("/"));
    if (!directory) return { albumId: null, total: 0, images: [] };

    const sameDirectoryPhotos = and(
      eq(mediaItemTypes.name, "photo"),
      visibleItems(),
      ne(mediaItems.id, id),
      // Beside the video, or one folder below it.
      //
      // The first pattern takes everything up to the last slash — the photo's
      // own directory. The second takes everything up to the second-to-last
      // slash — its parent — which is what matches the common layout where a
      // scene folder holds the video and an `Images/` subfolder holds the
      // stills. Without it those photos belong to no video at all, and the
      // strip under the player was empty for a whole library.
      //
      // Only one level down, not any depth: a prefix match would pull every
      // photo under a folder into the strip of a video that happens to sit at
      // its top, which for a library organised by performer is thousands.
      //
      // Both compared exactly rather than with LIKE, because `_` and `%` are
      // legal in folder names and a LIKE prefix would treat them as
      // wildcards — "Little Caprice/100%_Real" would match folders it has
      // nothing to do with.
      sql`(
        substring(${mediaFiles.path} from '^(.*)/[^/]*$') = ${directory}
        or substring(${mediaFiles.path} from '^(.*)/[^/]*/[^/]*$') = ${directory}
      )`
    );

    const rows = await db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        thumbnailFile: mediaItems.thumbnailFile,
        path: mediaFiles.path,
      })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(sameDirectoryPhotos)
      // Filenames are the only stable order here — they're usually numbered.
      .orderBy(asc(mediaFiles.path))
      // A preview, not the set. This used to return every photo, so opening a
      // video put 121 <img> elements inside the modal. Albums have their own
      // page now, which is where a set that size belongs.
      .limit(GALLERY_PREVIEW_LIMIT + 1);

    // The album id lets the modal link through to the full gallery instead
    // of the strip being the only way to see 121 photos.
    //
    // The video's own albumId first, then the album its photos belong to.
    // The fallback matters for the subfolder layout: the album row is created
    // for the `Images/` directory and only its photos are linked to it, so the
    // video has no albumId of its own until a rescan — and until then "See all"
    // would be missing from a strip that is plainly showing an album.
    const [owner] = await db
      .select({ albumId: mediaItems.albumId })
      .from(mediaItems)
      .where(eq(mediaItems.id, id));

    let albumId = owner?.albumId ?? null;
    if (albumId === null && rows.length > 0) {
      const [fromPhotos] = await db
        .select({ albumId: mediaItems.albumId })
        .from(mediaItems)
        .where(and(eq(mediaItems.id, rows[0].id), isNotNull(mediaItems.albumId)));
      albumId = fromPhotos?.albumId ?? null;
    }

    // One extra row was fetched purely to answer "are there more?" without a
    // COUNT(*); only when there are does the real total get looked up.
    const hasMore = rows.length > GALLERY_PREVIEW_LIMIT;
    const images = hasMore ? rows.slice(0, GALLERY_PREVIEW_LIMIT) : rows;

    // Counted over the directory rather than the album, so the number is
    // right even for a video scanned before albums existed and left with no
    // album_id — the strip previews a folder, not a row in `albums`.
    let total = images.length;
    if (hasMore) {
      const [counted] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(mediaItems)
        .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
        .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
        .where(sameDirectoryPhotos);
      total = counted?.total ?? images.length;
    }

    return {
      albumId,
      total,
      images: images.map((row) => ({
        id: row.id,
        title: row.title,
        thumbnailFile: row.thumbnailFile,
      })),
    };
  });

  // "More like this": no external metadata to compare against, so relatedness
  // is whatever the library already knows, in descending order of how much it
  // actually means:
  //
  //   1. the same performer — this library is organised by performer, so it's
  //      the strongest signal available and the one most likely to be what
  //      you'd want next;
  //   2. a shared tag, the user's own explicit grouping;
  //   3. folder siblings, which is nearly arbitrary but beats an empty row.
  //
  // Each tier only runs when the one before it returned nothing.
  app.get<{ Params: { id: string } }>("/api/media-items/:id/related", async (request, reply) => {
    const id = Number(request.params.id);

    const [item] = await db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.id, id), eq(mediaItems.inScope, true)));
    if (!item) {
      reply.code(404);
      return { error: "Not found" };
    }

    const ownTagIds = (
      await db
        .select({ tagId: mediaItemTags.tagId })
        .from(mediaItemTags)
        .where(eq(mediaItemTags.mediaItemId, id))
    ).map((r) => r.tagId);

    const ownPerformerIds = (
      await db
        .select({ performerId: mediaItemPerformers.performerId })
        .from(mediaItemPerformers)
        .where(eq(mediaItemPerformers.mediaItemId, id))
    ).map((r) => r.performerId);

    const baseQuery = db
      .select(itemColumns)
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .leftJoin(studios, eq(studios.id, mediaItems.studioId));

    let rows: Awaited<ReturnType<typeof baseQuery.where>> = [];

    if (ownPerformerIds.length > 0) {
      // selectDistinct matters: a video sharing two performers with this one
      // would otherwise come back twice and use up two of the eight slots.
      const samePerformerIds = db
        .selectDistinct({ id: mediaItemPerformers.mediaItemId })
        .from(mediaItemPerformers)
        .where(inArray(mediaItemPerformers.performerId, ownPerformerIds));

      rows = await baseQuery
        .where(
          and(
            inArray(mediaItems.id, samePerformerIds),
            ne(mediaItems.id, id),
            ne(mediaItemTypes.name, "photo"),
            visibleItems()
          )
        )
        .orderBy(desc(mediaItems.createdAt))
        .limit(RELATED_LIMIT);
    }

    if (rows.length === 0 && ownTagIds.length > 0) {
      const relatedIds = db
        .selectDistinct({ id: mediaItemTags.mediaItemId })
        .from(mediaItemTags)
        .where(inArray(mediaItemTags.tagId, ownTagIds));

      rows = await baseQuery
        .where(
          and(
            inArray(mediaItems.id, relatedIds),
            ne(mediaItems.id, id),
            visibleItems()
          )
        )
        .orderBy(desc(mediaItems.createdAt))
        .limit(RELATED_LIMIT);
    }

    // Fall back on empty *results*, not just on an untagged item — an item
    // whose tags nobody else shares would otherwise get a blank row.
    if (rows.length === 0) {
      rows = await baseQuery
        .where(
          and(
            item.parentId === null
              ? isNull(mediaItems.parentId)
              : eq(mediaItems.parentId, item.parentId),
            ne(mediaItems.id, id),
            ne(mediaItemTypes.name, "folder"),
            ne(mediaItemTypes.name, "photo"),
            visibleItems()
          )
        )
        .orderBy(desc(mediaItems.createdAt))
        .limit(RELATED_LIMIT);
    }

    const related = await fetchRelated(rows.map((r) => r.id));
    return { items: rows.map((r) => withComputedFields(r, related)) };
  });
}
