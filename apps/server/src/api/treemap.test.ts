import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { attachFile, makeItem, makeLibrary } from "../test/fixtures.js";

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

const treemap = (path?: string) =>
  app.inject({
    method: "GET",
    url: `/api/storage/treemap${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    headers: { cookie },
  });

async function file(path: string, bytes: number, extra = {}) {
  const id = await makeItem(libraryId, extra);
  await attachFile(id, rootId, path, null, bytes);
  return id;
}

describe("GET /api/storage/treemap", () => {
  it("lists the watched folders with their total size", async () => {
    await file("/media/a/one.mp4", 100);
    await file("/media/b/two.mp4", 300);

    const body = (await treemap()).json();
    expect(body.path).toBeNull();
    expect(body.nodes).toEqual([{ name: "/media", path: "/media", bytes: 400, files: 2 }]);
    expect(body.totalBytes).toBe(400);
  });

  it("splits a folder into subfolders, biggest first, and groups loose files", async () => {
    await file("/media/small/a.mp4", 100);
    await file("/media/big/b.mp4", 500);
    await file("/media/big/deep/c.mp4", 200);
    await file("/media/loose.mp4", 50);

    const body = (await treemap("/media")).json();
    expect(body.parent).toBeNull();
    expect(body.nodes).toEqual([
      { name: "big", path: "/media/big", bytes: 700, files: 2 },
      { name: "small", path: "/media/small", bytes: 100, files: 1 },
      { name: "Files in this folder", path: null, bytes: 50, files: 1 },
    ]);
  });

  it("drills down and points back to the parent", async () => {
    await file("/media/big/b.mp4", 500);
    await file("/media/big/deep/c.mp4", 200);

    const body = (await treemap("/media/big")).json();
    expect(body.parent).toBe("/media");
    expect(body.nodes.map((n: { name: string }) => n.name)).toEqual([
      "deep",
      "Files in this folder",
    ]);
  });

  it("leaves out missing and out-of-scope items", async () => {
    await file("/media/a/one.mp4", 100);
    await file("/media/a/gone.mp4", 900, { missingSince: new Date() });
    await file("/media/a/out.mp4", 900, { inScope: false });

    const body = (await treemap("/media")).json();
    expect(body.totalBytes).toBe(100);
  });

  it("refuses paths outside the watched folders", async () => {
    expect((await treemap("/etc")).statusCode).toBe(400);
    expect((await treemap("/media/../etc")).statusCode).toBe(400);
  });
});
