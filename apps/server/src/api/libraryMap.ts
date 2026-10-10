import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import {
  buildLibraryMap,
  type LibraryMapAssociation,
  type LibraryMapKind,
} from "../library/libraryMap.js";

export async function libraryMapRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>("/api/library/map", async (request) => {
    const rows = await db.execute<LibraryMapAssociation>(sql`
      with visible_items as (
        select mi.id, mi.studio_id, mi.album_id, mi.series_id
        from media_items mi
        join media_item_types mit on mit.id = mi.item_type_id
        where mi.in_scope = true
          and mi.missing_since is null
          and mi.hidden_at is null
          and mit.name in ('video', 'photo')
      ), associations as (
        select
          vi.id as "mediaItemId",
          'performer'::text as kind,
          p.id as "entityId",
          p.name
        from visible_items vi
        join media_item_performers mip on mip.media_item_id = vi.id
        join performers p on p.id = mip.performer_id
        where p.archived_at is null

        union all

        select vi.id, 'studio'::text, s.id, s.name
        from visible_items vi
        join studios s on s.id = vi.studio_id

        union all

        select vi.id, 'tag'::text, t.id, t.name
        from visible_items vi
        join media_item_tags mit on mit.media_item_id = vi.id
        join tags t on t.id = mit.tag_id

        union all

        select vi.id, 'album'::text, a.id, a.title
        from visible_items vi
        join albums a on a.id = vi.album_id

        union all

        select vi.id, 'series'::text, s.id, s.name
        from visible_items vi
        join series s on s.id = vi.series_id
      )
      select
        "mediaItemId",
        kind,
        "entityId",
        name
      from associations
      order by kind, lower(name), "entityId"
    `);

    return buildLibraryMap(
      rows.rows.map((row) => ({
        ...row,
        kind: row.kind as LibraryMapKind,
      })),
      request.query.q,
    );
  });
}