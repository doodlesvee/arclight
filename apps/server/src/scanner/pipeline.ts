import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "../db/client.js";
import {
  albums,
  libraryRoots,
  mediaFiles,
  mediaItemPerformers,
  mediaItemTypes,
  mediaItems,
  performers,
  scanJobs,
  series,
  studios,
} from "../db/schema.js";
import { probeVideo } from "../metadata/videoProbe.js";
import { probePhoto } from "../metadata/photoExif.js";
import { ensurePosterFrame, generatePosterFrame } from "../media/poster.js";
import { ensurePreviewClip } from "../media/preview.js";
import {
  classifyByExtension,
  mimeTypeFor,
  titleFromFilename,
  type MediaKind,
} from "./classify.js";
import {
  hasWordBoundaryMatch,
  isUsableMatchKey,
  matchKey,
  normalizeName,
  parseDeclaredName,
  performerNameFromPath,
  releaseDateFromFilename,
  studioNameFromPath,
  studioNameFromFilename,
} from "./performerNames.js";
import {
  purgeEmptyEntities,
  recomputeScope,
  sweepOrphanedArtwork,
} from "../library/scope.js";
import { partialContentHash } from "./hash.js";
import { walk } from "./walk.js";
import { logActivity } from "../activity/log.js";
import { parseSeriesEpisode } from "./series.js";

const CONCURRENCY = 4;

// -1 is a synchronous "reserved" placeholder, distinct from both null (idle)
// and a real job id — see the race-condition note in startScan below.
let runningJobId: number | null = null;

export function isScanRunning(): boolean {
  return runningJobId !== null;
}

export async function startScan(): Promise<number> {
  if (runningJobId !== null) {
    throw new Error("A scan is already running");
  }

  // Reserve the slot synchronously, before the first `await`. Node's event
  // loop can interleave two near-simultaneous requests between the check
  // above and the `db.insert` below; without this, both could read
  // `runningJobId === null` and both start a scan.
  runningJobId = -1;

  let job: typeof scanJobs.$inferSelect;
  try {
    [job] = await db.insert(scanJobs).values({ status: "running" }).returning();
  } catch (err) {
    runningJobId = null;
    throw err;
  }
  runningJobId = job.id;

  // Fire and forget: the caller polls GET /api/scan/:id for progress.
  // Errors are recorded on the job row itself inside runScan.
  void runScan(job.id);

  return job.id;
}

/**
 * The one-column bump for a file outcome.
 *
 * A lookup rather than a switch at the call site so the set of outcomes and
 * the set of columns cannot drift apart: adding an outcome without a column
 * fails to compile here rather than silently counting nothing.
 */
function outcomeIncrement(outcome: FileOutcome) {
  switch (outcome) {
    case "new":
      return { itemsNew: sql`${scanJobs.itemsNew} + 1` };
    case "updated":
      return { itemsUpdated: sql`${scanJobs.itemsUpdated} + 1` };
    case "moved":
      return { itemsMoved: sql`${scanJobs.itemsMoved} + 1` };
    case "skipped":
      return { itemsSkipped: sql`${scanJobs.itemsSkipped} + 1` };
  }
}

