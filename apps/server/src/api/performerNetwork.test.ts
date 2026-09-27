import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import {
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

beforeAll(async () => {
  app = await testApp();
});
beforeEach(async () => {
  await resetDatabase();
  cookie = await signIn();
  ({ libraryId } = await makeLibrary());
});

const network = async () =>
  (await app.inject({ method: "GET", url: "/api/performers/network", headers: { cookie } })).json();

describe("GET /api/performers/network", () => {
  it("joins each pair once, weighted by the videos they share", async () => {
    const ann = await makePerformer("Ann");
    const bea = await makePerformer("Bea");
    const cat = await makePerformer("Cat");
    for (let n = 0; n < 2; n++) {
      const item = await makeItem(libraryId, { title: `AB${n}` });
      await linkPerformer(item, ann);
      await linkPerformer(item, bea);
    }
    const trio = await makeItem(libraryId, { title: "ABC" });
    for (const id of [ann, bea, cat]) await linkPerformer(trio, id);

    const body = await network();
    const pairs = body.edges
      .map((e: { source: number; target: number; together: number }) => [
        Math.min(e.source, e.target),
        Math.max(e.source, e.target),
        e.together,
      ])
      .sort();
    expect(pairs).toEqual(
      [
        [ann, bea, 3],
        [ann, cat, 1],
        [bea, cat, 1],
      ].sort()
    );
    expect(body.nodes.find((n: { id: number }) => n.id === ann).videoCount).toBe(3);
  });

  it("leaves out archived performers and every link to them", async () => {
    const ann = await makePerformer("Ann");
    const bea = await makePerformer("Bea");
    const cat = await makePerformer("Cat");
    const studio = await makeStudio("Shared");
    const trio = await makeItem(libraryId, { title: "ABC", studioId: studio });
    for (const id of [ann, bea, cat]) await linkPerformer(trio, id);
    await app.inject({
      method: "PATCH",
      url: `/api/performers/${cat}`,
      headers: { cookie },
      payload: { archived: true },
    });

    for (const by of ["videos", "studios"]) {
      const body = (
        await app.inject({ method: "GET", url: `/api/performers/network?by=${by}`, headers: { cookie } })
      ).json();
      expect(body.nodes.map((n: { id: number }) => n.id).sort()).toEqual([ann, bea].sort());
      for (const e of body.edges as { source: number; target: number }[]) {
        expect([e.source, e.target]).not.toContain(cat);
      }
      expect(body.edges).toHaveLength(1);
    }
  });

  it("leaves out performers with no videos, and ignores photos", async () => {
    const solo = await makePerformer("Solo");
    await makePerformer("Nobody");
    const pic = await makePhoto(libraryId);
    const other = await makePerformer("Other");
    await linkPerformer(pic, solo);
    await linkPerformer(pic, other);
    const video = await makeItem(libraryId);
    await linkPerformer(video, solo);

    const body = await network();
    expect(body.nodes.map((n: { name: string }) => n.name)).toEqual(["Solo"]);
    expect(body.edges).toEqual([]);
  });

  it("colours a performer by the studio they appear with most", async () => {
    const ann = await makePerformer("Ann");
    const big = await makeStudio("Big");
    const small = await makeStudio("Small");
    for (const studioId of [big, big, small]) {
      await linkPerformer(await makeItem(libraryId, { studioId }), ann);
    }

    const [node] = (await network()).nodes;
    expect(node.topStudio).toBe("Big");
  });
});

describe("GET /api/performers/network?by=…", () => {
  const networkBy = async (by: string) =>
    (
      await app.inject({ method: "GET", url: `/api/performers/network?by=${by}`, headers: { cookie } })
    ).json();

  it("links performers who worked for the same studio, even without a shared video", async () => {
    const ann = await makePerformer("Ann");
    const bea = await makePerformer("Bea");
    const cat = await makePerformer("Cat");
    const harbor = await makeStudio("Harbor");
    const other = await makeStudio("Other");
    await linkPerformer(await makeItem(libraryId, { studioId: harbor }), ann);
    await linkPerformer(await makeItem(libraryId, { studioId: harbor }), bea);
    await linkPerformer(await makeItem(libraryId, { studioId: other }), cat);

    const body = await networkBy("studios");
    expect(body.by).toBe("studios");
    expect(body.edges).toEqual([
      { source: Math.min(ann, bea), target: Math.max(ann, bea), together: 1, shared: ["Harbor"] },
    ]);
  });

  it("sends the studios themselves, and who has worked for each, in studio mode", async () => {
    const ann = await makePerformer("Ann");
    const harbor = await makeStudio("Harbor");
    for (let n = 0; n < 2; n++) {
      await linkPerformer(await makeItem(libraryId, { studioId: harbor }), ann);
    }
    // A video with no performer still counts towards the studio's size.
    await makeItem(libraryId, { studioId: harbor });

    const body = await networkBy("studios");
    expect(body.studios).toEqual([{ id: harbor, name: "Harbor", videoCount: 3 }]);
    expect(body.memberships).toEqual([{ performerId: ann, studioId: harbor, videos: 2 }]);
    // Other modes leave them out rather than sending unused rows.
    expect((await networkBy("videos")).studios).toBeUndefined();
  });

  it("totals what the highlights and hover cards show", async () => {
    const ann = await makePerformer("Ann");
    const harbor = await makeStudio("Harbor");
    const mono = await makeStudio("Mono");
    await linkPerformer(
      await makeItem(libraryId, { studioId: harbor, rating: 4, durationSeconds: 600 }),
      ann
    );
    await linkPerformer(await makeItem(libraryId, { studioId: mono, rating: 2 }), ann);

    const [node] = (await networkBy("videos")).nodes;
    expect(node).toMatchObject({ studioCount: 2, watchedSeconds: 0, averageRating: 3 });
  });

  it("falls back to shared videos for anything it doesn't recognise", async () => {
    expect((await networkBy("nonsense")).by).toBe("videos");
  });
});
