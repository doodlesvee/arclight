import { type SQL, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  categories,
  mediaFiles,
  mediaItemPerformers,
  mediaItemTags,
  mediaItemTypes,
  mediaItems,
  performers,
  playbackStates,
  studios,
  tags,
} from "../db/schema.js";
import { playbackWarningFor } from "../media/compatibility.js";

export const PAGE_SIZE = 50;

// Anything that reads back a video's watch state selects these together, so a
// query can't accidentally return the position without the watched flag.
export const playbackColumns = {
  lastPositionSeconds: playbackStates.positionSeconds,
  watchedAt: playbackStates.completedAt,
  playCount: playbackStates.playCount,
};

// How much of a video counts as "finished". Credits, black frames and a
// stray click near the end all mean the last few percent often never play,
// so waiting for a true 100% would leave things in Continue Watching forever.
//
// Held as a whole percent, and compared by cross-multiplying rather than
// dividing, so the comparison stays integer-only. A fractional 0.92 bound
// into `duration_seconds * $n` made Postgres infer the parameter's type from
// the integer column it multiplies and reject the query outright.
export const WATCHED_PERCENT = 92;

/**
 * Sort orders offered to the grid. Every one ends with the item id as a
 * tiebreaker: a scan inserts many rows at the same clock instant, and paging
 * with OFFSET over a non-unique sort duplicates rows on one page and skips
 * them on the next.
 */
export const SORTS = [
  "newest",
  "oldest",
  "title",
  "titleDesc",
  "released",
  "releasedOldest",
  "longest",
  "shortest",
  "watched",
  "played",
  "rating",
  "largest",
  "smallest",
  "random",
] as const;
export type Sort = (typeof SORTS)[number];

/**
 * An item's size on disk: the total of its files.
 *
 * A correlated subquery rather than a join, because an item can have several
 * files (a video and its stills) and joining would multiply the item's row
 * by that count — turning one 4GB video into four of them in the grid.
 */
export const fileSizeExpr = sql`(
  select coalesce(sum(mf.size_bytes), 0)
  from ${mediaFiles} mf
  where mf.media_item_id = ${mediaItems.id}
)`;

/**
 * Height bands for the resolution filter (§7).
 *
 * The boundaries sit below each nominal height rather than on it, which is
 * the whole reason this is a table and not a comparison. Real files are 1078
 * or 1088 tall as often as exactly 1080, and a crop or a letterbox moves the
 * number again — a band starting at 1080 would put most of a Full HD library
 * in the HD bucket. Each band is "at least this tall, and shorter than the
 * next one up".
 */
export const RESOLUTIONS: Record<string, { min: number; max: number | null }> = {
  sd: { min: 0, max: 700 },
  hd: { min: 700, max: 1000 },
  fullhd: { min: 1000, max: 1800 },
  "4k": { min: 1800, max: null },
};

/**
 * A stable shuffle, seeded per request by the caller.
 *
 * `order by random()` would reshuffle on every page, so paging a randomised
 * grid would show the same item three times and miss others entirely.
 * Hashing the id against a seed gives an order that is arbitrary but fixed
 * for as long as the seed is, which is what makes OFFSET paging valid.
 */
export function randomOrder(seed: number): SQL[] {
  return [sql`md5(${mediaItems.id}::text || ${String(seed)})`, asc(mediaItems.id)];
}

/**
 * Ordering while a search is running: anything whose title contains the whole
 * query comes first, then the rest by recency.
 *
 * Without this a title match ranks below an unrelated item that merely
 * happens to be newer, which reads as the search having ignored you. Only
 * applied when no explicit sort was chosen — picking "Longest" should mean
 * longest, search or not.
 */
export function searchOrder(search: string): SQL[] {
  const phrase = `%${escapeLike(search)}%`;
  return [
    sql`(case when ${mediaItems.title} ilike ${phrase} then 0 else 1 end)`,
    desc(mediaItems.createdAt),
    desc(mediaItems.id),
  ];
}

