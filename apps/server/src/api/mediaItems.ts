import {
  type SQL,
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { type FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  mediaItemPerformers,
  mediaItemTags,
  mediaItemTypes,
  mediaItems,
  performers,
  playbackStates,
  studios,
  tags,
} from "../db/schema.js";
import { visibleItems } from "../library/visibility.js";
import {
  PAGE_SIZE,
  RESOLUTIONS,
  escapeLike,
  fetchPerformersByItemIds,
  fetchRelated,
  itemColumns,
  orderFor,
  playbackColumns,
  searchOrder,
  searchTerms,
  withPlayback,
} from "./mediaItemQueries.js";

export async function mediaItemRoutes(app: FastifyInstance): Promise<void> {
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
      // Archived performers stay findable through their videos, just not
      // suggested by name.
      .where(and(ilike(performers.name, pattern), isNull(performers.archivedAt)))
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
}
