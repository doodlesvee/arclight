import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { visibleItems } from "../library/visibility.js";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  categories,
  mediaFiles,
  mediaItemPerformers,
  mediaItemTags,
  mediaItems,
  mediaItemTypes,
  performers,
  playbackStates,
  studios,
  tags,
} from "../db/schema.js";
import { playbackWarningFor } from "../media/compatibility.js";
import { getHeroSettings, getKindCovers, setKindCover } from "./settings.js";
import { deleteKindCover, kindCoverPath, saveKindCover } from "../media/kindCovers.js";
import { streamFile } from "../media/streamer.js";

const PAGE_SIZE = 50;

// Anything that reads back a video's watch state selects these together, so a
// query can't accidentally return the position without the watched flag.
const playbackColumns = {
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
const WATCHED_PERCENT = 92;

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
const fileSizeExpr = sql`(
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
const RESOLUTIONS: Record<string, { min: number; max: number | null }> = {
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
function randomOrder(seed: number): SQL[] {
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
function searchOrder(search: string): SQL[] {
  const phrase = `%${escapeLike(search)}%`;
  return [
    sql`(case when ${mediaItems.title} ilike ${phrase} then 0 else 1 end)`,
    desc(mediaItems.createdAt),
    desc(mediaItems.id),
  ];
}

function orderFor(sort: string | undefined, randomSeed: number): SQL[] {
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
function clampPercent(value: number, min: number, max: number): number {
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
const MAX_SEARCH_TERMS = 6;

function searchTerms(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
}

// `%` and `_` are LIKE wildcards, and a filename legitimately contains both.
// Unescaped, searching for `Scene_01` would also match `Scene-01`.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const RELATED_LIMIT = 8;

/** How many stills the video modal previews before handing off to the album. */
const GALLERY_PREVIEW_LIMIT = 8;
const HERO_LIMIT = 5;

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
async function categorySlugs(): Promise<Set<string>> {
  const rows = await db.select({ slug: categories.slug }).from(categories);
  return new Set(rows.map((r) => r.slug));
}

const itemColumns = {
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

async function fetchTagsByItemIds(
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

async function fetchPerformersByItemIds(
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

type RelatedMaps = {
  tagsByItemId: Map<number, { id: number; name: string; color: string | null }[]>;
  performersByItemId: Map<number, { id: number; name: string }[]>;
};

/**
 * Both side-lookups for a page of items, in parallel — so adding performers
 * costs no extra wall-clock time over fetching tags alone. Passed around as
 * one object rather than two arguments so a call site can't supply one and
 * silently forget the other.
 */
async function fetchRelated(itemIds: number[]): Promise<RelatedMaps> {
  const [tagsByItemId, performersByItemId] = await Promise.all([
    fetchTagsByItemIds(itemIds),
    fetchPerformersByItemIds(itemIds),
  ]);
  return { tagsByItemId, performersByItemId };
}

function withComputedFields<T extends { id: number; itemType: string; extraMetadata: unknown }>(
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
function withPlayback<
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
async function ensureStudioId(rawName: string): Promise<number> {
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

export async function mediaItemRoutes(app: FastifyInstance): Promise<void> {
  // Backs the category tiles on the home page.
  app.get("/api/kinds", async () => {
    const rows = await db
      .select({
        kind: mediaItems.kind,
        total: sql<number>`count(*)::int`,
        // Newest item of that kind, for the tile's backdrop.
        representativeItemId: sql<number | null>`max(${mediaItems.id})`,
      })
      .from(mediaItems)
      .where(visibleItems())
      .groupBy(mediaItems.kind);

    const byKind = new Map(rows.map((r) => [r.kind, r]));
    const covers = await getKindCovers();
    const slugs = [...(await categorySlugs())];
    return {
      kinds: slugs.map((kind) => ({
        kind,
        total: byKind.get(kind)?.total ?? 0,
        representativeItemId: byKind.get(kind)?.representativeItemId ?? null,
        // Folded into the URL so replacing a cover changes it, letting the
        // response be cached hard.
        cover: covers[kind] ? `/api/kinds/${kind}/cover?v=${covers[kind]}` : null,
      })),
    };
  });

  app.get<{ Params: { kind: string } }>("/api/kinds/:kind/cover", async (request, reply) => {
    const covers = await getKindCovers();
    const fileName = covers[request.params.kind];
    if (!fileName) {
      reply.code(404);
      return { error: "No cover" };
    }
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    await streamFile(reply, kindCoverPath(fileName), "image/jpeg", undefined, false);
  });

  app.post<{ Params: { kind: string } }>("/api/kinds/:kind/cover", async (request, reply) => {
    const kind = request.params.kind;
    if (!(await categorySlugs()).has(kind)) {
      reply.code(400);
      return { error: "Unknown category" };
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
      reply.code(413);
      return { error: "Image is too large" };
    }

    let fileName: string;
    try {
      fileName = await saveKindCover(buffer, kind);
    } catch {
      reply.code(400);
      return { error: "That file could not be read as an image" };
    }

    const previous = (await getKindCovers())[kind];
    await setKindCover(kind, fileName);
    // Only after the setting points at the new file, so a failure here leaves
    // a stray file rather than a broken reference.
    await deleteKindCover(previous);

    return { ok: true };
  });

  app.delete<{ Params: { kind: string } }>("/api/kinds/:kind/cover", async (request, reply) => {
    const kind = request.params.kind;
    if (!(await categorySlugs()).has(kind)) {
      reply.code(400);
      return { error: "Unknown category" };
    }
    const previous = (await getKindCovers())[kind];
    await setKindCover(kind, null);
    await deleteKindCover(previous);
    return { ok: true };
  });

  app.get<{
    Querystring: {
      libraryId?: string;
      type?: string;
      tag?: string;
      performer?: string;
      favorite?: string;
      kind?: string;
      studio?: string;
      parentId?: string;
      q?: string;
      page?: string;
      sort?: string;
      year?: string;
      noStudio?: string;
      noYear?: string;
      progress?: string;
      tags?: string;
      performers?: string;
      watched?: string;
      minDuration?: string;
      maxDuration?: string;
      resolution?: string;
      format?: string;
      addedWithin?: string;
      month?: string;
      seed?: string;
      minRating?: string;
    };
  }>("/api/media-items", async (request) => {
    const {
      libraryId,
      type,
      tag,
      performer,
      favorite,
      studio,
      kind,
      parentId,
      q,
      page,
      sort,
      year,
      noStudio,
      noYear,
      progress,
      tags: tagList,
      performers: performerList,
      watched,
      minDuration,
      maxDuration,
      resolution,
      format,
      addedWithin,
      month,
      seed,
    } = request.query;
    const pageNum = Math.max(1, Number(page) || 1);
    const search = q?.trim();
    // The client sends a seed so a shuffled grid keeps one order across its
    // pages; without one, each page would be shuffled separately.
    const randomSeed = Number.isFinite(Number(seed)) ? Number(seed) : 0;

    // Items whose folder was removed from the scan list stay in the database
    // but drop out of every view, so removing a folder reads as a clean slate.
    const conditions: SQL[] = [visibleItems()];
    if (libraryId) {
      conditions.push(eq(mediaItems.libraryId, Number(libraryId)));
    }
    if (type) {
      conditions.push(eq(mediaItemTypes.name, type));
    } else {
      // Photos are gallery images belonging to the video they sit beside, not
      // library items in their own right — a studio folder holds a scene and
      // its stills. They're reachable through an item's gallery instead, and
      // still addressable here by asking for them explicitly with ?type=photo.
      conditions.push(ne(mediaItemTypes.name, "photo"));
    }
    if (search) {
      // Every word must match something, but each is free to match a
      // different field — "caprice vixen" is a performer and a studio, and
      // treating the whole query as one literal substring (as this used to)
      // found nothing at all for it.
      //
      // Titles here are machine-derived from filenames and often unhelpful,
      // so searching only them misses the names people actually remember.
      // Studio comes free — it's already left-joined for the studio filter.
      for (const term of searchTerms(search)) {
        const pattern = `%${escapeLike(term)}%`;

        const performerMatches = db
          .select({ id: mediaItemPerformers.mediaItemId })
          .from(mediaItemPerformers)
          .innerJoin(performers, eq(performers.id, mediaItemPerformers.performerId))
          .where(ilike(performers.name, pattern));
        const tagMatches = db
          .select({ id: mediaItemTags.mediaItemId })
          .from(mediaItemTags)
          .innerJoin(tags, eq(tags.id, mediaItemTags.tagId))
          .where(ilike(tags.name, pattern));

        const fields = [
          ilike(mediaItems.title, pattern),
          ilike(mediaItems.description, pattern),
          ilike(studios.name, pattern),
          inArray(mediaItems.id, performerMatches),
          inArray(mediaItems.id, tagMatches),
        ];
        // A bare four-digit word is almost certainly a year, so let it match
        // the release date too — "2019 caprice" then works as you'd expect.
        if (/^\d{4}$/.test(term)) {
          fields.push(sql`extract(year from ${mediaItems.releaseDate}) = ${Number(term)}`);
        }

        const match = or(...fields);
        if (match) conditions.push(match);
      }
    }
    if (tag) {
      const matchingItemIds = db
        .select({ id: mediaItemTags.mediaItemId })
        .from(mediaItemTags)
        .innerJoin(tags, eq(tags.id, mediaItemTags.tagId))
        .where(eq(tags.name, tag));
      conditions.push(inArray(mediaItems.id, matchingItemIds));
    }
    if (performer) {
      const matchingItemIds = db
        .select({ id: mediaItemPerformers.mediaItemId })
        .from(mediaItemPerformers)
        .innerJoin(performers, eq(performers.id, mediaItemPerformers.performerId))
        // lower(...) = lower(...) rather than eq, so a hand-typed
        // ?performer=alice still resolves, and rather than ilike, which would
        // treat `_` in a name as a wildcard.
        .where(sql`lower(${performers.name}) = lower(${performer})`);
      conditions.push(inArray(mediaItems.id, matchingItemIds));
    }
    // No allow-list here on purpose. A filter for a category that doesn't
    // exist should return nothing — returning everything, which is what the
    // stale constant caused, made one tile show the whole library and look
    // like every video had been duplicated across categories.
    if (kind) {
      conditions.push(eq(mediaItems.kind, kind));
    }
    if (studio) {
      conditions.push(sql`lower(${studios.name}) = lower(${studio})`);
    }
    const yearNum = Number(year);
    const filterYear = year && Number.isInteger(yearNum) ? yearNum : null;
    if (filterYear !== null) {
      conditions.push(sql`extract(year from ${mediaItems.releaseDate}) = ${filterYear}`);
    }

    // Only meaningful alongside a year — "March" across every year is a
    // question nobody asks of a library, and the timeline never offers it.
    const monthNum = Number(month);
    const filterMonth =
      filterYear !== null && Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12
        ? monthNum
        : null;
    if (filterMonth !== null) {
      conditions.push(sql`extract(month from ${mediaItems.releaseDate}) = ${filterMonth}`);
    }

    // Explicit "unset" filters, so a grouped view can show the items that
    // belong to no group. A sentinel like `studio=none` would collide with a
    // studio genuinely called "none"; a separate flag cannot.
    const unsetStudio = noStudio === "true";
    if (unsetStudio) conditions.push(isNull(mediaItems.studioId));
    const unsetYear = noYear === "true";
    if (unsetYear) conditions.push(isNull(mediaItems.releaseDate));

    // Part-watched only. /api/continue-watching is global and can't be scoped
    // to one performer, which is what a profile page needs.
    const inProgressOnly = progress === "in-progress";
    if (inProgressOnly) {
      conditions.push(
        sql`exists (
          select 1 from ${playbackStates} ps
          where ps.media_item_id = ${mediaItems.id}
            and ps.position_seconds > 15
            and ps.completed_at is null
        )`
      );
    }
    // "At least this many stars". Unrated items fail the comparison (NULL >=
    // n is not true), which is the point: asking for 4+ is asking for things
    // you rated, not things you haven't got round to.
    const ratingFloor = Number(request.query.minRating);
    if (Number.isInteger(ratingFloor) && ratingFloor >= 1 && ratingFloor <= 5) {
      conditions.push(gte(mediaItems.rating, ratingFloor));
    }
    const favoritesOnly = favorite === "true";
    if (favoritesOnly) {
      conditions.push(eq(mediaItems.isFavorite, true));
    }

    /**
     * The composable half of §7.
     *
     * These stack with each other and with the single-value filters above,
     * because every entry in `conditions` is ANDed. The multi-value ones are
     * AND too, not OR: picking two tags means "has both", which is the only
     * reading under which adding a filter ever narrows the result. OR would
     * make each extra tag return *more*, which is not what a filter is.
     */
    const csv = (value: string | undefined): string[] =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        // Capped for the same reason the search terms are: a hand-built URL
        // should not be able to ask for a hundred subselects.
        .slice(0, 10);

    for (const name of csv(tagList)) {
      conditions.push(
        inArray(
          mediaItems.id,
          db
            .select({ id: mediaItemTags.mediaItemId })
            .from(mediaItemTags)
            .innerJoin(tags, eq(tags.id, mediaItemTags.tagId))
            .where(sql`lower(${tags.name}) = lower(${name})`)
        )
      );
    }
    for (const name of csv(performerList)) {
      conditions.push(
        inArray(
          mediaItems.id,
          db
            .select({ id: mediaItemPerformers.mediaItemId })
            .from(mediaItemPerformers)
            .innerJoin(performers, eq(performers.id, mediaItemPerformers.performerId))
            .where(sql`lower(${performers.name}) = lower(${name})`)
        )
      );
    }

    // Tri-state: absent means "either", which is not the same as false.
    const watchedFilter =
      watched === "true" ? true : watched === "false" ? false : null;
    if (watchedFilter === true) {
      conditions.push(isNotNull(playbackStates.completedAt));
    } else if (watchedFilter === false) {
      // Never played at all is unwatched too, so this cannot be a plain
      // `is null` on the joined row — that reads as false for both.
      conditions.push(
        sql`not exists (
          select 1 from ${playbackStates} ps
          where ps.media_item_id = ${mediaItems.id}
            and ps.completed_at is not null
        )`
      );
    }

    const minSeconds = Number(minDuration);
    if (Number.isFinite(minSeconds) && minSeconds > 0) {
      conditions.push(sql`${mediaItems.durationSeconds} >= ${Math.round(minSeconds)}`);
    }
    const maxSeconds = Number(maxDuration);
    if (Number.isFinite(maxSeconds) && maxSeconds > 0) {
      conditions.push(sql`${mediaItems.durationSeconds} <= ${Math.round(maxSeconds)}`);
    }

    const band = resolution ? RESOLUTIONS[resolution.toLowerCase()] : undefined;
    if (band) {
      // Height comes out of the probe metadata rather than a column, so it is
      // read from the JSON. Cast explicitly: a JSON number compared against
      // an integer parameter is a type error in Postgres, not a coercion.
      conditions.push(
        sql`(${mediaItems.extraMetadata} ->> 'height')::int >= ${band.min}`
      );
      if (band.max !== null) {
        conditions.push(
          sql`(${mediaItems.extraMetadata} ->> 'height')::int < ${band.max}`
        );
      }
    }

    if (format) {
      conditions.push(
        sql`lower(${mediaItems.extraMetadata} ->> 'containerFormat') = lower(${format})`
      );
    }

    const withinDays = Number(addedWithin);
    if (Number.isFinite(withinDays) && withinDays > 0) {
      conditions.push(
        sql`${mediaItems.createdAt} >= now() - make_interval(days => ${Math.round(withinDays)})`
      );
    }
    // With no global filter, default to the current folder level (root when
    // parentId is omitted) so nested items don't leak into the top view. Tag,
    // performer and search all deliberately ignore folder nesting — they're
    // global lookups, you shouldn't have to drill into folders to hit them.
    //
    // Every filter has to be listed: one that is missed here silently gets
    // scoped to the root folder, which reads as the filter matching almost
    // nothing rather than as a folder default being applied.
    const anyGlobalFilter =
      Boolean(tag) ||
      Boolean(performer) ||
      Boolean(search) ||
      favoritesOnly ||
      Boolean(studio) ||
      Boolean(kind) ||
      filterYear !== null ||
      unsetStudio ||
      unsetYear ||
      inProgressOnly ||
      csv(tagList).length > 0 ||
      csv(performerList).length > 0 ||
      watchedFilter !== null ||
      (Number.isFinite(minSeconds) && minSeconds > 0) ||
      (Number.isFinite(maxSeconds) && maxSeconds > 0) ||
      Boolean(band) ||
      Boolean(format) ||
      (Number.isFinite(withinDays) && withinDays > 0);

    if (!anyGlobalFilter) {
      conditions.push(
        parentId ? eq(mediaItems.parentId, Number(parentId)) : isNull(mediaItems.parentId)
      );
    }

    const query = db
      .select({ ...itemColumns, ...playbackColumns })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id));

    // Fetching one extra row answers "is there another page?" without a
    // second COUNT(*) over the same filtered set.
    const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .orderBy(
        ...(search && (!sort || sort === "newest")
          ? searchOrder(search)
          : orderFor(sort, randomSeed))
      )
      .limit(PAGE_SIZE + 1)
      .offset((pageNum - 1) * PAGE_SIZE);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const related = await fetchRelated(pageRows.map((r) => r.id));

    /**
     * How many rows match, for the "N items" line above the grid.
     *
     * Only on the first page, and only when there is a second: paging already
     * knows the answer from `hasMore` plus what it has, so counting again on
     * every page would be one extra aggregate per scroll for a number that
     * does not change. The same discipline the gallery endpoint uses.
     *
     * A real COUNT rather than an estimate, because the number sits next to
     * the grid it describes and "about 140" invites you to check.
     */
    let total: number | undefined;
    if (pageNum === 1) {
      if (!hasMore) {
        total = pageRows.length;
      } else {
        const counter = db
          .select({ total: sql<number>`count(*)::int` })
          .from(mediaItems)
          .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
          .leftJoin(studios, eq(studios.id, mediaItems.studioId))
          .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id));
        const [counted] = await (conditions.length > 0
          ? counter.where(and(...conditions))
          : counter);
        total = counted?.total;
      }
    }

    return {
      items: pageRows.map((r) => withPlayback(r, related)),
      page: pageNum,
      pageSize: PAGE_SIZE,
      hasMore,
      total,
    };
  });

  /**
   * Type-ahead suggestions: the named things a query could mean, plus a few
   * matching titles.
   *
   * Performers and studios come first because they're what you actually
   * remember — the titles are machine-derived from filenames and rarely what
   * you'd type. Picking one navigates to that filter rather than running a
   * text search, so "Little Caprice" lands on her exact set instead of every
   * item whose filename happens to contain those words.
   *
   * Only the first term is used: suggestions are for completing what you're
   * typing now, not for re-running the whole query.
   */
  app.get<{ Querystring: { q?: string } }>("/api/search/suggestions", async (request) => {
    const raw = request.query.q?.trim() ?? "";
    if (raw.length < 2) return { performers: [], studios: [], items: [] };

    const pattern = `%${escapeLike(raw)}%`;
    const LIMIT = 5;

    // Enough for performerPortraitUrl to resolve a face: an uploaded photo
    // if there is one, otherwise a frame from their newest video.
    //
    // A LEFT JOIN with GROUP BY rather than correlated subqueries in the
    // select list: drizzle renders `performers.id` unqualified when the outer
    // query has a single table, which inside a subquery collides with the
    // joined tables' own `id` and fails as an ambiguous column reference.
    // This is the same shape GET /api/performers already uses.
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
        // count(<column>) not count(*): a LEFT JOIN with no match would
        // otherwise count the NULL-padded row and report 1.
        videoCount: sql<number>`count(${mediaItems.id})::int`,
      })
      .from(performers)
      .leftJoin(mediaItemPerformers, eq(mediaItemPerformers.performerId, performers.id))
      .leftJoin(
        mediaItems,
        and(eq(mediaItems.id, mediaItemPerformers.mediaItemId), visibleItems())
      )
      .where(ilike(performers.name, pattern))
      .groupBy(
        performers.id,
        performers.name,
        performers.imageFile,
        performers.bannerFile,
        performers.imagePositionX,
        performers.imagePositionY,
        performers.imageScale,
        performers.avatarPositionX,
        performers.avatarPositionY,
        performers.avatarScale
      )
      .orderBy(sql`lower(${performers.name})`)
      .limit(LIMIT);

    const studioRows = await db
      .select({ id: studios.id, name: studios.name })
      .from(studios)
      .where(ilike(studios.name, pattern))
      .orderBy(sql`lower(${studios.name})`)
      .limit(LIMIT);

    const itemRows = await db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        description: mediaItems.description,
        // Part of the thumbnail URL's cache-busting token, so a replaced
        // thumbnail shows here too rather than staying stale for a year.
        thumbnailFile: mediaItems.thumbnailFile,
        thumbnailPositionX: mediaItems.thumbnailPositionX,
        thumbnailPositionY: mediaItems.thumbnailPositionY,
        thumbnailScale: mediaItems.thumbnailScale,
        tileShape: mediaItems.tileShape,
        releaseDate: mediaItems.releaseDate,
      })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .where(
        and(
          visibleItems(),
          ne(mediaItemTypes.name, "photo"),
          ilike(mediaItems.title, pattern)
        )
      )
      .orderBy(desc(mediaItems.createdAt))
      .limit(LIMIT);

    // One batched lookup rather than a query per row — the same helper the
    // listing endpoints use.
    const performersByItemId = await fetchPerformersByItemIds(itemRows.map((r) => r.id));

    return {
      performers: performerRows,
      studios: studioRows,
      items: itemRows.map((row) => ({
        ...row,
        performers: performersByItemId.get(row.id) ?? [],
      })),
    };
  });

  /**
   * Release years present in the library, newest first, for the year filter.
   *
   * A dedicated endpoint rather than deriving it client-side: the grid is
   * paginated, so the client only ever holds one page and could never see
   * every year from it.
   */
  app.get("/api/release-years", async () => {
    const rows = await db
      .select({
        year: sql<number>`extract(year from ${mediaItems.releaseDate})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .where(
        and(
          visibleItems(),
          ne(mediaItemTypes.name, "photo"),
          isNotNull(mediaItems.releaseDate)
        )
      )
      .groupBy(sql`extract(year from ${mediaItems.releaseDate})`)
      .orderBy(sql`extract(year from ${mediaItems.releaseDate}) desc`);

    return { years: rows };
  });

  /**
   * A month-by-month histogram for timeline navigation (§14).
   *
   * Release date rather than the date a file was scanned: a timeline of a
   * library is about when the material is from, and "added" would collapse
   * to a spike on whichever day the initial scan ran.
   *
   * One row per month, newest first, with the years derivable by grouping
   * client-side. Returning nested years would mean the client could not
   * render a flat list without flattening it again, and a library covers
   * decades at most — a few hundred rows, once.
   */
  app.get("/api/timeline", async () => {
    const rows = await db
      .select({
        year: sql<number>`extract(year from ${mediaItems.releaseDate})::int`,
        month: sql<number>`extract(month from ${mediaItems.releaseDate})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .where(
        and(
          visibleItems(),
          ne(mediaItemTypes.name, "photo"),
          isNotNull(mediaItems.releaseDate)
        )
      )
      .groupBy(
        sql`extract(year from ${mediaItems.releaseDate})`,
        sql`extract(month from ${mediaItems.releaseDate})`
      )
      .orderBy(
        sql`extract(year from ${mediaItems.releaseDate}) desc`,
        sql`extract(month from ${mediaItems.releaseDate}) desc`
      );

    return { months: rows };
  });

  // Resolves the hero setting into actual items, so the homepage doesn't have
  // to know how the setting is shaped.
  app.get("/api/hero-items", async () => {
    const hero = await getHeroSettings();

    const base = db
      .select({ ...itemColumns, ...playbackColumns })
      .from(mediaItems)
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .leftJoin(playbackStates, eq(playbackStates.mediaItemId, mediaItems.id));

    let rows;
    if (hero.source === "manual") {
      if (hero.itemIds.length === 0) return { items: [] };
      const found = await base.where(
        and(
          eq(mediaItemTypes.name, "video"),
          visibleItems(),
          inArray(mediaItems.id, hero.itemIds)
        )
      );
      // Preserve the order you arranged them in, which SQL wouldn't.
      const byId = new Map(found.map((r) => [r.id, r]));
      rows = hero.itemIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    } else if (hero.source === "favorites") {
      rows = await base
        .where(
          and(
            eq(mediaItemTypes.name, "video"),
            visibleItems(),
            eq(mediaItems.isFavorite, true)
          )
        )
        .orderBy(desc(mediaItems.createdAt))
        .limit(HERO_LIMIT);
    } else {
      rows = await base
        .where(
          and(
            eq(mediaItemTypes.name, "video"),
            eq(mediaItems.inScope, true),
            isNull(mediaItems.missingSince)
          )
        )
        .orderBy(desc(mediaItems.createdAt))
        .limit(HERO_LIMIT);
    }

    const related = await fetchRelated(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        ...withPlayback(r, related),
      })),
    };
  });

  // Backs the "Continue Watching" row — anything with real progress that
  // isn't essentially finished, most recently watched first.
  app.get("/api/continue-watching", async () => {
    const rows = await db
      .select({ ...itemColumns, ...playbackColumns })
      .from(playbackStates)
      .innerJoin(mediaItems, eq(mediaItems.id, playbackStates.mediaItemId))
      .innerJoin(mediaItemTypes, eq(mediaItems.itemTypeId, mediaItemTypes.id))
      .leftJoin(studios, eq(studios.id, mediaItems.studioId))
      .where(
        and(
          gt(playbackStates.positionSeconds, 15),
          visibleItems(),
          // Finished videos drop out of the row rather than sitting at the
          // front of it forever. A video with no known duration is kept —
          // better a stale entry than silently hiding something.
          isNull(playbackStates.completedAt),
          sql`(${mediaItems.durationSeconds} is null or ${playbackStates.positionSeconds} * 100 < ${mediaItems.durationSeconds} * ${WATCHED_PERCENT})`
        )
      )
      .orderBy(desc(playbackStates.updatedAt))
      .limit(RELATED_LIMIT);

    const related = await fetchRelated(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        ...withPlayback(r, related),
      })),
    };
  });

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
    return { ok: true };
  });
}