async function runScan(jobId: number): Promise<void> {
  try {
    const typeRows = await db.select().from(mediaItemTypes);
    const itemTypeIdByKind = new Map(typeRows.map((t) => [t.name, t.id]));

    const roots = await db
      .select({
        id: libraryRoots.id,
        libraryId: libraryRoots.libraryId,
        path: libraryRoots.path,
      })
      .from(libraryRoots);

    const seenPaths = new Set<string>();
    // Files sitting directly at a library root have no folder to name a
    // performer, so they're deferred to a second pass once every
    // folder-derived performer exists.
    const rootLevelPaths: string[] = [];
    const limit = pLimit(CONCURRENCY);
    const tasks: Promise<void>[] = [];

    for (const root of roots) {
      for await (const filePath of walk(root.path)) {
        const kind = classifyByExtension(filePath);
        if (!kind) continue;

        seenPaths.add(filePath);
        if (performerNameFromPath(root.path, filePath) === null) {
          rootLevelPaths.push(filePath);
        }

        tasks.push(
          limit(async () => {
            const outcome = await processFile(
              filePath,
              kind,
              root,
              itemTypeIdByKind,
            );
            // Atomic DB-side increments: concurrent tasks finishing out of
            // order must not clobber each other's counts (a JS-side counter
            // read-then-write across an `await` would race here). The
            // outcome tally has exactly the same hazard as filesScanned, so
            // it is incremented the same way and in the same statement.
            await db
              .update(scanJobs)
              .set({
                filesScanned: sql`${scanJobs.filesScanned} + 1`,
                ...outcomeIncrement(outcome),
              })
              .where(eq(scanJobs.id, jobId));
          }),
        );
      }
    }

    await Promise.all(tasks);
    // Deliberately after every file has been processed: the set of performers
    // to match against grows during the walk, so doing this per-file would
    // give different results depending on the order the walk happened to
    // reach things.
    await assignPerformersFromFilenames(rootLevelPaths);
    // After the walk for the same reason as the pass above: whether a
    // directory is an album depends on files the walk may not have reached
    // yet, so deciding per-file would give different answers depending on the
    // order things happened to be visited.
    await assignAlbums(roots);
    const missing = await markMissingFiles(
      seenPaths,
      roots.map((r) => r.path),
    );
    // Reconciles anything the per-file writes above couldn't know about — a
    // file whose folder was removed mid-scan, say.
    await recomputeScope();
    await purgeEmptyEntities();
    // Cached artwork for items that no longer exist. Everything here is
    // regenerable, so deleting too much only costs CPU, never data.
    await sweepOrphanedArtwork();

    const [finished] = await db
      .update(scanJobs)
      .set({
        status: "completed",
        finishedAt: new Date(),
        itemsMissing: missing,
      })
      .where(eq(scanJobs.id, jobId))
      .returning();

    // The summary goes into the activity log as well as onto the job row, so
    // "what did the scan on Tuesday do" is answerable after the next scan has
    // replaced the latest-job view (§19).
    await logActivity("scan", "Library scan completed", {
      jobId,
      new: finished?.itemsNew ?? 0,
      updated: finished?.itemsUpdated ?? 0,
      moved: finished?.itemsMoved ?? 0,
      missing: finished?.itemsMissing ?? 0,
      skipped: finished?.itemsSkipped ?? 0,
    });
  } catch (err) {
    await db
      .update(scanJobs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(scanJobs.id, jobId));
    await logActivity("scan", "Library scan failed", { jobId });
  } finally {
    runningJobId = null;
  }
}

/**
 * What a scan did to one file, for the "What Changed" summary (§15).
 *
 * "skipped" means known and unchanged — most files, on every scan after the
 * first. It is reported rather than left out because a summary of all zeroes
 * cannot otherwise be told apart from a scan that looked at nothing.
 */
export type FileOutcome = "new" | "updated" | "moved" | "skipped";

