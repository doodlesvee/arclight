import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { makeItem, makeLibrary, makePhoto, makePerformer, linkPerformer } from "../test/fixtures.js";
import { db } from "../db/client.js";
import { activityEvents, duels, mediaItems } from "../db/schema.js";

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

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

async function score(id: number) {
  const [row] = await db.select().from(mediaItems).where(eq(mediaItems.id, id));
  return { score: row.duelScore, count: row.duelCount, rating: row.rating };
}

describe("GET /api/duels/pair", () => {
  it("returns null with fewer than two videos", async () => {
    await makeItem(libraryId);
    const res = await get("/api/duels/pair");
    expect(res.statusCode).toBe(200);
    expect(res.json().pair).toBeNull();
  });

  it("returns two different videos with performers", async () => {
    const a = await makeItem(libraryId, { title: "A" });
    const b = await makeItem(libraryId, { title: "B" });
    const p = await makePerformer("Alice");
    await linkPerformer(a, p);

    const { pair } = (await get("/api/duels/pair")).json();
    expect(pair).toHaveLength(2);
    expect(new Set(pair.map((c: { id: number }) => c.id))).toEqual(new Set([a, b]));
    const withPerformer = pair.find((c: { id: number }) => c.id === a);
    expect(withPerformer.performers).toEqual([{ id: p, name: "Alice" }]);
  });

  it("ignores photos, hidden and missing videos", async () => {
    await makeItem(libraryId, { title: "Real" });
    await makeItem(libraryId, { title: "Hidden", hiddenAt: new Date() });
    await makeItem(libraryId, { title: "Missing", missingSince: new Date() });
    await makePhoto(libraryId);
    expect((await get("/api/duels/pair")).json().pair).toBeNull();
  });

  it("honours the exclude list", async () => {
    const a = await makeItem(libraryId);
    const b = await makeItem(libraryId);
    const c = await makeItem(libraryId);
    for (let i = 0; i < 10; i++) {
      const { pair } = (await get(`/api/duels/pair?exclude=${a}`)).json();
      const ids = pair.map((x: { id: number }) => x.id);
      expect(ids).not.toContain(a);
      expect(new Set(ids)).toEqual(new Set([b, c]));
    }
  });

  it("prefers an opponent it has not faced", async () => {
    const a = await makeItem(libraryId);
    const b = await makeItem(libraryId);
    const c = await makeItem(libraryId);
    await post("/api/duels", { winnerId: a, loserId: b });
    // c has the fewest duels, so it anchors; a and b are equally unfaced by it
    const { pair } = (await get("/api/duels/pair")).json();
    expect(pair.map((x: { id: number }) => x.id)).toContain(c);
  });
});

describe("POST /api/duels", () => {
  it("moves scores, counts the duel, and records it", async () => {
    const a = await makeItem(libraryId, { title: "Alpha" });
    const b = await makeItem(libraryId, { title: "Beta" });

    const res = await post("/api/duels", { winnerId: a, loserId: b });
    expect(res.statusCode).toBe(200);
    expect(await score(a)).toMatchObject({ score: 1016, count: 1 });
    expect(await score(b)).toMatchObject({ score: 984, count: 1 });
    expect(await db.select().from(duels)).toHaveLength(1);

    const events = await db.select().from(activityEvents).where(eq(activityEvents.type, "duel"));
    expect(events[0].message).toBe('Picked "Alpha" over "Beta"');
  });

  it("rejects bad bodies", async () => {
    const a = await makeItem(libraryId);
    expect((await post("/api/duels", {})).statusCode).toBe(400);
    expect((await post("/api/duels", { winnerId: a, loserId: a })).statusCode).toBe(400);
    expect((await post("/api/duels", { winnerId: "1", loserId: 2 })).statusCode).toBe(400);
  });

  it("404s for photos or unknown ids", async () => {
    const a = await makeItem(libraryId);
    const photo = await makePhoto(libraryId);
    expect((await post("/api/duels", { winnerId: a, loserId: photo })).statusCode).toBe(404);
    expect((await post("/api/duels", { winnerId: a, loserId: 99999 })).statusCode).toBe(404);
  });

  it("requires sign-in", async () => {
    const res = await app.inject({ method: "POST", url: "/api/duels", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/duels/undo", () => {
  it("restores both scores and removes the duel", async () => {
    const a = await makeItem(libraryId);
    const b = await makeItem(libraryId);
    await post("/api/duels", { winnerId: a, loserId: b });

    const res = await post("/api/duels/undo");
    expect(res.statusCode).toBe(200);
    expect(await score(a)).toMatchObject({ score: 1000, count: 0 });
    expect(await score(b)).toMatchObject({ score: 1000, count: 0 });
    expect(await db.select().from(duels)).toHaveLength(0);
  });

  it("only undoes the latest duel", async () => {
    const a = await makeItem(libraryId);
    const b = await makeItem(libraryId);
    const c = await makeItem(libraryId);
    await post("/api/duels", { winnerId: a, loserId: b });
    await post("/api/duels", { winnerId: a, loserId: c });
    await post("/api/duels/undo");

    expect(await db.select().from(duels)).toHaveLength(1);
    expect(await score(a)).toMatchObject({ score: 1016, count: 1 });
    expect(await score(c)).toMatchObject({ score: 1000, count: 0 });
  });

  it("404s when there is nothing to undo", async () => {
    expect((await post("/api/duels/undo")).statusCode).toBe(404);
  });
});

describe("GET /api/duels/leaderboard", () => {
  it("ranks compared videos by score", async () => {
    const a = await makeItem(libraryId, { title: "Top" });
    const b = await makeItem(libraryId, { title: "Bottom" });
    await makeItem(libraryId, { title: "Never compared" });
    await post("/api/duels", { winnerId: a, loserId: b });

    const body = (await get("/api/duels/leaderboard")).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Top", "Bottom"]);
    expect(body.items[0].rank).toBe(1);
    expect(body.totalDuels).toBe(1);
    expect(body.canApply).toBe(false);
  });
});

describe("POST /api/duels/apply-ratings", () => {
  async function rankFive() {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await makeItem(libraryId, { title: `V${i}` }));
    // Ids earlier in the list beat every later one; three rounds gives everyone 3+ duels.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          await post("/api/duels", { winnerId: ids[i], loserId: ids[j] });
        }
      }
    }
    return ids;
  }

  it("refuses until enough videos are ranked", async () => {
    const res = await post("/api/duels/apply-ratings", {});
    expect(res.statusCode).toBe(400);
  });

  it("gives each fifth of the ranking a star bucket", async () => {
    const ids = await rankFive();
    const res = await post("/api/duels/apply-ratings", {});
    expect(res.json()).toMatchObject({ ok: true, updated: 5 });
    const ratings = await Promise.all(ids.map(async (id) => (await score(id)).rating));
    expect(ratings).toEqual([5, 4, 3, 2, 1]);
  });

  it("keeps existing ratings unless told to overwrite", async () => {
    const ids = await rankFive();
    await db.update(mediaItems).set({ rating: 2 }).where(eq(mediaItems.id, ids[0]));

    const kept = (await post("/api/duels/apply-ratings", {})).json();
    expect(kept.updated).toBe(4);
    expect((await score(ids[0])).rating).toBe(2);

    const over = (await post("/api/duels/apply-ratings", { overwrite: true })).json();
    expect(over.updated).toBe(5);
    expect((await score(ids[0])).rating).toBe(5);
  });
});
