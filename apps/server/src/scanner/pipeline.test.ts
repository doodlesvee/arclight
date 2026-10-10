import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { albums, libraries, libraryRoots, mediaFiles, mediaItems, performers, studios } from "../db/schema.js";
import { resetDatabase, testApp } from "../test/harness.js";
import { seed } from "../db/seed.js";
import { startScan, isScanRunning } from "./pipeline.js";

let root: string;

/** Waits for whatever scan is in flight to finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && isScanRunning(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (isScanRunning()) throw new Error("scan did not finish");
}

/** Runs a scan and waits for it, since startScan returns as soon as it begins. */
async function scan(): Promise<void> {
  await startScan();
  await settle();
}

/**
 * A real 1x1 JPEG.
 *
 * The photo tests below cannot write placeholder text into a `.jpg`: unlike
 * the video path, which never decodes the file, the scanner hands an image to
 * sharp to probe and to build a thumbnail from. Given bytes that are not an
 * image that work fails slowly and, worse, outlives the test — which turned a
 * 12-second run of this file plus the routes suite into a 16-minute one and
 * left the next suite failing in `beforeEach`.
 *
 * Inline base64 rather than a fixture on disk or a call to sharp: it is 267
 * bytes, it needs no I/O to produce, and a test that depends on the image
 * library to build its own input cannot fail cleanly when that library is
 * what is broken.
 */
const TINY_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSop" +
    "GR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAA" +
    "AAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAA" +
    "AAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
  "base64",
);

async function putImage(relative: string): Promise<string> {
  return put(relative, TINY_JPEG);
}

async function put(
  relative: string,
  contents: string | Buffer = "video-bytes",
): Promise<string> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  return full;
}

const titles = async () =>
  (await db.select({ title: mediaItems.title }).from(mediaItems)).map((r) => r.title).sort();