async function processFile(
  filePath: string,
  kind: MediaKind,
  root: { id: number; libraryId: number; path: string },
  itemTypeIdByKind: Map<string, number>,
): Promise<FileOutcome> {
  const libraryId = root.libraryId;
  const stats = await stat(filePath);

  const [existingFile] = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.path, filePath));

  if (existingFile) {
    await clearMissingSince(existingFile.mediaItemId);
    // Reconcile on every scan, not just at the moment a rename is detected —
    // that makes this self-healing for files renamed before this behaviour
    // existed, and it's a no-op once title and filename already agree.
    await syncTitleWithFilename(existingFile.mediaItemId, filePath);
    // Every already-known file takes this branch, so this is also what
    // backfills performers across a library that predates the feature.
    await syncPerformersWithPath(existingFile.mediaItemId, filePath, root.path);
    await syncStudioWithFilename(existingFile.mediaItemId, filePath, root.path);
    await syncReleaseDateWithFilename(existingFile.mediaItemId, filePath);
    await syncSeriesFromFilename(existingFile.mediaItemId, libraryId, filePath);

    if (kind === "video") {
      await ensureArtworkForItem(
        existingFile.mediaItemId,
        filePath,
        existingFile.contentHash,
      );
    }

    const unchanged =
      Number(existingFile.sizeBytes) === stats.size &&
      existingFile.mtime.getTime() === stats.mtime.getTime();
    if (unchanged) return "skipped";

    const contentHash = await partialContentHash(filePath, stats.size);
    await db
      .update(mediaFiles)
      .set({ sizeBytes: stats.size, mtime: stats.mtime, contentHash })
      .where(eq(mediaFiles.id, existingFile.id));
    return "updated";
  }

  const contentHash = await partialContentHash(filePath, stats.size);

  // Same content already tracked at a different path: treat as a move/rename
  // rather than a new item, so tags/collections attached later won't be lost.
  const [movedFile] = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.contentHash, contentHash));

  if (movedFile) {
    await db
      .update(mediaFiles)
      .set({
        path: filePath,
        sizeBytes: stats.size,
        mtime: stats.mtime,
        rootId: root.id,
      })
      .where(eq(mediaFiles.id, movedFile.id));
    await clearMissingSince(movedFile.mediaItemId);
    await syncTitleWithFilename(movedFile.mediaItemId, filePath);
    // A file relocated into a different performer's folder follows it, in
    // exactly the way its title follows a rename.
    await syncPerformersWithPath(movedFile.mediaItemId, filePath, root.path);
    await syncStudioWithFilename(movedFile.mediaItemId, filePath, root.path);
    await syncReleaseDateWithFilename(movedFile.mediaItemId, filePath);
    await syncSeriesFromFilename(movedFile.mediaItemId, libraryId, filePath);
    return "moved";
  }

  const itemTypeId = itemTypeIdByKind.get(kind);
  if (!itemTypeId) {
    throw new Error(
      `Missing media_item_types row for "${kind}" — did seeding run?`,
    );
  }

  const title = titleFromFilename(filePath);
  const parsedSeries = kind === "video" ? parseSeriesEpisode(filePath) : null;
  const seriesId = parsedSeries ? await ensureSeriesId(libraryId, parsedSeries.name) : null;
  let durationSeconds: number | null = null;
  let takenAt: Date | null = null;
  let extraMetadata: Record<string, unknown>;

  if (kind === "video") {
    const probe = await probeVideo(filePath);
    durationSeconds = probe.durationSeconds;
    extraMetadata = {
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      containerFormat: probe.containerFormat,
      embeddedTitle: probe.embeddedTitle,
    };
  } else {
    const exif = await probePhoto(filePath);
    takenAt = exif.takenAt;
    extraMetadata = { cameraModel: exif.cameraModel, gps: exif.gps };
  }

  const [item] = await db
    .insert(mediaItems)
    .values({
      libraryId,
      itemTypeId,
      title,
      durationSeconds,
      takenAt,
      extraMetadata,
      seriesId,
      seasonNumber: parsedSeries?.seasonNumber ?? null,
      episodeNumber: parsedSeries?.episodeNumber ?? null,
      episodeTitle: parsedSeries?.episodeTitle ?? null,
    })
    .returning();

  await db.insert(mediaFiles).values({
    mediaItemId: item.id,
    path: filePath,
    rootId: root.id,
    sizeBytes: stats.size,
    mtime: stats.mtime,
    contentHash,
    mimeType: mimeTypeFor(filePath),
  });

  await syncPerformersWithPath(item.id, filePath, root.path);
  await syncStudioWithFilename(item.id, filePath, root.path);
  await syncReleaseDateWithFilename(item.id, filePath);

  if (kind === "video") {
    await generatePosterFrame(filePath, item.id, contentHash, durationSeconds);
    await ensurePreviewClip(filePath, item.id, contentHash, durationSeconds);
  }

  await logActivity("add", `Added "${title}"`, { kind }, item.id);

  return "new";
}

async function ensureSeriesId(libraryId: number, name: string): Promise<number> {
  const [created] = await db
    .insert(series)
    .values({ libraryId, name })
    .onConflictDoNothing()
    .returning({ id: series.id });
  if (created) return created.id;

  const [existing] = await db
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.libraryId, libraryId), eq(series.name, name)));
  if (!existing) throw new Error(`Could not resolve series "${name}"`);
  return existing.id;
}

