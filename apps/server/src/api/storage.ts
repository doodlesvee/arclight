import path from "node:path";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { libraryRoots } from "../db/schema.js";

type GroupRow = {
  id: number | null;
  name: string | null;
  items: string;
  videos: string;
  photos: string;
  bytes: string;
  rep_id: number | null;
  rep_thumbnail_file: string | null;
};

type PerformerRow = GroupRow & {
  has_image: boolean;
  has_banner: boolean;
  image_position_x: number;
  image_position_y: number;
  image_scale: number;
};

/** How many studios or performers get their own bar before the rest fold into "Everything else". */
const TOP_GROUPS = 10;
const LARGEST_LIMIT = 15;
const COPY_GROUP_LIMIT = 20;
/** Folders shown as their own block before the rest fold together. */
const TREEMAP_FOLDER_LIMIT = 60;

export type TreemapNode = {
  name: string;
  /** Null for blocks that are not a folder you can open. */
  path: string | null;
  bytes: number;
  files: number;
};

/**
 * Height bands, matching the resolution filter's (see RESOLUTIONS in
 * mediaItems.ts): each boundary sits below the nominal height, so a 1078px
 * encode is still Full HD.
 */
const RESOLUTION_BANDS = [
  { key: "4k", label: "4K", min: 1800 },
  { key: "fullhd", label: "Full HD", min: 1000 },
  { key: "hd", label: "HD", min: 700 },
  { key: "sd", label: "SD", min: 1 },
] as const;

/**
 * A studio or performer with its share of the space. `representative` is the
 * group's largest video, for a picture: studios have no artwork of their
 * own, and the biggest file is the one the numbers are mostly about.
 */
type Group = {
  id: number | null;
  name: string;
  bytes: number;
  items: number;
  videos: number;
  photos: number;
  representative: { id: number; thumbnailFile: string | null } | null;
};

/**
 * Keeps the biggest groups and folds the long tail into one row.
 *
 * A bar per studio stops being readable somewhere past ten, and the tail is
 * mostly single-video studios nobody is deciding anything about. The total is
 * still right, because the tail is summed rather than dropped.
 */
function topWithRest<T extends Group>(rows: T[]): T[] {
  if (rows.length <= TOP_GROUPS + 1) return rows;
  const rest = rows.slice(TOP_GROUPS).reduce(
    (sum, row) => ({
      ...sum,
      bytes: sum.bytes + row.bytes,
      items: sum.items + row.items,
      videos: sum.videos + row.videos,
      photos: sum.photos + row.photos,
    }),
    { id: null, name: "Everything else", bytes: 0, items: 0, videos: 0, photos: 0, representative: null } as Group,
  );
  return [...rows.slice(0, TOP_GROUPS), rest] as T[];
}

/**
 * Where the disk space goes (§17's cache dashboard covers the app's own
 * files; this is the library itself).
 *
 * Every figure is over visible items only — in a scanned folder and still on
 * disk — so the numbers agree with what the library shows. An item's size is
 * the sum of its files, since a video can carry stills beside it.
 *
 * Read-only by design, like duplicates: the app never deletes originals, so
 * this can tell you what is worth removing but the removing is yours.
 */