export function orderFor(sort: string | undefined, randomSeed: number): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(mediaItems.createdAt), asc(mediaItems.id)];
    case "title":
      return [sql`lower(${mediaItems.title}) asc`, asc(mediaItems.id)];
    case "titleDesc":
      return [sql`lower(${mediaItems.title}) desc`, desc(mediaItems.id)];
    // Release date is when the scene came out, parsed from the filename —
    // a different question from createdAt, which is when the file reached
    // this library. A re-scan of an old collection makes every item "new"
    // by createdAt while their release dates span twenty years.
    //
    // NULLS LAST in both directions, unlike the asc/desc pairs above: an
    // undated item is not "earliest", it is unknown, and floating those to
    // the top of "Oldest release" would bury the actual answer.
    case "released":
      return [sql`${mediaItems.releaseDate} desc nulls last`, desc(mediaItems.id)];
    case "releasedOldest":
      return [sql`${mediaItems.releaseDate} asc nulls last`, asc(mediaItems.id)];
    // Folders have no duration at all, and Postgres sorts NULLs first on
    // DESC — without NULLS LAST they'd head up the "longest" list.
    case "longest":
      return [sql`${mediaItems.durationSeconds} desc nulls last`, desc(mediaItems.id)];
    case "shortest":
      return [sql`${mediaItems.durationSeconds} asc nulls last`, asc(mediaItems.id)];
    // Never-watched items have no playback row at all, so the LEFT JOIN
    // leaves these NULL. NULLS LAST keeps "recently watched" a list of
    // things actually watched rather than a wall of untouched items.
    case "watched":
      return [
        sql`${playbackStates.updatedAt} desc nulls last`,
        desc(mediaItems.id),
      ];
    case "played":
      return [sql`${playbackStates.playCount} desc nulls last`, desc(mediaItems.id)];
    // Unrated is unknown, not bad — it goes after every star count, the same
    // reasoning as undated items under the release sorts.
    case "rating":
      return [sql`${mediaItems.rating} desc nulls last`, desc(mediaItems.id)];
    case "largest":
      return [sql`${fileSizeExpr} desc nulls last`, desc(mediaItems.id)];
    case "smallest":
      return [sql`${fileSizeExpr} asc nulls last`, asc(mediaItems.id)];
    case "random":
      return randomOrder(randomSeed);
    default:
      return [desc(mediaItems.createdAt), desc(mediaItems.id)];
  }
}

/** Rounds into range, falling back to the low bound for a non-numeric value. */
export function clampPercent(value: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.round(Math.max(min, Math.min(max, n)));
}

/**
 * Splits a query into the words that must each match.
 *
 * Capped so a pasted paragraph can't build a query with hundreds of
 * subselects in it; the first handful of words decide the result anyway.
 */
export const MAX_SEARCH_TERMS = 6;

export function searchTerms(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
}

// `%` and `_` are LIKE wildcards, and a filename legitimately contains both.
// Unescaped, searching for `Scene_01` would also match `Scene-01`.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const RELATED_LIMIT = 8;

/** How many stills the video modal previews before handing off to the album. */
export const GALLERY_PREVIEW_LIMIT = 8;
export const HERO_LIMIT = 5;

/**
 * The category slugs that currently exist.
 *
 * This used to be a hardcoded `["video", "movie", "series"]`. Categories then
 * became user-editable data, and the constant didn't follow — so every
 * category you created yourself failed validation. In the listing query that
 * was silent and destructive: an unrecognised kind meant the filter was never
 * added *and* folder scoping was suppressed, so the tile returned the entire
 * library instead of its own items.
 */
export async function categorySlugs(): Promise<Set<string>> {
  const rows = await db.select({ slug: categories.slug }).from(categories);
  return new Set(rows.map((r) => r.slug));
}

export const itemColumns = {
  id: mediaItems.id,
  libraryId: mediaItems.libraryId,
  parentId: mediaItems.parentId,
  itemType: mediaItemTypes.name,
  title: mediaItems.title,
  titleSource: mediaItems.titleSource,
  description: mediaItems.description,
  performersSource: mediaItems.performersSource,
  isFavorite: mediaItems.isFavorite,
  kind: mediaItems.kind,
  studio: studios.name,
  studioSource: mediaItems.studioSource,
  thumbnailFile: mediaItems.thumbnailFile,
  thumbnailPositionX: mediaItems.thumbnailPositionX,
  thumbnailPositionY: mediaItems.thumbnailPositionY,
  thumbnailScale: mediaItems.thumbnailScale,
  tileShape: mediaItems.tileShape,
  rating: mediaItems.rating,
  durationSeconds: mediaItems.durationSeconds,
  takenAt: mediaItems.takenAt,
  releaseDate: mediaItems.releaseDate,
  extraMetadata: mediaItems.extraMetadata,
  missingSince: mediaItems.missingSince,
  createdAt: mediaItems.createdAt,
  updatedAt: mediaItems.updatedAt,
};

