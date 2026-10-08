import { readdir, stat } from "node:fs/promises";
import { logActivity } from "../activity/log.js";
import { countRemovableData, purgeRemovableData } from "../library/cleanup.js";
import { DERIVED_DIRS, cacheUsage, clearDerivedCache } from "../media/cache.js";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { libraries, libraryRoots, mediaFiles, mediaItems } from "../db/schema.js";
import { clearScopeForRoot, purgeEmptyEntities, recomputeScope } from "../library/scope.js";

// A container can only see what's mounted into it, so these are the mount
// points the picker is allowed to walk. Anything outside them isn't a
// permissions decision — the path genuinely doesn't exist in here.
const BROWSE_ROOTS = (
  process.env.BROWSE_ROOTS ??
  process.env.MEDIA_ROOT ??
  ["/media", process.env.HOME].filter(Boolean).join(",")
)
  .split(",")
  .map((p) => path.resolve(p.trim()))
  .filter(Boolean);

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT ?? "/media");

function isInsideBrowseRoots(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return BROWSE_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

/** Roots that actually exist right now — an unplugged drive shouldn't show. */
async function availableRoots(): Promise<{ name: string; path: string }[]> {
  const labels: Record<string, string> = {
    [MEDIA_ROOT]: "Media library",
    "/host/home": "Home folder",
    "/host/volumes": "External drives",
  };
  const found = await Promise.all(
    BROWSE_ROOTS.map(async (root) => {
      try {
        const info = await stat(root);
        if (!info.isDirectory()) return null;
        return { name: labels[root] ?? path.basename(root), path: root };
      } catch {
        return null;
      }
    })
  );
  return found.filter((r): r is { name: string; path: string } => r !== null);
}

/** Directories only, skipping the dot/@ entries that are filesystem noise. */
async function listSubdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !/^[.@#]/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/library/roots", async () => {
    const rows = await db
      .select({
        id: libraryRoots.id,
        libraryId: libraryRoots.libraryId,
        path: libraryRoots.path,
      })
      .from(libraryRoots)
      .orderBy(libraryRoots.id);

    // File counts are per-root, not per-library: two roots can share one
    // library, and "how many files came from this folder" is the useful
    // number when deciding whether to remove it.
    const withCounts = await Promise.all(
      rows.map(async (root) => {
        const [counted] = await db
          .select({ files: sql<number>`count(*)::int` })
          .from(mediaFiles)
          .where(sql`${mediaFiles.path} like ${root.path + "/%"}`);
        return {
          ...root,
          files: counted?.files ?? 0,
          // A root outside the mount can never be scanned — it's left over
          // from a previous MEDIA_ROOT and is only useful to delete.
          reachable: isInsideBrowseRoots(root.path),
        };
      })
    );

    return { mediaRoot: MEDIA_ROOT, browseRoots: await availableRoots(), roots: withCounts };
  });

  // Powers the folder browser. Returns children of `path`, defaulting to the
  // mount itself.
  app.get<{ Querystring: { path?: string } }>(
    "/api/library/browse",
    async (request, reply) => {
      if (!request.query.path) {
        const roots = await availableRoots();
        return {
          path: null,
          parent: null,
          directories: roots.map((r) => ({ name: r.name, path: r.path })),
        };
      }
      const target = path.resolve(request.query.path);

      // Guards against ../ escaping the mount — the path arrives from the
      // client, so it can't be trusted even though the UI only sends
      // values it was given.
      if (!isInsideBrowseRoots(target)) {
        reply.code(400);
        return { error: "That folder isn't inside a directory the server can see" };
      }

      try {
        const names = await listSubdirectories(target);
        return {
          path: target,
          // Null at a mount point, so "Up" returns to the root list rather
          // than walking into the container's own filesystem.
          parent: BROWSE_ROOTS.includes(target) ? null : path.dirname(target),
          directories: names.map((name) => ({ name, path: path.join(target, name) })),
        };
      } catch {
        reply.code(404);
        return { error: "Folder not found" };
      }
    }
  );

  app.post<{ Body: { path?: string } }>("/api/library/roots", async (request, reply) => {
    const candidate = request.body.path ? path.resolve(request.body.path) : "";
    if (!candidate || !isInsideBrowseRoots(candidate)) {
      reply.code(400);
      return { error: "Choose a folder the server can see" };
    }

    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) {
        reply.code(400);
        return { error: "That path is not a folder" };
      }
    } catch {
      reply.code(400);
      return { error: "That folder doesn't exist" };
    }

    const existing = await db
      .select({ id: libraryRoots.id, path: libraryRoots.path })
      .from(libraryRoots);

    if (existing.some((r) => r.path === candidate)) {
      reply.code(409);
      return { error: "That folder is already being scanned" };
    }
    // Nesting would scan the same files twice under two roots, and the
    // second pass would fight the first over performer assignment.
    const overlap = existing.find(
      (r) =>
        candidate.startsWith(r.path + path.sep) || r.path.startsWith(candidate + path.sep)
    );
    if (overlap) {
      reply.code(409);
      return { error: `That overlaps a folder already scanned (${overlap.path})` };
    }

    let [library] = await db.select().from(libraries).orderBy(libraries.id).limit(1);
    if (!library) {
      [library] = await db.insert(libraries).values({ name: "Library" }).returning();
    }

    const [created] = await db
      .insert(libraryRoots)
      .values({ libraryId: library.id, path: candidate })
      .returning();

    // Re-attach anything already scanned from this path, so re-adding a folder
    // restores its items instantly rather than waiting for the next scan.
    await recomputeScope();

    return { root: created };
  });

  /**
   * What a removed folder has left behind, and the way to clear it.
   *
   * Separate from the removal itself because the folder is usually long gone
   * by the time you notice its performers and studios still listed.
   */
  /**
   * The duplicate groups behind the count on the health dashboard (§16).
   *
   * Content hash, not filename or size: the point of a duplicate report is
   * to find the same footage stored twice under two different names, which
   * is exactly what a name comparison cannot see.
   *
   * Reports only. §16 is explicit that duplicates are a recommendation and
   * never an automatic deletion, and §29 that originals are read-only to the
   * application — so there is no matching DELETE here, by design. Knowing
   * which paths are duplicates is the whole of what the app can safely offer.
   *
   * Scoped the same way the count is, so the dashboard and this list agree:
   * in-scope videos only. Duplicate stills inside an album are how albums
   * work rather than a fault, and a folder you stopped scanning should not
   * still be reporting problems.
   */
  app.get("/api/library/duplicates", async () => {
    const rows = await db.execute<{
      content_hash: string;
      media_item_id: number;
      title: string;
      path: string;
      size_bytes: string;
      created_at: Date;
    }>(sql`
      select
        mf.content_hash,
        mi.id as media_item_id,
        mi.title,
        mf.path,
        mf.size_bytes,
        mf.created_at
      from media_files mf
      join media_items mi on mi.id = mf.media_item_id
      join media_item_types mit on mit.id = mi.item_type_id
      where mf.content_hash is not null
        and mi.in_scope = true
        and mit.name = 'video'
        and mf.content_hash in (
          select mf2.content_hash
          from media_files mf2
          join media_items mi2 on mi2.id = mf2.media_item_id
          join media_item_types mit2 on mit2.id = mi2.item_type_id
          where mf2.content_hash is not null
            and mi2.in_scope = true
            and mit2.name = 'video'
          group by mf2.content_hash
          having count(*) > 1
        )
      order by mf.content_hash, mf.created_at asc
    `);

    // Grouped here rather than in SQL: Postgres would have to return the
    // members as JSON to group them, and assembling an array in the app is
    // cheaper to read and to change than a json_agg with five keys in it.
    const groups = new Map<
      string,
      {
        contentHash: string;
        files: {
          mediaItemId: number;
          title: string;
          path: string;
          sizeBytes: number;
          discoveredAt: Date;
        }[];
      }
    >();

    for (const row of rows.rows) {
      const group = groups.get(row.content_hash) ?? {
        contentHash: row.content_hash,
        files: [],
      };
      group.files.push({
        mediaItemId: row.media_item_id,
        title: row.title,
        path: row.path,
        sizeBytes: Number(row.size_bytes),
        discoveredAt: row.created_at,
      });
      groups.set(row.content_hash, group);
    }

    const all = [...groups.values()];
    return {
      groups: all,
      // What deleting every copy but the first would free. Stated because a
      // list of hashes does not answer "is this worth my time", which is the
      // question someone opening this page actually has.
      reclaimableBytes: all.reduce(
        (total, group) =>
          total +
          group.files
            .slice(1)
            .reduce((sum, file) => sum + file.sizeBytes, 0),
        0
      ),
    };
  });

  /**
   * What the generated artwork is costing, split from what it isn't (§17).
   */
  app.get("/api/library/cache", async () => {
    const usage = await cacheUsage();
    return {
      entries: usage,
      derivedBytes: usage
        .filter((entry) => entry.kind === "derived")
        .reduce((total, entry) => total + entry.bytes, 0),
      uploadBytes: usage
        .filter((entry) => entry.kind === "upload")
        .reduce((total, entry) => total + entry.bytes, 0),
    };
  });

  /**
   * Deletes generated artwork so the next scan rebuilds it (§17).
   *
   * Takes directory *names*, and `clearDerivedCache` ignores any that are not
   * derived — so the endpoint has no way to reach uploaded artwork whatever
   * it is sent, and no path for a traversal to travel down. Originals are not
   * even addressable from here: this only ever touches APP_DATA_DIR.
   */
  app.post<{ Body: { names?: unknown } }>(
    "/api/library/cache/clear",
    async (request) => {
      const requested = Array.isArray(request.body?.names)
        ? (request.body.names as unknown[]).filter(
            (name): name is string => typeof name === "string"
          )
        : // No list means every derived directory, which is the "Clear cache"
          // button. Uploads are still unreachable — the helper filters them.
          DERIVED_DIRS.map((entry) => entry.name);

      const removed = await clearDerivedCache(requested);
      if (removed > 0) {
        await logActivity("cache", "Generated artwork cleared", {
          files: removed,
          directories: requested,
        });
      }
      return { removed };
    }
  );

  app.get("/api/library/cleanup", async () => {
    return { removable: await countRemovableData() };
  });

  app.post("/api/library/cleanup", async () => {
    const removed = await purgeRemovableData();
    if (removed.items > 0) {
      await logActivity(
        "library",
        `Removed ${removed.items} items left behind by folders no longer watched`,
        removed,
      );
    }
    return { removed };
  });

  app.delete<{ Params: { id: string }; Querystring: { deleteData?: string } }>(
    "/api/library/roots/:id",
    async (request, reply) => {
    const id = Number(request.params.id);
    const [root] = await db.select().from(libraryRoots).where(eq(libraryRoots.id, id));
    if (!root) {
      reply.code(404);
      return { error: "Not found" };
    }

    // Clear any "missing" flag on that folder's items: you chose to stop
    // watching it, which isn't the same as the files having vanished.
    const affected = db
      .select({ id: mediaFiles.mediaItemId })
      .from(mediaFiles)
      .where(eq(mediaFiles.rootId, id));
    await db
      .update(mediaItems)
      .set({ missingSince: null })
      .where(inArray(mediaItems.id, affected));

    // Hide the items rather than deleting them, so adding the folder back
    // returns everything — titles, performers, favourites and all.
    //
    // Must run *before* the root row goes: media_files.root_id references it,
    // and the FK has no ON DELETE action, so deleting first fails outright.
    await clearScopeForRoot(id);

    await db.delete(libraryRoots).where(eq(libraryRoots.id, id));

    // Performers and studios with no visible items left are debris from the
    // folder that just went. Items are only hidden, so nothing authored is
    // lost — but the lists stop showing names from a library you no longer have.
    await purgeEmptyEntities();

    // Asked for at the point of removal, because "I am done with this folder"
    // and "I want its 1,400 rows gone" are different decisions and only you
    // know which one this is. Without it the data waits, invisible, until it
    // turns up as names in a list months later.
    const removed =
      request.query.deleteData === "true"
        ? await purgeRemovableData()
        : null;
    if (removed && removed.items > 0) {
      await logActivity(
        "library",
        `Removed ${removed.items} items along with the folder`,
        removed,
      );
    }

    return { ok: true, removed };
  },
  );
}

export { mediaItems };
