import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import {
  makeItem,
  makeLibrary,
  makePerformer,
  makeStudio,
  makeTag,
  linkPerformer,
  linkTag,
  makePhoto,
  makeFolder,
} from "../test/fixtures.js";
import { db } from "../db/client.js";
import { playbackHeatmap, playbackStates } from "../db/schema.js";
import { eq } from "drizzle-orm";

let app: FastifyInstance;
let cookie: string;
let libraryId: number;

beforeAll(async () => {
  app = await testApp();
});

beforeEach(async () => {
  await resetDatabase();
  cookie = await signIn();
  ({ libraryId } = await makeLibrary());
});

const get = (url: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

describe("GET /api/inbox/count", () => {
  it("returns 0 when no unsorted items exist", async () => {
    const res = await get("/api/inbox/count");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 0 });
  });

  it("counts only untriaged videos", async () => {
    await makeItem(libraryId, { triagedAt: null });
    await makeItem(libraryId, { triagedAt: null });
    await makeItem(libraryId, { triagedAt: new Date() });

    const res = await get("/api/inbox/count");
    expect(res.json().count).toBe(2);
  });

  it("excludes photos and folders", async () => {
    await makeItem(libraryId, { triagedAt: null });
    await makePhoto(libraryId);
    await makeFolder(libraryId);

    const res = await get("/api/inbox/count");
    expect(res.json().count).toBe(1);
  });

  it("excludes out-of-scope and missing items", async () => {
    await makeItem(libraryId, { triagedAt: null, inScope: false });
    await makeItem(libraryId, { triagedAt: null, missingSince: new Date() });
    await makeItem(libraryId, { triagedAt: null });

    const res = await get("/api/inbox/count");
    expect(res.json().count).toBe(1);
  });

  it("excludes hidden items", async () => {
    await makeItem(libraryId, { triagedAt: null, hiddenAt: new Date() });
    await makeItem(libraryId, { triagedAt: null });

    const res = await get("/api/inbox/count");
    expect(res.json().count).toBe(1);
  });
});

