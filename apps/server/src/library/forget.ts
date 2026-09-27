import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  albums,
  bookmarks,
  collectionItems,
  mediaFiles,
  mediaItemPerformers,
  mediaItems,
  mediaItemTags,
  mediaItemTypes,
  playbackStates,
  watchLog,
} from "../db/schema.js";
import { deleteItemThumbnail } from "../media/itemThumbnails.js";
import { posterPathFor } from "../media/poster.js";
import { previewPathFor } from "../media/preview.js";
import { deleteScrubSprite } from "../media/scrubSprite.js";
import { unlink } from "node:fs/promises";

/**
 * A missing video, shaped for a media card.
 *
 * Carries the artwork fields as well as the bookkeeping ones: the poster was
 * generated at scan time and is still cached, so a missing video can be shown
 * as the frame you would recognise rather than a filename you have to parse.
 */
export type MissingVideo = {
  id: number;
  itemType: "video";
  title: string;
  /** Where the file used to be. Null if the item never had one recorded. */
  path: string | null;
  missingSince: Date | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  thumbnailFile: string | null;
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  thumbnailScale: number;
};

/**
 * Videos whose files the scanner could not find.
 *
 * Videos only, matching the health panel: a photo goes missing whenever the
 * album around it does, in numbers that would bury the handful of videos this
 * list exists to let you act on.
 */
export async function listMissingVideos(): Promise<MissingVideo[]> {
  const rows = await db
    .select({
      id: mediaItems.id,
      title: mediaItems.title,
      path: mediaFiles.path,
      missingSince: mediaItems.missingSince,
      sizeBytes: mediaFiles.sizeBytes,
      durationSeconds: mediaItems.durationSeconds,
      thumbnailFile: mediaItems.thumbnailFile,
      thumbnailPositionX: mediaItems.thumbnailPositionX,
      thumbnailPositionY: mediaItems.thumbnailPositionY,
      thumbnailScale: mediaItems.thumbnailScale,
    })
    .from(mediaItems)
    .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
    // Left, not inner: an item can lose its file row and still be the thing
    // you came here to clear out. An inner join would hide exactly those.
    .leftJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
    .where(
      and(
        eq(mediaItemTypes.name, "video"),
        eq(mediaItems.inScope, true),
        isNotNull(mediaItems.missingSince),
      ),
    )
    .orderBy(mediaItems.title);

  // A video with several files would repeat; the list is about items.
  const seen = new Set<number>();
  return rows
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .map((row) => ({ ...row, itemType: "video" as const }));
}

/** The ids from `ids` that really are missing videos, and so may be removed. */
async function missingVideoIdsAmong(ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
    .where(
      and(
        inArray(mediaItems.id, ids),
        eq(mediaItemTypes.name, "video"),
        eq(mediaItems.inScope, true),
        isNotNull(mediaItems.missingSince),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Removes media items from the library, with everything that points at them.
 *
 * Only ever the database and the artwork this app generated. The originals are
 * mounted read-only and are, by definition, already gone — "forget" is the
 * whole operation, not a euphemism for deleting somebody's files.
 *
 * Every child row has to go first: the schema declares no cascades, so a bare
 * delete raises a foreign key violation the moment an item has a tag, a
 * performer, or a saved playback position.
 */
export async function forgetItems(ids: number[]): Promise<number> {
  return deleteItems(await missingVideoIdsAmong(ids));
}

/**
 * Deletes media items outright, with every row that points at them.
 *
 * Takes ids that a caller has already decided are safe to destroy — it does
 * no checking of its own, which is why it is not exported beyond this module
 * without a guard in front of it. `forgetItems` restricts to missing videos;
 * the folder cleanup restricts to items under no watched folder.
 */
export async function deleteItems(targets: number[]): Promise<number> {
  if (targets.length === 0) return 0;

  // Read before the delete: these name the cached poster and clip, and the
  // rows they come from are about to stop existing.
  const files = await db
    .select({
      mediaItemId: mediaFiles.mediaItemId,
      contentHash: mediaFiles.contentHash,
    })
    .from(mediaFiles)
    .where(inArray(mediaFiles.mediaItemId, targets));

  const thumbnails = await db
    .select({ thumbnailFile: mediaItems.thumbnailFile })
    .from(mediaItems)
    .where(inArray(mediaItems.id, targets));

  await db.transaction(async (tx) => {
    await tx
      .delete(playbackStates)
      .where(inArray(playbackStates.mediaItemId, targets));
    await tx.delete(bookmarks).where(inArray(bookmarks.mediaItemId, targets));
    await tx.delete(watchLog).where(inArray(watchLog.mediaItemId, targets));
    await tx
      .delete(collectionItems)
      .where(inArray(collectionItems.mediaItemId, targets));
    await tx
      .delete(mediaItemTags)
      .where(inArray(mediaItemTags.mediaItemId, targets));
    await tx
      .delete(mediaItemPerformers)
      .where(inArray(mediaItemPerformers.mediaItemId, targets));
    await tx.delete(mediaFiles).where(inArray(mediaFiles.mediaItemId, targets));

    // Nulled rather than deleted: an album keeps existing, it just goes back
    // to picking its own cover, which is what a null here already means.
    await tx
      .update(albums)
      .set({ coverItemId: null })
      .where(inArray(albums.coverItemId, targets));

    // A video holds no children today, but the column allows it and an
    // orphaned parent_id would be a foreign key violation on delete.
    await tx
      .update(mediaItems)
      .set({ parentId: null })
      .where(inArray(mediaItems.parentId, targets));

    await tx.delete(mediaItems).where(inArray(mediaItems.id, targets));
  });

  // After the transaction, and never allowed to fail it. A cache file left on
  // disk is wasted bytes; a rolled-back delete because of one is a bug.
  await Promise.all([
    ...files.map(async ({ mediaItemId, contentHash }) => {
      await unlink(posterPathFor(mediaItemId, contentHash)).catch(() => {});
      await unlink(previewPathFor(mediaItemId, contentHash)).catch(() => {});
      await deleteScrubSprite(mediaItemId, contentHash);
    }),
    ...thumbnails.map(({ thumbnailFile }) =>
      deleteItemThumbnail(thumbnailFile).catch(() => {}),
    ),
  ]);

  return targets.length;
}

/** Every missing video, for the "Remove all" button. */
export async function forgetAllMissingVideos(): Promise<number> {
  const missing = await listMissingVideos();
  return forgetItems(missing.map((item) => item.id));
}
