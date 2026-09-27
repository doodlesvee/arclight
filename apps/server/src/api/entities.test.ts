import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { playbackStates } from "../db/schema.js";
import { mediaItems } from "../db/schema.js";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import {
  attachFile,
  linkPerformer,
  makeItem,
  makeLibrary,
  makePerformer,
  makePhoto,
  makeStudio,
} from "../test/fixtures.js";

let app: FastifyInstance;
let cookie: string;
let libraryId: number;
let rootId: number;

beforeAll(async () => {
  app = await testApp();
});
beforeEach(async () => {
  await resetDatabase();
  cookie = await signIn();
  ({ libraryId, rootId } = await makeLibrary());
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as object });

describe("performers", () => {
  it("counts each performer's videos", async () => {
    const alice = await makePerformer("Alice");
    await linkPerformer(await makeItem(libraryId, { title: "One" }), alice);
    await linkPerformer(await makeItem(libraryId, { title: "Two" }), alice);

    const body = (await get("/api/performers")).json();
    expect(body.performers).toHaveLength(1);
    expect(body.performers[0].videoCount).toBe(2);
  });

  it("keeps a performer with no videos", async () => {
    // You create one by hand so the scanner can match them next time; a
    // WHERE instead of a join condition would drop them entirely.
    await makePerformer("Nobody Yet");
    const body = (await get("/api/performers")).json();
    expect(body.performers[0].videoCount).toBe(0);
  });

  it("credits a two-performer video to both", async () => {
    const item = await makeItem(libraryId, { title: "Shared" });
    await linkPerformer(item, await makePerformer("Alice"));
    await linkPerformer(item, await makePerformer("Bella"));

    const body = (await get("/api/performers")).json();
    expect(body.performers.map((p: { videoCount: number }) => p.videoCount)).toEqual([1, 1]);
  });

  it("replaces the whole set and takes ownership from the scanner", async () => {
    const item = await makeItem(libraryId, { title: "X" });
    await linkPerformer(item, await makePerformer("Old"));

    await send("PUT", `/api/media-items/${item}/performers`, { performerNames: ["New", "Other"] });
    const detail = (await get(`/api/media-items/${item}`)).json();
    expect(detail.performers.map((p: { name: string }) => p.name).sort()).toEqual([
      "New",
      "Other",
    ]);
    expect(detail.performersSource).toBe("user");
  });

  it("collapses names that differ only by case", async () => {
    // Two ids for one person would violate the join table's primary key.
    const item = await makeItem(libraryId, { title: "X" });
    const res = await send("PUT", `/api/media-items/${item}/performers`, {
      performerNames: ["Alice", "alice"],
    });
    expect(res.statusCode).toBe(200);
    expect((await get(`/api/media-items/${item}`)).json().performers).toHaveLength(1);
  });

  it("refuses to rename onto an existing name", async () => {
    await makePerformer("Alice");
    const bella = await makePerformer("Bella");
    expect((await send("PATCH", `/api/performers/${bella}`, { name: "alice" })).statusCode).toBe(
      409
    );
  });

  it("pins favourites to the top, alphabetical within each group", async () => {
    await makePerformer("Alice");
    const zoe = await makePerformer("Zoe");
    await makePerformer("Bella");
    await send("PATCH", `/api/performers/${zoe}`, { isFavorite: true });

    const body = (await get("/api/performers")).json();
    expect(body.performers.map((p: { name: string }) => p.name)).toEqual([
      "Zoe",
      "Alice",
      "Bella",
    ]);
    expect(body.performers[0].isFavorite).toBe(true);
    expect(body.performers[1].isFavorite).toBe(false);
  });

  it("toggles a favourite without re-sending the name", async () => {
    const alice = await makePerformer("Alice");
    expect((await send("PATCH", `/api/performers/${alice}`, { isFavorite: true })).statusCode).toBe(
      200
    );
    expect((await get(`/api/performers/${alice}`)).json().isFavorite).toBe(true);

    await send("PATCH", `/api/performers/${alice}`, { isFavorite: false });
    expect((await get(`/api/performers/${alice}`)).json().isFavorite).toBe(false);
  });

  it("archives a performer out of the list, and brings them back", async () => {
    const alice = await makePerformer("Alice");
    await makePerformer("Bella");
    const names = async (url: string) =>
      (await get(url)).json().performers.map((p: { name: string }) => p.name);

    expect((await send("PATCH", `/api/performers/${alice}`, { archived: true })).statusCode).toBe(
      200
    );
    expect(await names("/api/performers")).toEqual(["Bella"]);
    // The performers page asks for them explicitly, to show them apart.
    const all = (await get("/api/performers?archived=include")).json().performers;
    expect(all.map((p: { name: string }) => p.name)).toEqual(["Alice", "Bella"]);
    expect(all[0].archivedAt).not.toBeNull();
    expect(all[1].archivedAt).toBeNull();

    await send("PATCH", `/api/performers/${alice}`, { archived: false });
    expect(await names("/api/performers")).toEqual(["Alice", "Bella"]);
    expect((await get(`/api/performers/${alice}`)).json().archivedAt).toBeNull();
  });

  it("keeps an archived performer's page, videos and credits intact", async () => {
    const alice = await makePerformer("Alice");
    await send("PATCH", `/api/performers/${alice}`, { isFavorite: true });
    await linkPerformer(await makeItem(libraryId, { title: "Credited" }), alice);
    await send("PATCH", `/api/performers/${alice}`, { archived: true });

    const detail = (await get(`/api/performers/${alice}`)).json();
    expect(detail.archivedAt).not.toBeNull();
    expect(detail.videoCount).toBe(1);
    // Archiving is not a way of un-favouriting; restoring puts them back
    // exactly where they were.
    expect(detail.isFavorite).toBe(true);
  });

  it("leaves an archived performer out of search suggestions", async () => {
    const alice = await makePerformer("Alice Archived");
    await makePerformer("Alice Active");
    await send("PATCH", `/api/performers/${alice}`, { archived: true });

    const body = (await get("/api/search/suggestions?q=Alice")).json();
    expect(body.performers.map((p: { name: string }) => p.name)).toEqual(["Alice Active"]);
  });

  it("saves a bio on its own, without re-sending the name", async () => {
    // The partial-update branch used to trigger only on framing fields, so a
    // bio-only PATCH fell through to a path that 400s without a name.
    const alice = await makePerformer("Alice");
    const res = await send("PATCH", `/api/performers/${alice}`, { bio: "  Some prose.  " });
    expect(res.statusCode).toBe(200);

    const detail = (await get(`/api/performers/${alice}`)).json();
    expect(detail.bio).toBe("Some prose.");
  });

  it("stores a cleared bio as null, not an empty string", async () => {
    const alice = await makePerformer("Alice");
    await send("PATCH", `/api/performers/${alice}`, { bio: "Written" });
    await send("PATCH", `/api/performers/${alice}`, { bio: "   " });
    expect((await get(`/api/performers/${alice}`)).json().bio).toBeNull();
  });

  it("keeps the bio off the list endpoint, which renders every performer", async () => {
    const alice = await makePerformer("Alice");
    await send("PATCH", `/api/performers/${alice}`, { bio: "Written" });
    expect((await get("/api/performers")).json().performers[0].bio).toBeUndefined();
  });

  describe("profile aggregates", () => {
    it("breaks videos down by studio, including those with none", async () => {
      // The null bucket has to exist: without it, videos with no studio
      // silently vanish from a grouped view.
      const alice = await makePerformer("Alice");
      const vixen = await makeStudio("Vixen");
      const colette = await makeStudio("Colette");
      await linkPerformer(await makeItem(libraryId, { title: "A", studioId: vixen }), alice);
      await linkPerformer(await makeItem(libraryId, { title: "B", studioId: vixen }), alice);
      await linkPerformer(await makeItem(libraryId, { title: "C", studioId: colette }), alice);
      await linkPerformer(await makeItem(libraryId, { title: "D" }), alice);

      // Alphabetical, not by count — Colette has fewer videos but comes
      // first. "No studio" is last, since it isn't a name.
      const body = (await get(`/api/performers/${alice}`)).json();
      expect(body.studios).toEqual([
        { name: "Colette", count: 1 },
        { name: "Vixen", count: 2 },
        { name: null, count: 1 },
      ]);
      // Every video is accounted for.
      const total = body.studios.reduce((n: number, s: { count: number }) => n + s.count, 0);
      expect(total).toBe(body.videoCount);
    });

    it("breaks videos down by year, including undated ones", async () => {
      const alice = await makePerformer("Alice");
      await linkPerformer(
        await makeItem(libraryId, { title: "A", releaseDate: "2019-05-01" }),
        alice
      );
      await linkPerformer(await makeItem(libraryId, { title: "B" }), alice);

      const body = (await get(`/api/performers/${alice}`)).json();
      expect(body.years).toEqual([
        { year: null, count: 1 },
        { year: 2019, count: 1 },
      ]);
    });

    it("counts watch state", async () => {
      const alice = await makePerformer("Alice");
      const watched = await makeItem(libraryId, { title: "A", durationSeconds: 1000 });
      const partial = await makeItem(libraryId, { title: "B", durationSeconds: 1000 });
      await linkPerformer(watched, alice);
      await linkPerformer(partial, alice);
      await linkPerformer(await makeItem(libraryId, { title: "C" }), alice);

      await send("PUT", `/api/media-items/${watched}/watched`, { watched: true });
      await send("PUT", `/api/media-items/${partial}/playback`, { positionSeconds: 300 });

      const body = (await get(`/api/performers/${alice}`)).json();
      expect(body.watch).toEqual({ watched: 1, inProgress: 1, unwatched: 1 });
    });

    it("lists co-performers with what the UI needs to draw a portrait", async () => {
      const alice = await makePerformer("Alice");
      const bella = await makePerformer("Bella");
      const shared = await makeItem(libraryId, { title: "Shared" });
      await linkPerformer(shared, alice);
      await linkPerformer(shared, bella);
      // A solo video must not invent a co-performer.
      await linkPerformer(await makeItem(libraryId, { title: "Solo" }), alice);

      const body = (await get(`/api/performers/${alice}`)).json();
      expect(body.coPerformers).toHaveLength(1);
      expect(body.coPerformers[0]).toMatchObject({ name: "Bella", together: 1 });
      expect(body.coPerformers[0].representativeItemId).toBe(shared);
    });

    it("reports each co-performer's own video total, not just the shared one", async () => {
      // The tile reads "N videos", so this is their whole catalogue. It also
      // guards a real failure: computing it as a correlated subquery rendered
      // `from "co_performer"` — an alias, not a table — and 500'd the route.
      const alice = await makePerformer("Alice");
      const bella = await makePerformer("Bella");
      const shared = await makeItem(libraryId, { title: "Shared" });
      await linkPerformer(shared, alice);
      await linkPerformer(shared, bella);
      await linkPerformer(await makeItem(libraryId, { title: "Bella solo" }), bella);

      const res = await get(`/api/performers/${alice}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().coPerformers[0]).toMatchObject({
        name: "Bella",
        together: 1,
        videoCount: 2,
      });
    });

    it("returns empty aggregates for a performer with no videos", async () => {
      const alice = await makePerformer("Alice");
      const body = (await get(`/api/performers/${alice}`)).json();
      expect(body.studios).toEqual([]);
      expect(body.coPerformers).toEqual([]);
      expect(body.watch).toEqual({ watched: 0, inProgress: 0, unwatched: 0 });
    });
  });

  it("clamps portrait framing", async () => {
    const alice = await makePerformer("Alice");
    await send("PATCH", `/api/performers/${alice}`, { imageScale: 9999, imagePositionX: -20 });
    const body = (await get("/api/performers")).json();
    expect(body.performers[0].imageScale).toBe(300);
    expect(body.performers[0].imagePositionX).toBe(0);
  });
});

describe("tags", () => {
  it("creates unknown tags on assignment and replaces the set", async () => {
    const item = await makeItem(libraryId, { title: "X" });
    await send("PUT", `/api/media-items/${item}/tags`, { tagNames: ["one", "two"] });
    expect((await get("/api/tags")).json().tags).toHaveLength(2);

    await send("PUT", `/api/media-items/${item}/tags`, { tagNames: ["one"] });
    expect((await get(`/api/media-items/${item}`)).json().tags).toHaveLength(1);
  });
});

describe("categories", () => {
  it("ships with the three defaults", async () => {
    const body = (await get("/api/categories")).json();
    expect(body.categories.map((c: { slug: string }) => c.slug)).toEqual([
      "video",
      "movie",
      "series",
    ]);
  });

  it("refuses a duplicate name regardless of case", async () => {
    // "Movies" already exists as a default, and differing only by case is
    // exactly how a second, identical-looking tile appeared before this check.
    expect((await send("POST", "/api/categories", { label: "movies" })).statusCode).toBe(409);

    expect((await send("POST", "/api/categories", { label: "Shorts" })).statusCode).toBe(200);
    expect((await send("POST", "/api/categories", { label: "sHoRtS" })).statusCode).toBe(409);
  });

  it("counts only videos, not the photos that share a default kind", async () => {
    // `kind` defaults to "video" and nothing ever changes it for a photo, so
    // counting by kind alone reported every still in the library as a video —
    // 970 of them against 15 real videos.
    await makeItem(libraryId, { title: "A real video", kind: "video" });
    await makePhoto(libraryId, "a still");

    const video = (await get("/api/categories")).json().categories.find(
      (c: { slug: string }) => c.slug === "video"
    );
    expect(video.total).toBe(1);
  });

  it("moves items to another category rather than deleting them", async () => {
    const item = await makeItem(libraryId, { title: "X", kind: "movie" });
    const movie = (await get("/api/categories")).json().categories.find(
      (c: { slug: string }) => c.slug === "movie"
    );
    const res = await send("DELETE", `/api/categories/${movie.id}`);
    expect(res.json().movedCount).toBe(1);
    expect((await get(`/api/media-items/${item}`)).statusCode).toBe(200);
  });

  it("clamps cover framing", async () => {
    const video = (await get("/api/categories")).json().categories[0];
    await send("PATCH", `/api/categories/${video.id}`, { coverScale: 50, coverPositionY: 999 });
    const after = (await get("/api/categories")).json().categories[0];
    expect(after.coverScale).toBe(100);
    expect(after.coverPositionY).toBe(100);
  });
});

describe("playback and watched state", () => {
  it("saves and returns a resume position", async () => {
    const item = await makeItem(libraryId, { title: "X", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${item}/playback`, { positionSeconds: 300 });
    expect((await get(`/api/media-items/${item}`)).json().lastPositionSeconds).toBe(300);
  });

  it("rejects a negative position", async () => {
    const item = await makeItem(libraryId, { title: "X" });
    expect(
      (await send("PUT", `/api/media-items/${item}/playback`, { positionSeconds: -5 })).statusCode
    ).toBe(400);
  });

  it("shows part-watched videos in Continue Watching", async () => {
    const item = await makeItem(libraryId, { title: "X", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${item}/playback`, { positionSeconds: 300 });
    expect((await get("/api/continue-watching")).json().items).toHaveLength(1);
  });

  it("clears Continue Watching without losing watch history", async () => {
    const partial = await makeItem(libraryId, { title: "Partial", durationSeconds: 1000 });
    const finished = await makeItem(libraryId, { title: "Finished", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${partial}/playback`, { positionSeconds: 300 });
    await send("PUT", `/api/media-items/${finished}/watched`, { watched: true });

    const res = await send("DELETE", "/api/continue-watching");
    expect(res.json().cleared).toBe(1);
    expect((await get("/api/continue-watching")).json().items).toEqual([]);

    // The resume point is gone, but nothing else is.
    expect((await get(`/api/media-items/${partial}`)).json().lastPositionSeconds).toBe(0);
    const done = (await get(`/api/media-items/${finished}`)).json();
    expect(done.watched).toBe(true);
    expect(done.playCount).toBe(1);
  });

  it("clearing an already-empty Continue Watching is harmless", async () => {
    expect((await send("DELETE", "/api/continue-watching")).json().cleared).toBe(0);
  });

  it("drops a nearly-finished video out of Continue Watching", async () => {
    // 950 of 1000 is past the 92% threshold; it used to sit there forever.
    const item = await makeItem(libraryId, { title: "X", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${item}/playback`, { positionSeconds: 950 });
    expect((await get("/api/continue-watching")).json().items).toEqual([]);
  });

  it("marks watched, counts the play, and clears the resume point", async () => {
    const item = await makeItem(libraryId, { title: "X", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${item}/playback`, { positionSeconds: 300 });
    await send("PUT", `/api/media-items/${item}/watched`, { watched: true });

    const detail = (await get(`/api/media-items/${item}`)).json();
    expect(detail.watched).toBe(true);
    expect(detail.playCount).toBe(1);
    expect(detail.lastPositionSeconds).toBe(0);
    expect((await get("/api/continue-watching")).json().items).toEqual([]);
  });

  it("does not double-count re-marking something already watched", async () => {
    const item = await makeItem(libraryId, { title: "X", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${item}/watched`, { watched: true });
    await send("PUT", `/api/media-items/${item}/watched`, { watched: true });
    expect((await get(`/api/media-items/${item}`)).json().playCount).toBe(1);
  });

  it("keeps the play count when un-marking, since it is a record of what happened", async () => {
    const item = await makeItem(libraryId, { title: "X", durationSeconds: 1000 });
    await send("PUT", `/api/media-items/${item}/watched`, { watched: true });
    await send("PUT", `/api/media-items/${item}/watched`, { watched: false });

    const detail = (await get(`/api/media-items/${item}`)).json();
    expect(detail.watched).toBe(false);
    expect(detail.playCount).toBe(1);
  });
});

describe("stats", () => {
  it("counts videos without counting photos or folders as videos", async () => {
    await makeItem(libraryId, { title: "A" });
    const body = (await get("/api/stats")).json();
    expect(body.videos).toBe(1);
  });

  it("totals the bytes on disk, ignoring hidden items", async () => {
    // attachFile writes 1000 bytes per file.
    const shown = await makeItem(libraryId, { title: "Shown" });
    await attachFile(shown, rootId, "/media/shown.mp4");
    const hidden = await makeItem(libraryId, { title: "Hidden", inScope: false });
    await attachFile(hidden, rootId, "/media/hidden.mp4");

    // A number, not the string the pg driver returns for a numeric sum.
    expect((await get("/api/stats")).json().totalBytes).toBe(1000);
  });

  // Health is about videos. Photos arrive in albums beside the videos they
  // were scanned with, in numbers that would otherwise drown the figure.
  describe("health, over videos alone", () => {
    it("counts videos in the total and leaves photos out", async () => {
      await makeItem(libraryId, { title: "A video" });
      await makePhoto(libraryId, "A photo");
      await makePhoto(libraryId, "Another photo");

      const body = (await get("/api/stats")).json();
      expect(body.videoTotal).toBe(1);
      // The whole-library summary still sees everything.
      expect(body.photos).toBe(2);
    });

    it("ignores a missing photo, and reports a missing video", async () => {
      await makeItem(libraryId, { title: "Gone", missingSince: new Date() });
      await makeItem(libraryId, { title: "Here" });
      const photo = await makePhoto(libraryId, "Gone too");
      await db
        .update(mediaItems)
        .set({ missingSince: new Date() })
        .where(eq(mediaItems.id, photo));

      expect((await get("/api/stats")).json().videoMissing).toBe(1);
    });

    it("sizes videos only, where totalBytes sizes everything", async () => {
      const video = await makeItem(libraryId, { title: "Video" });
      await attachFile(video, rootId, "/media/video.mp4");
      const photo = await makePhoto(libraryId, "Photo");
      await attachFile(photo, rootId, "/media/photo.jpg");

      const body = (await get("/api/stats")).json();
      expect(body.videoBytes).toBe(1000);
      expect(body.totalBytes).toBe(2000);
    });

    it("does not report repeated stills in an album as duplicates", async () => {
      const one = await makePhoto(libraryId, "Still one");
      const two = await makePhoto(libraryId, "Still two");
      await attachFile(one, rootId, "/media/a.jpg", "same-hash");
      await attachFile(two, rootId, "/media/b.jpg", "same-hash");

      expect((await get("/api/stats")).json().videoDuplicateGroups).toBe(0);
    });

    it("reports two videos sharing a hash as one duplicate group", async () => {
      const one = await makeItem(libraryId, { title: "Copy one" });
      const two = await makeItem(libraryId, { title: "Copy two" });
      await attachFile(one, rootId, "/media/a.mp4", "shared-hash");
      await attachFile(two, rootId, "/media/b.mp4", "shared-hash");

      expect((await get("/api/stats")).json().videoDuplicateGroups).toBe(1);
    });

    it("leaves a folder you stopped scanning out of the duplicate count", async () => {
      const one = await makeItem(libraryId, { title: "Copy one" });
      const two = await makeItem(libraryId, { title: "Copy two", inScope: false });
      await attachFile(one, rootId, "/media/a.mp4", "shared-hash");
      await attachFile(two, rootId, "/media/b.mp4", "shared-hash");

      expect((await get("/api/stats")).json().videoDuplicateGroups).toBe(0);
    });
  });
});


// Missing files are hidden from everywhere you browse. They still exist, are
// still counted by library health, and are still listed by the missing-videos
// manager — they just stop appearing where you would try to play them.
describe("missing items stay out of the library", () => {
  const gone = () => new Date("2026-01-01");

  async function titles(url: string): Promise<string[]> {
    const body = (await get(url)).json();
    const rows = body.items ?? body.suggestions ?? body;
    return (Array.isArray(rows) ? rows : []).map(
      (row: { title?: string; label?: string }) => row.title ?? row.label ?? "",
    );
  }

  it("leaves a missing video out of the library grid", async () => {
    await makeItem(libraryId, { title: "Here" });
    await makeItem(libraryId, { title: "Gone", missingSince: gone() });

    const listed = await titles("/api/media-items");
    expect(listed).toContain("Here");
    expect(listed).not.toContain("Gone");
  });

  it("leaves it out of search suggestions", async () => {
    await makeItem(libraryId, { title: "Findable" });
    await makeItem(libraryId, { title: "Findable but gone", missingSince: gone() });

    const body = (await get("/api/search/suggestions?q=Findable")).json();
    const text = JSON.stringify(body);
    expect(text).toContain("Findable");
    expect(text).not.toContain("Findable but gone");
  });

  it("leaves it out of continue watching", async () => {
    const item = await makeItem(libraryId, {
      title: "Half watched",
      missingSince: gone(),
      durationSeconds: 600,
    });
    await db.insert(playbackStates).values({ mediaItemId: item, positionSeconds: 120 });

    expect(await titles("/api/continue-watching")).not.toContain("Half watched");
  });

  // The hero had three branches and only one of them filtered, so a favourited
  // or hand-picked video that went missing still headlined the homepage.
  it("leaves a favourited missing video out of the hero", async () => {
    await makeItem(libraryId, { title: "Gone favourite", isFavorite: true, missingSince: gone() });
    // PATCH /api/settings, not a PUT to a hero route — the first version of
    // this test called an endpoint that does not exist, so the hero silently
    // fell back to the one branch that already filtered and the test passed
    // while proving nothing.
    const saved = await send("PATCH", "/api/settings", {
      hero: { source: "favorites", itemIds: [] },
    });
    expect(saved.statusCode).toBe(200);

    expect(await titles("/api/hero-items")).not.toContain("Gone favourite");
  });

  it("still counts it in library health, and still lists it for removal", async () => {
    await makeItem(libraryId, { title: "Gone", missingSince: gone() });

    const stats = (await get("/api/stats")).json();
    expect(stats.videoMissing).toBe(1);
    expect(stats.videoTotal).toBe(1);

    expect(await titles("/api/missing")).toContain("Gone");
  });
});