export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/storage/insights", async () => {
    // One CTE for "visible item and its size", shared by every query below,
    // so the definition of both cannot drift between the panels.
    const sized = sql`
      with sized as (
        select
          mi.id,
          mi.title,
          mi.studio_id,
          mi.release_date,
          mi.duration_seconds,
          mi.thumbnail_file,
          mi.thumbnail_position_x,
          mi.thumbnail_position_y,
          mi.thumbnail_scale,
          mit.name as item_type,
          nullif(mi.extra_metadata ->> 'height', '')::int as height,
          coalesce((select sum(mf.size_bytes) from media_files mf where mf.media_item_id = mi.id), 0)::bigint as bytes
        from media_items mi
        join media_item_types mit on mit.id = mi.item_type_id
        where mi.in_scope = true and mi.missing_since is null and mit.name in ('video', 'photo')
      )`;

    // Counted apart because they are not comparable: one studio's "8" is
    // eight scenes, another's "2620" is mostly the stills beside them.
    const typeCounts = sql`
      count(*) filter (where sized.item_type = 'video') as videos,
      count(*) filter (where sized.item_type = 'photo') as photos`;
    // The group's largest video, preferring any video over a still: a studio
    // pictured by one of its gallery photos reads as a different thing.
    const representative = sql`
      (array_agg(sized.id order by (sized.item_type = 'video') desc, sized.bytes desc))[1] as rep_id,
      (array_agg(sized.thumbnail_file order by (sized.item_type = 'video') desc, sized.bytes desc))[1] as rep_thumbnail_file`;

    const [totals, studios, performers, resolutions, largest, copies, years] = await Promise.all([
      db.execute<{ item_type: string; items: string; bytes: string; seconds: string | null }>(sql`
        ${sized}
        select item_type, count(*) as items, sum(bytes) as bytes, sum(duration_seconds) as seconds
        from sized group by item_type
      `),
      db.execute<GroupRow>(sql`
        ${sized}
        select s.id, s.name, count(*) as items, ${typeCounts}, sum(sized.bytes) as bytes, ${representative}
        from sized left join studios s on s.id = sized.studio_id
        group by s.id, s.name
        order by sum(sized.bytes) desc
      `),
      // An item with two performers counts towards both, so these bars can
      // add up to more than the library. That is the honest answer to "how
      // much space is this performer's" — splitting a file in half between
      // them would be a number that means nothing.
      db.execute<PerformerRow>(sql`
        ${sized}
        select
          p.id, p.name, count(*) as items, ${typeCounts}, sum(sized.bytes) as bytes, ${representative},
          (p.image_file is not null) as has_image,
          (p.banner_file is not null) as has_banner,
          p.image_position_x, p.image_position_y, p.image_scale
        from sized
        join media_item_performers mip on mip.media_item_id = sized.id
        join performers p on p.id = mip.performer_id
        group by p.id, p.name
        order by sum(sized.bytes) desc
      `),
      db.execute<{ band: string; items: string; bytes: string }>(sql`
        ${sized}
        select
          case
            when height >= 1800 then '4k'
            when height >= 1000 then 'fullhd'
            when height >= 700 then 'hd'
            when height >= 1 then 'sd'
            else 'unknown'
          end as band,
          count(*) as items,
          sum(bytes) as bytes
        from sized
        where item_type = 'video'
        group by band
      `),
      db.execute<{
        id: number;
        title: string;
        bytes: string;
        height: number | null;
        duration_seconds: number | null;
        studio: string | null;
        thumbnail_file: string | null;
        thumbnail_position_x: number;
        thumbnail_position_y: number;
        thumbnail_scale: number;
      }>(sql`
        ${sized}
        select
          sized.id, sized.title, sized.bytes, sized.height, sized.duration_seconds, s.name as studio,
          sized.thumbnail_file, sized.thumbnail_position_x, sized.thumbnail_position_y, sized.thumbnail_scale
        from sized left join studios s on s.id = sized.studio_id
        where item_type = 'video'
        order by sized.bytes desc
        limit ${LARGEST_LIMIT}
      `),
      /*
       * The same scene held at more than one quality.
       *
       * Matched on studio and release date, which a scene's filename almost
       * always carries and which two different scenes almost never share —
       * but "almost" is why the UI calls these possible copies and lists them
       * rather than acting on them. Only groups whose heights actually differ
       * are kept: two identical encodes are what the duplicates check is for.
       */
      db.execute<{
        studio: string;
        release_date: string;
        items: { id: number; title: string; height: number | null; bytes: number; thumbnailFile: string | null }[];
      }>(sql`
        ${sized}
        select
          s.name as studio,
          sized.release_date::text as release_date,
          json_agg(
            json_build_object(
              'id', sized.id, 'title', sized.title, 'height', sized.height, 'bytes', sized.bytes,
              'thumbnailFile', sized.thumbnail_file
            )
            order by sized.height desc nulls last, sized.bytes desc
          ) as items
        from sized join studios s on s.id = sized.studio_id
        where item_type = 'video' and sized.release_date is not null
        group by s.name, sized.release_date
        having count(*) > 1 and count(distinct coalesce(sized.height, 0)) > 1
        order by sized.release_date desc
        limit ${COPY_GROUP_LIMIT}
      `),
      // Space by the year a scene came out: how the library leans towards
      // recent releases or old ones. Undated videos are counted apart rather
      // than dropped, so the chart can say how much it is not showing.
      db.execute<{ year: number | null; items: string; bytes: string }>(sql`
        ${sized}
        select extract(year from release_date)::int as year, count(*) as items, sum(bytes) as bytes
        from sized
        where item_type = 'video'
        group by 1
        order by 1 nulls last
      `),
    ]);

    const toGroup = (row: GroupRow, fallback: string): Group => ({
      id: row.id,
      representative: row.rep_id !== null ? { id: row.rep_id, thumbnailFile: row.rep_thumbnail_file } : null,
      name: row.name ?? fallback,
      items: Number(row.items),
      videos: Number(row.videos),
      photos: Number(row.photos),
      bytes: Number(row.bytes),
    });

    const byType = Object.fromEntries(
      totals.rows.map((row) => [
        row.item_type,
        { items: Number(row.items), bytes: Number(row.bytes), seconds: Number(row.seconds ?? 0) },
      ]),
    );
    const empty = { items: 0, bytes: 0, seconds: 0 };
    const resolutionRows = new Map(resolutions.rows.map((row) => [row.band, row]));

    return {
      totals: {
        videos: byType.video ?? empty,
        photos: byType.photo ?? empty,
        bytes: (byType.video?.bytes ?? 0) + (byType.photo?.bytes ?? 0),
      },
      byStudio: topWithRest(studios.rows.map((row) => toGroup(row, "No studio"))),
      byPerformer: topWithRest(
        performers.rows.map((row) => ({
          ...toGroup(row, "Unknown"),
          hasImage: row.has_image,
          hasBanner: row.has_banner,
          imagePositionX: row.image_position_x,
          imagePositionY: row.image_position_y,
          imageScale: row.image_scale,
        })),
      ),
      byYear: {
        years: years.rows
          .filter((row) => row.year !== null)
          .map((row) => ({ year: row.year as number, items: Number(row.items), bytes: Number(row.bytes) })),
        undated: (() => {
          const row = years.rows.find((entry) => entry.year === null);
          return { items: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0) };
        })(),
      },
      // Always every band, in size order, so the chart's rows do not move
      // around depending on which bands this library happens to have.
      byResolution: [
        ...RESOLUTION_BANDS.map(({ key, label }) => ({ key, label })),
        { key: "unknown", label: "Not probed" },
      ]
        .map(({ key, label }) => {
          const row = resolutionRows.get(key);
          const items = Number(row?.items ?? 0);
          return { key, name: label, items, videos: items, photos: 0, bytes: Number(row?.bytes ?? 0) };
        })
        .filter((row) => row.key !== "unknown" || row.items > 0),
      largest: largest.rows.map((row) => ({
        id: row.id,
        title: row.title,
        bytes: Number(row.bytes),
        height: row.height,
        durationSeconds: row.duration_seconds,
        studio: row.studio,
        thumbnailFile: row.thumbnail_file,
        thumbnailPositionX: row.thumbnail_position_x,
        thumbnailPositionY: row.thumbnail_position_y,
        thumbnailScale: row.thumbnail_scale,
        // Megabits per second: the number that says whether a big file is
        // big because it is long or because it is encoded generously.
        bitrateMbps:
          row.duration_seconds && row.duration_seconds > 0
            ? Math.round(((Number(row.bytes) * 8) / row.duration_seconds / 1_000_000) * 10) / 10
            : null,
      })),
      lowerQualityCopies: copies.rows.map((group) => {
        const items = group.items.map((item) => ({ ...item, bytes: Number(item.bytes) }));
        const best = items[0]?.height ?? 0;
        // Everything below the best copy's height is what removing the
        // lesser copies would free.
        const reclaimableBytes = items
          .filter((item) => (item.height ?? 0) < best)
          .reduce((sum, item) => sum + item.bytes, 0);
        return { studio: group.studio, releaseDate: group.release_date, items, reclaimableBytes };
      }),
    };
  });
  /**
   * One level of the folder tree, sized by what is on disk.
   *
   * Computed from the paths the scanner recorded rather than by walking the
   * disk, so it is quick and agrees with the library's own file counts. With no
   * `path` it returns the watched folders themselves; with one, that folder's
   * subfolders, and the loose files directly inside it as a single block.
   */
  app.get<{ Querystring: { path?: string } }>("/api/storage/treemap", async (request, reply) => {
    const roots = (await db.select({ path: libraryRoots.path }).from(libraryRoots)).map(
      (r) => r.path,
    );

    const rootSize = async (rootPath: string) => {
      const prefix = rootPath.endsWith("/") ? rootPath : rootPath + "/";
      const result = await db.execute<{ files: number; bytes: string }>(sql`
        select count(*)::int as files, coalesce(sum(mf.size_bytes), 0)::bigint as bytes
        from media_files mf
        join media_items mi on mi.id = mf.media_item_id
        where starts_with(mf.path, ${prefix}::text)
          and mi.in_scope = true and mi.missing_since is null
      `);
      const row = result.rows[0];
      return { files: row?.files ?? 0, bytes: Number(row?.bytes ?? 0) };
    };

    const requested = request.query.path;
    if (!requested) {
      const nodes: TreemapNode[] = [];
      for (const rootPath of roots) {
        nodes.push({ name: rootPath, path: rootPath, ...(await rootSize(rootPath)) });
      }
      nodes.sort((a, b) => b.bytes - a.bytes);
      return {
        path: null,
        parent: null,
        nodes: nodes.filter((n) => n.bytes > 0),
        totalBytes: nodes.reduce((sum, n) => sum + n.bytes, 0),
      };
    }

    const target = path.posix.normalize(requested).replace(/\/+$/, "");
    const insideRoot = roots.some((r) => target === r || target.startsWith(r + "/"));
    if (!insideRoot) {
      reply.code(400);
      return { error: "That folder isn't one of the watched folders" };
    }

    const prefix = target + "/";
    const result = await db.execute<{
      segment: string;
      is_dir: boolean;
      files: number;
      bytes: string;
    }>(sql`
      select
        split_part(substr(mf.path, length(${prefix}::text) + 1), '/', 1) as segment,
        (position('/' in substr(mf.path, length(${prefix}::text) + 1)) > 0) as is_dir,
        count(*)::int as files,
        coalesce(sum(mf.size_bytes), 0)::bigint as bytes
      from media_files mf
      join media_items mi on mi.id = mf.media_item_id
      where starts_with(mf.path, ${prefix}::text)
        and mi.in_scope = true and mi.missing_since is null
      group by segment, is_dir
      order by bytes desc
    `);

    const folders: TreemapNode[] = [];
    let loose = { files: 0, bytes: 0 };
    for (const row of result.rows) {
      const bytes = Number(row.bytes);
      if (row.is_dir) {
        folders.push({ name: row.segment, path: prefix + row.segment, bytes, files: row.files });
      } else {
        loose = { files: loose.files + row.files, bytes: loose.bytes + bytes };
      }
    }

    const shown = folders.slice(0, TREEMAP_FOLDER_LIMIT);
    const rest = folders.slice(TREEMAP_FOLDER_LIMIT).reduce(
      (sum, f) => ({ files: sum.files + f.files, bytes: sum.bytes + f.bytes }),
      { files: 0, bytes: 0 },
    );

    const nodes: TreemapNode[] = [...shown];
    if (rest.files > 0) nodes.push({ name: "Smaller folders", path: null, ...rest });
    if (loose.files > 0) nodes.push({ name: "Files in this folder", path: null, ...loose });

    return {
      path: target,
      parent: roots.includes(target) ? null : path.posix.dirname(target),
      nodes: nodes.filter((n) => n.bytes > 0),
      totalBytes: nodes.reduce((sum, n) => sum + n.bytes, 0),
    };
  });
}
