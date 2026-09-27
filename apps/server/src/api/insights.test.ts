import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { linkPerformer, makeItem, makeLibrary, makePerformer, makeStudio } from "../test/fixtures.js";
import { secondsWatched } from "./playback.js";
import { deleteItems } from "../library/forget.js";
import { db } from "../db/client.js";
import { watchLog } from "../db/schema.js";

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

const put = (id: number, positionSeconds: number) =>
  app.inject({
    method: "PUT",
    url: `/api/media-items/${id}/playback`,
    headers: { cookie },
    payload: { positionSeconds },
  });
const insights = async () =>
  (await app.inject({ method: "GET", url: "/api/insights", headers: { cookie } })).json();

describe("secondsWatched", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
  it("counts the distance played since the last report", () => {
    expect(secondsWatched({ positionSeconds: 10, updatedAt: at(0) }, 20, at(10))).toBe(10);
  });
  it("ignores a seek forward, a rewind, and a stale report", () => {
    expect(secondsWatched({ positionSeconds: 10, updatedAt: at(0) }, 600, at(10))).toBe(0);
    expect(secondsWatched({ positionSeconds: 60, updatedAt: at(0) }, 20, at(10))).toBe(0);
    expect(secondsWatched({ positionSeconds: 10, updatedAt: at(0) }, 20, at(500))).toBe(0);
  });
  it("counts nothing for the first report of a video", () => {
    expect(secondsWatched(undefined, 20, at(10))).toBe(0);
  });
});

describe("GET /api/insights", () => {
  it("counts saved bookmarks for the trophy shelf", async () => {
    const item = await makeItem(libraryId);
    expect((await insights()).bookmarkCount).toBe(0);
    for (const positionSeconds of [5, 42]) {
      await app.inject({
        method: "POST",
        url: `/api/media-items/${item}/bookmarks`,
        headers: { cookie },
        payload: { positionSeconds },
      });
    }
    expect((await insights()).bookmarkCount).toBe(2);
  });

  it("logs time as the player reports progress", async () => {
    const item = await makeItem(libraryId);
    await put(item, 0);
    // Two reports in quick succession: the second moved 2s in well under 2s
    // of wall time plus slack, so it counts.
    await put(item, 2);
    const body = await insights();
    expect(body.log).toHaveLength(1);
    expect(body.log[0]).toMatchObject({ mediaItemId: item, seconds: 2 });
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([item]);
  });

  it("forgets an item's watch history when the item is deleted", async () => {
    const kept = await makeItem(libraryId);
    const gone = await makeItem(libraryId);
    for (const id of [kept, gone]) {
      await put(id, 0);
      await put(id, 2);
    }
    await deleteItems([gone]);
    const rows = await db.select().from(watchLog);
    expect(rows.map((row) => row.mediaItemId)).toEqual([kept]);
  });

  it("totals each performer's and studio's videos and how many are finished", async () => {
    const ann = await makePerformer("Ann");
    const harbor = await makeStudio("Harbor");
    const one = await makeItem(libraryId, { studioId: harbor });
    const two = await makeItem(libraryId, { studioId: harbor });
    await linkPerformer(one, ann);
    await linkPerformer(two, ann);
    await app.inject({
      method: "PUT",
      url: `/api/media-items/${one}/watched`,
      headers: { cookie },
      payload: { watched: true },
    });

    const body = await insights();
    expect(body.performers).toEqual([
      expect.objectContaining({ name: "Ann", videoCount: 2, finishedCount: 1 }),
    ]);
    expect(body.studios).toEqual([{ name: "Harbor", videoCount: 2, finishedCount: 1 }]);
  });
});