async function syncSeriesFromFilename(
  mediaItemId: number,
  libraryId: number,
  filePath: string,
): Promise<void> {
  const parsed = parseSeriesEpisode(filePath);
  if (!parsed) return;
  const seriesId = await ensureSeriesId(libraryId, parsed.name);
  await db
    .update(mediaItems)
    .set({
      seriesId,
      seasonNumber: parsed.seasonNumber,
      episodeNumber: parsed.episodeNumber,
      episodeTitle: parsed.episodeTitle,
      updatedAt: new Date(),
    })
    .where(eq(mediaItems.id, mediaItemId));
}

/**
 * Resolves a performer name to its id, creating the row if needed.
 *
 * Written to survive the race that CONCURRENCY makes routine: two files under
 * the same folder are processed at once, both miss the lookup, and both
 * insert. Without onConflictDoNothing the second insert raises a unique
 * violation, which propagates out of processFile and fails the entire scan.
 */
async function ensurePerformerId(rawName: string): Promise<number> {
  const name = normalizeName(rawName);

  // lower(a) = lower(b) rather than ilike: `_` and `%` are LIKE wildcards, so
  // a performer named "Alice_B" would ilike-match "AliceXB". It also lets
  // Postgres use the lower(name) unique index.
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

  // Lost the race — the winner's row is there now.
  const raced = await findId();
  if (raced === null) throw new Error(`Could not resolve performer "${name}"`);
  return raced;
}

async function ensureStudioId(rawName: string): Promise<number> {
  const name = normalizeName(rawName);

  const findId = async (): Promise<number | null> => {
    const [row] = await db
      .select({ id: studios.id })
      .from(studios)
      .where(sql`lower(${studios.name}) = lower(${name})`);
    return row?.id ?? null;
  };

  const existing = await findId();
  if (existing !== null) return existing;

  const [created] = await db
    .insert(studios)
    .values({ name })
    .onConflictDoNothing()
    .returning();
  if (created) return created.id;

  const raced = await findId();
  if (raced === null) throw new Error(`Could not resolve studio "${name}"`);
  return raced;
}

/**
 * Sets an item's release date from its filename.
 *
 * Two sources, in the same order of explicitness as everything else: the date
 * segment of a declared name, then any date found loose in a filename that
 * doesn't follow the convention — which is what gives the not-yet-renamed
 * files a date without touching them.
 *
 * No source flag, because there's nothing to protect: the date is never
 * user-authored today. If manual editing is added, this needs the same
 * `!== "scanner"` guard the title and studio syncs have.
 */
async function syncReleaseDateWithFilename(
  mediaItemId: number,
  filePath: string,
): Promise<void> {
  const declared = parseDeclaredName(filePath);
  const releaseDate =
    declared?.releaseDate ?? releaseDateFromFilename(filePath);
  if (!releaseDate) return; // nothing in the name — leave whatever is there

  const [item] = await db
    .select({ releaseDate: mediaItems.releaseDate })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  // Already agrees; don't churn updatedAt on every scan. The column is a
  // `date`, which drizzle hands back as a "YYYY-MM-DD" string.
  if (!item || item.releaseDate === releaseDate) return;

  await db
    .update(mediaItems)
    .set({ releaseDate, updatedAt: new Date() })
    .where(eq(mediaItems.id, mediaItemId));
}

/**
 * Sets an item's studio while the scanner still owns that field. Same contract
 * as titles and performers.
 *
 * Three sources, most explicit first:
 *
 *  1. A leading `[Studio]` in a filename following the declared convention —
 *     you typed it in the name of this specific file, so it wins.
 *  2. A `<Performer>/<Studio>/` folder, which is a deliberate filing decision
 *     covering everything inside it.
 *  3. A `[Brackets]` group anywhere else in the filename — the weakest signal,
 *     and the one that has produced nonsense studios from brackets that were
 *     never studio names.
 *
 * Case differences between a folder and a filename don't split a studio in
 * two: ensureStudioId matches on lower(name), so `Blackedraw/` resolves to an
 * existing `BlackedRaw`.
 */