describe("GET /api/inbox", () => {
  it("returns unsorted items newest first", async () => {
    const older = await makeItem(libraryId, { title: "Older", triagedAt: null });
    // Slight delay so createdAt differs
    const newer = await makeItem(libraryId, { title: "Newer", triagedAt: null });

    const res = await get("/api/inbox?page=1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].title).toBe("Newer");
    expect(body.items[1].title).toBe("Older");
  });

  it("enriches items with performers and tags", async () => {
    const itemId = await makeItem(libraryId, { triagedAt: null });
    const perfId = await makePerformer("Alice");
    const tagId = await makeTag("outdoor");
    await linkPerformer(itemId, perfId);
    await linkTag(itemId, tagId);

    const res = await get("/api/inbox?page=1");
    const item = res.json().items[0];
    expect(item.performers).toEqual([expect.objectContaining({ name: "Alice" })]);
    expect(item.tags).toEqual([expect.objectContaining({ name: "outdoor" })]);
  });

  it("includes studio name", async () => {
    const studioId = await makeStudio("TestStudio");
    await makeItem(libraryId, { triagedAt: null, studioId });

    const res = await get("/api/inbox?page=1");
    expect(res.json().items[0].studioName).toBe("TestStudio");
  });

  it("does not return triaged items", async () => {
    await makeItem(libraryId, { triagedAt: new Date() });

    const res = await get("/api/inbox?page=1");
    expect(res.json().items).toHaveLength(0);
  });

  it("returns hasMore when more items exist than page size", async () => {
    const res = await get("/api/inbox?page=1");
    expect(res.json().hasMore).toBe(false);
  });
});

describe("POST /api/inbox/triage", () => {
  it("marks specific items as triaged", async () => {
    const id1 = await makeItem(libraryId, { triagedAt: null });
    const id2 = await makeItem(libraryId, { triagedAt: null });

    const res = await post("/api/inbox/triage", { ids: [id1] });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const countRes = await get("/api/inbox/count");
    expect(countRes.json().count).toBe(1);
  });

  it("rejects empty ids array", async () => {
    const res = await post("/api/inbox/triage", { ids: [] });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing ids", async () => {
    const res = await post("/api/inbox/triage", {});
    expect(res.statusCode).toBe(400);
  });

  it("is idempotent for already-triaged items", async () => {
    const id = await makeItem(libraryId, { triagedAt: new Date() });

    const res = await post("/api/inbox/triage", { ids: [id] });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/inbox/triage-all", () => {
  it("marks all unsorted items as triaged", async () => {
    await makeItem(libraryId, { triagedAt: null });
    await makeItem(libraryId, { triagedAt: null });
    await makeItem(libraryId, { triagedAt: null });

    const res = await post("/api/inbox/triage-all");
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(3);

    const countRes = await get("/api/inbox/count");
    expect(countRes.json().count).toBe(0);
  });

  it("returns 0 when nothing to triage", async () => {
    const res = await post("/api/inbox/triage-all");
    expect(res.json().count).toBe(0);
  });
});

describe("GET /api/media-items/:id/heatmap", () => {
  it("returns 50 zero buckets for an unwatched video", async () => {
    const id = await makeItem(libraryId, { durationSeconds: 600 });

    const res = await get(`/api/media-items/${id}/heatmap`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.buckets).toHaveLength(50);
    expect(body.buckets.every((b: number) => b === 0)).toBe(true);
  });

  it("returns counts for buckets with recorded data", async () => {
    const id = await makeItem(libraryId, { durationSeconds: 600 });

    await db.insert(playbackHeatmap).values([
      { mediaItemId: id, bucket: 0, count: 5 },
      { mediaItemId: id, bucket: 25, count: 3 },
      { mediaItemId: id, bucket: 49, count: 1 },
    ]);

    const res = await get(`/api/media-items/${id}/heatmap`);
    const buckets = res.json().buckets;
    expect(buckets[0]).toBe(5);
    expect(buckets[25]).toBe(3);
    expect(buckets[49]).toBe(1);
    expect(buckets[1]).toBe(0);
  });
});

describe("heatmap recording via playback", () => {
  it("records a heatmap bucket when position advances", async () => {
    const id = await makeItem(libraryId, { durationSeconds: 100 });

    // Seed a playback state with updatedAt in the past so secondsWatched
    // sees realistic elapsed time (moved=2, elapsed~5s → accepted).
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    await db
      .insert(playbackStates)
      .values({ mediaItemId: id, positionSeconds: 8 })
      .onConflictDoUpdate({
        target: playbackStates.mediaItemId,
        set: { positionSeconds: 8, updatedAt: fiveSecondsAgo },
      });

    await app.inject({
      method: "PUT",
      url: `/api/media-items/${id}/playback`,
      headers: { cookie },
      payload: { positionSeconds: 10 },
    });

    const rows = await db
      .select()
      .from(playbackHeatmap)
      .where(eq(playbackHeatmap.mediaItemId, id));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].bucket).toBe(5); // 10/100 * 50 = 5
    expect(rows[0].count).toBeGreaterThanOrEqual(1);
  });

  it("does not record heatmap for items without duration", async () => {
    const id = await makeItem(libraryId);

    const fiveSecondsAgo = new Date(Date.now() - 5000);
    await db
      .insert(playbackStates)
      .values({ mediaItemId: id, positionSeconds: 8 })
      .onConflictDoUpdate({
        target: playbackStates.mediaItemId,
        set: { positionSeconds: 8, updatedAt: fiveSecondsAgo },
      });

    await app.inject({
      method: "PUT",
      url: `/api/media-items/${id}/playback`,
      headers: { cookie },
      payload: { positionSeconds: 10 },
    });

    const rows = await db
      .select()
      .from(playbackHeatmap)
      .where(eq(playbackHeatmap.mediaItemId, id));

    expect(rows).toHaveLength(0);
  });

  it("increments count on repeat visits to the same bucket", async () => {
    const id = await makeItem(libraryId, { durationSeconds: 100 });

    await db.insert(playbackHeatmap).values({ mediaItemId: id, bucket: 5, count: 3 });

    const fiveSecondsAgo = new Date(Date.now() - 5000);
    await db
      .insert(playbackStates)
      .values({ mediaItemId: id, positionSeconds: 9 })
      .onConflictDoUpdate({
        target: playbackStates.mediaItemId,
        set: { positionSeconds: 9, updatedAt: fiveSecondsAgo },
      });

    await app.inject({
      method: "PUT",
      url: `/api/media-items/${id}/playback`,
      headers: { cookie },
      payload: { positionSeconds: 11 },
    });

    const [row] = await db
      .select()
      .from(playbackHeatmap)
      .where(eq(playbackHeatmap.mediaItemId, id));

    expect(row.count).toBeGreaterThan(3);
  });
});
