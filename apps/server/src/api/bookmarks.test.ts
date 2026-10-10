import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { makeItem, makeLibrary } from "../test/fixtures.js";
import { deleteItems } from "../library/forget.js";
import { db } from "../db/client.js";
import { bookmarks } from "../db/schema.js";

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

const request = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });

describe("bookmarks", () => {
  it("creates, lists in playback order, relabels and deletes", async () => {
    const id = await makeItem(libraryId, { durationSeconds: 600 });

    const late = await request("POST", `/api/media-items/${id}/bookmarks`, { positionSeconds: 400.7, label: "  Late  " });
    expect(late.statusCode).toBe(201);
    expect(late.json()).toMatchObject({ positionSeconds: 400, label: "Late", note: null });
    await request("POST", `/api/media-items/${id}/bookmarks`, { positionSeconds: 30 });

    const list = (await request("GET", `/api/media-items/${id}/bookmarks`)).json();
    expect(list.bookmarks.map((b: { positionSeconds: number }) => b.positionSeconds)).toEqual([30, 400]);
    expect(list.bookmarks[0].label).toBeNull();

    const bookmarkId = late.json().id;
    const renamed = await request("PATCH", `/api/bookmarks/${bookmarkId}`, { label: "" });
    expect(renamed.json().label).toBeNull();

    expect((await request("DELETE", `/api/bookmarks/${bookmarkId}`)).statusCode).toBe(200);
    expect((await request("DELETE", `/api/bookmarks/${bookmarkId}`)).statusCode).toBe(404);
    expect((await request("GET", `/api/media-items/${id}/bookmarks`)).json().bookmarks).toHaveLength(1);
  });

  it("clamps a position past the end of the video", async () => {
    const id = await makeItem(libraryId, { durationSeconds: 100 });
    const res = await request("POST", `/api/media-items/${id}/bookmarks`, { positionSeconds: 100.4 });
    expect(res.json().positionSeconds).toBe(100);
  });

  it("saves and clears a note without changing the bookmark label", async () => {
    const id = await makeItem(libraryId);
    const created = await request("POST", `/api/media-items/${id}/bookmarks`, {
      positionSeconds: 52,
      label: "Favorite shot",
    });
    const bookmarkId = created.json().id;

    const annotated = await request("PATCH", `/api/bookmarks/${bookmarkId}`, {
      note: "  Notice the detail in the background.  ",
    });
    expect(annotated.statusCode).toBe(200);
    expect(annotated.json()).toMatchObject({
      label: "Favorite shot",
      note: "Notice the detail in the background.",
    });

    const cleared = await request("PATCH", `/api/bookmarks/${bookmarkId}`, { note: "  " });
    expect(cleared.json()).toMatchObject({ label: "Favorite shot", note: null });
  });

  it("rejects a non-text annotation", async () => {
    const id = await makeItem(libraryId);
    const created = await request("POST", `/api/media-items/${id}/bookmarks`, { positionSeconds: 12 });
    const result = await request("PATCH", `/api/bookmarks/${created.json().id}`, { note: 42 });
    expect(result.statusCode).toBe(400);
  });

  it("rejects a bad position and an unknown item", async () => {
    const id = await makeItem(libraryId);
    expect((await request("POST", `/api/media-items/${id}/bookmarks`, { positionSeconds: -1 })).statusCode).toBe(400);
    expect((await request("POST", `/api/media-items/${id}/bookmarks`, {})).statusCode).toBe(400);
    expect((await request("POST", `/api/media-items/99999/bookmarks`, { positionSeconds: 5 })).statusCode).toBe(404);
  });

  it("goes with the item when the item is deleted", async () => {
    const id = await makeItem(libraryId);
    await request("POST", `/api/media-items/${id}/bookmarks`, { positionSeconds: 5 });
    await deleteItems([id]);
    expect(await db.select().from(bookmarks)).toHaveLength(0);
  });
});

describe("ratings", () => {
  it("sets, clears and validates a rating", async () => {
    const id = await makeItem(libraryId);
    expect((await request("PATCH", `/api/media-items/${id}`, { rating: 4 })).statusCode).toBe(200);
    expect((await request("GET", `/api/media-items/${id}`)).json().rating).toBe(4);

    expect((await request("PATCH", `/api/media-items/${id}`, { rating: null })).statusCode).toBe(200);
    expect((await request("GET", `/api/media-items/${id}`)).json().rating).toBeNull();

    for (const bad of [0, 6, 3.5, "4"]) {
      expect((await request("PATCH", `/api/media-items/${id}`, { rating: bad })).statusCode).toBe(400);
    }
  });

  it("sorts by rating with unrated last, and filters on a floor", async () => {
    await makeItem(libraryId, { title: "Unrated" });
    await makeItem(libraryId, { title: "Two", rating: 2 });
    await makeItem(libraryId, { title: "Five", rating: 5 });

    const sorted = (await request("GET", "/api/media-items?sort=rating")).json();
    expect(sorted.items.map((i: { title: string }) => i.title)).toEqual(["Five", "Two", "Unrated"]);

    const filtered = (await request("GET", "/api/media-items?minRating=3")).json();
    expect(filtered.items.map((i: { title: string }) => i.title)).toEqual(["Five"]);
  });
});