async function syncStudioWithFilename(
  mediaItemId: number,
  filePath: string,
  rootPath: string,
): Promise<void> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  if (!item || item.studioSource !== "scanner") return;

  const name =
    parseDeclaredName(filePath)?.studio ??
    studioNameFromPath(rootPath, filePath) ??
    studioNameFromFilename(filePath);
  if (!name) return; // nothing says a studio — leave whatever is there alone

  const studioId = await ensureStudioId(name);
  if (item.studioId === studioId) return; // already agrees; don't churn updatedAt

  await db
    .update(mediaItems)
    .set({ studioId, updatedAt: new Date() })
    .where(eq(mediaItems.id, mediaItemId));
}

/**
 * Points an item's performers at whatever its name implies — but only while
 * the user hasn't taken ownership of them.
 *
 * Two sources, in priority order:
 *
 *  1. A filename following the declared convention, `[Studio] A, B - Title`,
 *     which names the **complete cast**. The folder is deliberately not added
 *     on top: an explicit list is what lets a misfiled video be corrected by
 *     renaming it, and silently re-adding the folder would take that away.
 *  2. Otherwise the folder, exactly as before.
 *
 * This is the whole reason a video with two performers no longer needs a copy
 * in each performer's folder — which was never a real option anyway, since two
 * byte-identical files collide on content hash and get treated as a move of
 * one another.
 *
 * Shaped like syncTitleWithFilename on purpose: same "scanner owns it until
 * you edit it" contract, same self-healing property across rescans.
 */
async function syncPerformersWithPath(
  mediaItemId: number,
  filePath: string,
  rootPath: string,
): Promise<void> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  if (!item || item.performersSource !== "scanner") return;

  const declared = parseDeclaredName(filePath);
  const names =
    declared && declared.performerNames.length > 0
      ? declared.performerNames
      : ([performerNameFromPath(rootPath, filePath)].filter(
          Boolean,
        ) as string[]);

  if (names.length === 0) return; // root-level file — the filename pass handles these

  // Sequential rather than Promise.all: two names in one filename that differ
  // only by case must resolve to the same row, and racing them past
  // ensurePerformerId's find-then-insert can create two.
  const wanted = new Set<number>();
  for (const name of names) {
    wanted.add(await ensurePerformerId(name));
  }

  const current = await db
    .select({ performerId: mediaItemPerformers.performerId })
    .from(mediaItemPerformers)
    .where(eq(mediaItemPerformers.mediaItemId, mediaItemId));

  // Bail when they already agree, compared as sets. Checking a single id here
  // (as this once did) meant a two-performer item never matched and rewrote
  // added_at on every row on every scan.
  const unchanged =
    current.length === wanted.size &&
    current.every((row) => wanted.has(row.performerId));
  if (unchanged) return;

  // Replace rather than add: a file moved out of a performer's folder, or
  // dropped from a declared list, must stop being credited to them.
  await db
    .delete(mediaItemPerformers)
    .where(eq(mediaItemPerformers.mediaItemId, mediaItemId));
  await db
    .insert(mediaItemPerformers)
    .values([...wanted].map((performerId) => ({ mediaItemId, performerId })))
    .onConflictDoNothing();
}

/**
 * Groups each directory of photos into an album.
 *
 * Only directories that actually contain a photo qualify. Without that every
 * video folder would become a meaningless one-item album, and the section
 * would be mostly noise.
 *
 * The album's video gets the same `albumId` as its photos: a scene is the
 * video and its stills together, so "this album's video" stays one lookup
 * rather than another path-prefix comparison.
 */