beforeEach(async () => {
  await testApp();
  await resetDatabase();
  // seed() creates the media_item_types the scanner classifies into.
  await seed();
  root = await mkdtemp(path.join(tmpdir(), "scan-test-"));
  const [library] = await db.insert(libraries).values({ name: "Test" }).returning();
  await db.insert(libraryRoots).values({ libraryId: library.id, path: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanning", () => {
  it("imports a video and skips files it does not recognise", async () => {
    await put("Alice/movie.mp4");
    await put("Alice/notes.txt");
    await scan();
    expect(await titles()).toEqual(["movie"]);
  });

  it("derives the performer from the folder", async () => {
    await put("Alice/movie.mp4");
    await scan();
    expect((await db.select().from(performers)).map((p) => p.name)).toEqual(["Alice"]);
  });

  it("does not select performer artwork from meta folders", async () => {
    const videoPath = await put("Alice/movie.mp4");
    await putImage("Alice/meta/COVER.jpg");
    await putImage("Alice/meta/banner.jpg");
    await scan();
    const [performer] = await db.select().from(performers);
    expect(performer.imageFile).toBeNull();
    expect(performer.bannerFile).toBeNull();
    const [video] = await db.select({ thumbnailFile: mediaItems.thumbnailFile })
      .from(mediaItems)
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(eq(mediaFiles.path, videoPath));
    expect(video.thumbnailFile).toBeNull();
    await scan();
    const [after] = await db.select().from(performers);
    expect(after.imageFile).toBe(performer.imageFile);
    expect(after.bannerFile).toBe(performer.bannerFile);
  });

  it("preserves stored performer artwork when meta images exist", async () => {
    await put("Alice/movie.mp4");
    await scan();
    const [performer] = await db.select().from(performers);
    await db.update(performers).set({ imageFile: "manual.jpg", bannerFile: "manual-banner.jpg" })
      .where(eq(performers.id, performer.id));
    await putImage("Alice/meta/cover.jpg");
    await putImage("Alice/meta/banner.jpg");
    await scan();
    const [after] = await db.select().from(performers);
    expect(after.imageFile).toBe("manual.jpg");
    expect(after.bannerFile).toBe("manual-banner.jpg");
  });

  it("derives the studio from a studio sub-folder", async () => {
    await put("Alice/Vixen/movie.mp4");
    await scan();
    expect((await db.select().from(studios)).map((s) => s.name)).toEqual(["Vixen"]);
  });

  it("reads studio, cast, date and title from a declared filename", async () => {
    await put("Alice/[Vixen] Alice, Bella - 02.15.2020 - Main Event.mp4");
    await scan();

    const [item] = await db.select().from(mediaItems);
    expect(item.title).toBe("Main Event");
    expect(item.releaseDate).toBe("2020-02-15");
    expect((await db.select().from(performers)).map((p) => p.name).sort()).toEqual([
      "Alice",
      "Bella",
    ]);
  });

  it("credits one file to two performers, so no copy is needed", async () => {
    await put("Alice/[V] Alice, Bella - Shared.mp4");
    await scan();
    expect(await db.select().from(mediaFiles)).toHaveLength(1);
    expect(await db.select().from(performers)).toHaveLength(2);
  });

  it("is idempotent: a second scan changes nothing", async () => {
    await put("Alice/[V] Alice, Bella - 02.15.2020 - Shared.mp4");
    await scan();
    const before = await db.select().from(mediaItems);
    await scan();
    const after = await db.select().from(mediaItems);

    expect(after).toHaveLength(before.length);
    // updatedAt churn on every scan is the symptom of a sync that compares
    // the wrong thing — it was exactly this for two-performer items.
    expect(after[0].updatedAt).toEqual(before[0].updatedAt);
  });

  it("follows a rename, keeping the same item and its edits", async () => {
    const original = await put("Alice/before.mp4", "unique-content-here");
    await scan();
    const [item] = await db.select().from(mediaItems);
    await db.update(mediaItems).set({ isFavorite: true }).where(eq(mediaItems.id, item.id));

    await rename(original, path.join(root, "Alice/after.mp4"));
    await scan();

    const items = await db.select().from(mediaItems);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(item.id);
    expect(items[0].isFavorite).toBe(true);
    expect(items[0].title).toBe("after");
  });

  it("follows a move into another performer's folder", async () => {
    const original = await put("Alice/movie.mp4", "unique-move-content");
    await scan();
    await mkdir(path.join(root, "Bella"), { recursive: true });
    await rename(original, path.join(root, "Bella/movie.mp4"));
    await scan();

    const [item] = await db.select().from(mediaItems);
    const linked = await db.query.mediaItemPerformers.findMany({
      where: (t, { eq: e }) => e(t.mediaItemId, item.id),
    });
    const names = await db.select().from(performers);
    const linkedNames = linked.map(
      (l) => names.find((n) => n.id === l.performerId)?.name
    );
    expect(linkedNames).toEqual(["Bella"]);
  });

  it("leaves a hand-edited title alone on the next scan", async () => {
    await put("Alice/movie.mp4");
    await scan();
    const [item] = await db.select().from(mediaItems);
    await db
      .update(mediaItems)
      .set({ title: "My Title", titleSource: "user" })
      .where(eq(mediaItems.id, item.id));

    await scan();
    const [after] = await db.select().from(mediaItems);
    expect(after.title).toBe("My Title");
  });

  it("flags a deleted file as missing rather than dropping its metadata", async () => {
    const file = await put("Alice/movie.mp4");
    await scan();
    await rm(file);
    await scan();

    const [item] = await db.select().from(mediaItems);
    expect(item.missingSince).not.toBeNull();
  });

  it("ignores bookkeeping folders", async () => {
    await put(".Trash-1000/junk.mp4");
    await put("@eaDir/junk.mp4");
    await scan();
    // They import, but must not become performers named after the folder.
    expect(await db.select().from(performers)).toEqual([]);
  });

  // Albums are grouped strictly by directory, which misses the very common
  // layout of a scene folder holding the video with its stills in a
  // subfolder: the album was built from the photos and the video was left
  // with no albumId at all, so "this album's video" found nothing and the
  // gallery strip under the player stayed empty.
  it("links a scene's video to the album of its stills subfolder", async () => {
    await put("Alice/Arrest Me/scene.mp4");
    await putImage("Alice/Arrest Me/Images/1.jpg");
    await scan();

    const [album] = await db
      .select()
      .from(albums)
      .where(eq(albums.path, path.join(root, "Alice/Arrest Me/Images")));
    expect(album).toBeDefined();

    const [video] = await db
      .select({ albumId: mediaItems.albumId })
      .from(mediaItems)
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(eq(mediaFiles.path, path.join(root, "Alice/Arrest Me/scene.mp4")));

    expect(video.albumId).toBe(album.id);
  });

  // Only the immediate parent. Reaching further would attach one folder of
  // artwork to every video filed anywhere beneath it.
  it("does not link a video two folders above the stills", async () => {
    await put("Alice/top.mp4");
    await putImage("Alice/Scene/Images/1.jpg");
    await scan();

    const [video] = await db
      .select({ albumId: mediaItems.albumId })
      .from(mediaItems)
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(eq(mediaFiles.path, path.join(root, "Alice/top.mp4")));

    expect(video.albumId).toBeNull();
  });

  it("does not select a video cover from its meta subfolder on rescan", async () => {
    const videoPath = await put("Alice/Scene/scene.mp4");
    await scan();
    await putImage("Alice/Scene/meta/COVER.jpg");
    await scan();

    const [video] = await db
      .select({ thumbnailFile: mediaItems.thumbnailFile, updatedAt: mediaItems.updatedAt })
      .from(mediaItems)
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(eq(mediaFiles.path, videoPath));
    expect(video.thumbnailFile).toBeNull();

    await scan();
    const [after] = await db
      .select({ thumbnailFile: mediaItems.thumbnailFile, updatedAt: mediaItems.updatedAt })
      .from(mediaItems)
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(eq(mediaFiles.path, videoPath));
    expect(after).toEqual(video);
  });

  it("preserves a manually selected video thumbnail when a cover image exists", async () => {
    const videoPath = await put("Alice/Scene/scene.mp4");
    await scan();
    const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.path, videoPath));
    await db.update(mediaItems).set({ thumbnailFile: "manual.jpg" })
      .where(eq(mediaItems.id, file.mediaItemId));
    await putImage("Alice/Scene/Images/cover.jpg");
    await scan();
    const [video] = await db.select().from(mediaItems).where(eq(mediaItems.id, file.mediaItemId));
    expect(video.thumbnailFile).toBe("manual.jpg");
  });

  // The original behaviour has to survive: where the photos sit beside the
  // video, the video is already in the album's own directory group.
  it("still links a video sitting in the same folder as the photos", async () => {
    await put("Alice/Scene/scene.mp4");
    await putImage("Alice/Scene/1.jpg");
    await scan();

    const [album] = await db
      .select()
      .from(albums)
      .where(eq(albums.path, path.join(root, "Alice/Scene")));

    const [video] = await db
      .select({ albumId: mediaItems.albumId })
      .from(mediaItems)
      .innerJoin(mediaFiles, eq(mediaFiles.mediaItemId, mediaItems.id))
      .where(eq(mediaFiles.path, path.join(root, "Alice/Scene/scene.mp4")));

    expect(video.albumId).toBe(album.id);
  });

  it("refuses to start a second scan while one is running", async () => {
    // The slot is reserved synchronously, before the first await — otherwise
    // two near-simultaneous requests could both see "idle" and both scan.
    await put("Alice/movie.mp4");
    await startScan();
    await expect(startScan()).rejects.toThrow(/already running/i);
    await settle();
  });
});