export async function fetchTagsByItemIds(
  itemIds: number[]
): Promise<Map<number, { id: number; name: string; color: string | null }[]>> {
  if (itemIds.length === 0) return new Map();

  const rows = await db
    .select({
      mediaItemId: mediaItemTags.mediaItemId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(mediaItemTags)
    .innerJoin(tags, eq(tags.id, mediaItemTags.tagId))
    .where(inArray(mediaItemTags.mediaItemId, itemIds));

  const map = new Map<number, { id: number; name: string; color: string | null }[]>();
  for (const row of rows) {
    const list = map.get(row.mediaItemId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.mediaItemId, list);
  }
  return map;
}

export async function fetchPerformersByItemIds(
  itemIds: number[]
): Promise<Map<number, { id: number; name: string }[]>> {
  if (itemIds.length === 0) return new Map();

  const rows = await db
    .select({
      mediaItemId: mediaItemPerformers.mediaItemId,
      id: performers.id,
      name: performers.name,
    })
    .from(mediaItemPerformers)
    .innerJoin(performers, eq(performers.id, mediaItemPerformers.performerId))
    .where(inArray(mediaItemPerformers.mediaItemId, itemIds));

  const map = new Map<number, { id: number; name: string }[]>();
  for (const row of rows) {
    const list = map.get(row.mediaItemId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.mediaItemId, list);
  }
  return map;
}

export type RelatedMaps = {
  tagsByItemId: Map<number, { id: number; name: string; color: string | null }[]>;
  performersByItemId: Map<number, { id: number; name: string }[]>;
};

/**
 * Both side-lookups for a page of items, in parallel — so adding performers
 * costs no extra wall-clock time over fetching tags alone. Passed around as
 * one object rather than two arguments so a call site can't supply one and
 * silently forget the other.
 */
export async function fetchRelated(itemIds: number[]): Promise<RelatedMaps> {
  const [tagsByItemId, performersByItemId] = await Promise.all([
    fetchTagsByItemIds(itemIds),
    fetchPerformersByItemIds(itemIds),
  ]);
  return { tagsByItemId, performersByItemId };
}

export function withComputedFields<T extends { id: number; itemType: string; extraMetadata: unknown }>(
  item: T,
  related: RelatedMaps
) {
  return {
    ...item,
    playbackWarning: playbackWarningFor(
      item.itemType,
      item.extraMetadata as Record<string, unknown> | null
    ),
    tags: related.tagsByItemId.get(item.id) ?? [],
    performers: related.performersByItemId.get(item.id) ?? [],
  };
}

/**
 * Adds the watch state on top of the computed fields, normalising the nulls a
 * LEFT JOIN produces for anything never played.
 */
export function withPlayback<
  T extends {
    id: number;
    itemType: string;
    extraMetadata: unknown;
    lastPositionSeconds: number | null;
    watchedAt: Date | null;
    playCount: number | null;
  },
>(row: T, related: RelatedMaps) {
  return {
    ...withComputedFields(row, related),
    lastPositionSeconds: row.lastPositionSeconds ?? 0,
    watchedAt: row.watchedAt ?? null,
    watched: row.watchedAt != null,
    playCount: row.playCount ?? 0,
  };
}

/** Conflict-tolerant so concurrent saves of a new studio name can't collide. */
export async function ensureStudioId(rawName: string): Promise<number> {
  const name = rawName.normalize("NFC").replace(/\s+/g, " ").trim();

  const findId = async (): Promise<number | null> => {
    const [row] = await db
      .select({ id: studios.id })
      .from(studios)
      .where(sql`lower(${studios.name}) = lower(${name})`);
    return row?.id ?? null;
  };

  const existing = await findId();
  if (existing !== null) return existing;

  const [created] = await db.insert(studios).values({ name }).onConflictDoNothing().returning();
  if (created) return created.id;

  const raced = await findId();
  if (raced === null) throw new Error(`Could not resolve studio "${name}"`);
  return raced;
}