async function assignAlbums(roots: { path: string }[]): Promise<void> {
  const rows = await db
    .select({
      itemId: mediaItems.id,
      path: mediaFiles.path,
      typeName: mediaItemTypes.name,
      albumId: mediaItems.albumId,
      missing: mediaItems.missingSince,
    })
    .from(mediaFiles)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaFiles.mediaItemId))
    .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id));

  // Group by directory in JS rather than SQL: the same string handling the
  // gallery endpoint uses, and it avoids a regex over every row.
  const byDirectory = new Map<string, typeof rows>();
  for (const row of rows) {
    const directory = row.path.slice(0, row.path.lastIndexOf("/"));
    if (!directory) continue;
    const list = byDirectory.get(directory) ?? [];
    list.push(row);
    byDirectory.set(directory, list);
  }

  for (const [directory, items] of byDirectory) {
    // A photo whose file is gone must not conjure an album. Rows outlive
    // their files by design — the scanner flags `missingSince` rather than
    // deleting, so an unplugged drive can't destroy metadata — but a folder
    // that exists only in the database is not something to browse.
    //
    // Only album *creation* is gated this way: items already linked keep
    // their albumId, so an album on a temporarily absent drive survives.
    if (!items.some((i) => i.typeName === "photo" && i.missing === null))
      continue;

    const root = roots.find(
      (r) => directory === r.path || directory.startsWith(r.path + "/"),
    );
    const title = normalizeName(basename(directory)) || directory;
    const performerName = root
      ? performerNameFromPath(root.path, `${directory}/x`)
      : null;
    const studioName = root
      ? studioNameFromPath(root.path, `${directory}/x`)
      : null;

    const [album] = await db
      .insert(albums)
      .values({
        path: directory,
        title,
        performerId: performerName
          ? await ensurePerformerId(performerName)
          : null,
        studioId: studioName ? await ensureStudioId(studioName) : null,
      })
      // Unique on path, so a rescan updates the derived fields instead of
      // failing or duplicating.
      .onConflictDoUpdate({ target: albums.path, set: { title } })
      .returning();

    // The scene's video, when the photos live in a subfolder.
    //
    // A very common layout is a scene folder holding the video with an
    // `Images/` (or `Stills/`, or whatever it is called) subfolder beside it.
    // Grouping strictly by directory puts the two in different buckets, so
    // the album was built from the photos alone and the video was left with
    // no albumId — which is what made the gallery strip under the player
    // empty for every scene organised that way.
    //
    // Only the immediate parent, and only when this directory has no video of
    // its own: the parent is the scene, and reaching any further up would
    // attach a studio-wide folder of artwork to every video beneath it.
    const parent = directory.slice(0, directory.lastIndexOf("/"));
    const parentVideos =
      !items.some((i) => i.typeName === "video") && parent
        ? (byDirectory.get(parent) ?? []).filter((i) => i.typeName === "video")
        : [];

    const needsLinking = [...items, ...parentVideos]
      .filter((i) => i.albumId !== album.id)
      .map((i) => i.itemId);
    if (needsLinking.length > 0) {
      await db
        .update(mediaItems)
        .set({ albumId: album.id })
        .where(inArray(mediaItems.id, needsLinking));
    }
  }
}

/**
 * Second pass for files sitting directly at a library root, where there's no
 * folder to name a performer. Matches the filename against performers that
 * already exist — it never invents a name out of a filename, so a performer
 * has to come from a folder or from you before anything can match it.
 *
 * Additive only, unlike the folder pass: a folder is an authoritative
 * statement about a file, a filename substring is only a suggestion. If this
 * replaced instead, renaming a performer would silently strip every
 * root-level link on the next scan.
 */
async function assignPerformersFromFilenames(
  filePaths: string[],
): Promise<void> {
  if (filePaths.length === 0) return;

  const all = await db
    .select({ id: performers.id, name: performers.name })
    .from(performers);
  const candidates = all
    .map((p) => ({ id: p.id, key: matchKey(p.name) }))
    .filter((p) => isUsableMatchKey(p.key));
  if (candidates.length === 0) return;

  const rows = await db
    .select({
      path: mediaFiles.path,
      mediaItemId: mediaFiles.mediaItemId,
      performersSource: mediaItems.performersSource,
    })
    .from(mediaFiles)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaFiles.mediaItemId))
    .where(inArray(mediaFiles.path, filePaths));

  for (const row of rows) {
    if (row.performersSource !== "scanner") continue;

    const haystack = matchKey(basename(row.path).replace(/\.[^./]+$/, ""));
    let matched = candidates.filter((c) =>
      hasWordBoundaryMatch(haystack, c.key),
    );

    // Drop any match wholly contained in another, so "Dani Daniels" wins over
    // a separate performer named "Dani".
    matched = matched.filter(
      (m) =>
        !matched.some(
          (other) => other.id !== m.id && other.key.includes(m.key),
        ),
    );
    if (matched.length === 0) continue;

    await db
      .insert(mediaItemPerformers)
      .values(
        matched.map((m) => ({
          mediaItemId: row.mediaItemId,
          performerId: m.id,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Rebuilds a video's poster frame and preview clip if either isn't cached
 * (e.g. after the cache directory is cleared).
 */
async function ensureArtworkForItem(
  mediaItemId: number,
  filePath: string,
  contentHash: string | null,
): Promise<void> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  if (!item) return;

  // A video scanned while ffprobe was missing was stored with no duration and
  // never probed again. Fill it in once the tool is available, so installing
  // ffmpeg is enough to repair those items on the next scan.
  let durationSeconds = item.durationSeconds;
  if (durationSeconds === null) {
    const probe = await probeVideo(filePath);
    if (probe.durationSeconds !== null) {
      durationSeconds = probe.durationSeconds;
      await db
        .update(mediaItems)
        .set({
          durationSeconds,
          extraMetadata: {
            ...((item.extraMetadata as Record<string, unknown> | null) ?? {}),
            width: probe.width,
            height: probe.height,
            codec: probe.codec,
            containerFormat: probe.containerFormat,
            embeddedTitle: probe.embeddedTitle,
          },
        })
        .where(eq(mediaItems.id, mediaItemId));
    }
  }

  await ensurePosterFrame(filePath, mediaItemId, contentHash, durationSeconds);
  await ensurePreviewClip(filePath, mediaItemId, contentHash, durationSeconds);
}

/**
 * After a file moves or is renamed, bring its title along — but only if the
 * title is still the one the scanner derived. Once it's been edited in the
 * app (`titleSource === 'user'`) the filename stops being authoritative.
 */
async function syncTitleWithFilename(
  mediaItemId: number,
  filePath: string,
): Promise<void> {
  const [item] = await db
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  if (!item || item.titleSource !== "filename") return;

  const derived = titleFromFilename(filePath);
  if (!derived || derived === item.title) return;

  await db
    .update(mediaItems)
    .set({ title: derived, updatedAt: new Date() })
    .where(eq(mediaItems.id, mediaItemId));
}

async function clearMissingSince(mediaItemId: number): Promise<void> {
  await db
    .update(mediaItems)
    .set({ missingSince: null })
    .where(eq(mediaItems.id, mediaItemId));
}

/**
 * Flags items whose file has disappeared from a folder we're still watching.
 *
 * Scoped to the configured roots on purpose: a file under a folder you've
 * stopped scanning hasn't gone anywhere, so calling it "missing" is wrong and
 * floods the library with warnings the moment you reorganise. Those items are
 * simply left alone.
 */
async function markMissingFiles(
  seenPaths: Set<string>,
  rootPaths: string[],
): Promise<number> {
  const allFiles = await db.select().from(mediaFiles);
  const now = new Date();
  // Counted here rather than re-queried afterwards: this is the only place
  // that knows which items went missing *on this scan*, as opposed to which
  // are missing in total — the latter includes everything that vanished
  // during previous scans and never came back.
  let newlyMissing = 0;

  const isWatched = (filePath: string): boolean =>
    rootPaths.some(
      (root) => filePath === root || filePath.startsWith(root + "/"),
    );

  for (const file of allFiles) {
    if (seenPaths.has(file.path)) continue;
    if (!isWatched(file.path)) continue;

    const [item] = await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.id, file.mediaItemId));
    if (item && !item.missingSince) {
      await db
        .update(mediaItems)
        .set({ missingSince: now })
        .where(eq(mediaItems.id, item.id));
      newlyMissing += 1;
    }
  }

  return newlyMissing;
}
