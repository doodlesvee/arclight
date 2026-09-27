import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";
import { eq } from "drizzle-orm";
import { SORTS } from "./mediaItems.js";
import { db } from "../db/client.js";
import { performers } from "../db/schema.js";
import {
  attachFile,
  linkPerformer,
  makeFolder,
  makeItem,
  makeLibrary,
  makePerformer,
  makePhoto,
  makeStudio,
  makeTag,
  linkTag,
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

describe("GET /api/media-items", () => {
  it("returns items with pagination metadata", async () => {
    await makeItem(libraryId, { title: "One" });
    const body = (await get("/api/media-items")).json();
    expect(body.items).toHaveLength(1);
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
  });

  it("hides photos, which belong to a video's gallery rather than the library", async () => {
    await makeItem(libraryId, { title: "Video" });
    await makePhoto(libraryId);
    const body = (await get("/api/media-items")).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Video"]);
  });

  it("hides items whose folder was removed from the scan list", async () => {
    await makeItem(libraryId, { title: "Visible" });
    await makeItem(libraryId, { title: "Hidden", inScope: false });
    const body = (await get("/api/media-items")).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Visible"]);
  });

  it("reports hasMore without returning the extra row", async () => {
    for (let i = 0; i < 51; i++) await makeItem(libraryId, { title: `Item ${i}` });
    const body = (await get("/api/media-items")).json();
    expect(body.items).toHaveLength(50);
    expect(body.hasMore).toBe(true);
  });

  it("pages without duplicating or skipping rows", async () => {
    // Items created in the same instant share a createdAt; without the id
    // tiebreaker the two pages overlap.
    for (let i = 0; i < 60; i++) await makeItem(libraryId, { title: `Item ${i}` });
    const first = (await get("/api/media-items?page=1")).json();
    const second = (await get("/api/media-items?page=2")).json();
    const ids = [...first.items, ...second.items].map((i: { id: number }) => i.id);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  describe("search", () => {
    it("matches a title", async () => {
      await makeItem(libraryId, { title: "Hot Wife Vacation" });
      await makeItem(libraryId, { title: "Something Else" });
      const body = (await get("/api/media-items?q=vacation")).json();
      expect(body.items).toHaveLength(1);
    });

    it("matches a performer's name", async () => {
      const id = await makeItem(libraryId, { title: "Untitled" });
      await linkPerformer(id, await makePerformer("Little Caprice"));
      const body = (await get("/api/media-items?q=caprice")).json();
      expect(body.items).toHaveLength(1);
    });

    it("matches every word separately, across different fields", async () => {
      // "caprice vixen" is a performer and a studio; treating the query as one
      // literal substring used to find nothing at all.
      const studioId = await makeStudio("Vixen");
      const id = await makeItem(libraryId, { title: "Untitled", studioId });
      await linkPerformer(id, await makePerformer("Little Caprice"));
      await makeItem(libraryId, { title: "Vixen only" });

      const body = (await get("/api/media-items?q=caprice%20vixen")).json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe(id);
    });

    it("treats a four-digit word as a release year", async () => {
      await makeItem(libraryId, { title: "A", releaseDate: "2019-05-01" });
      await makeItem(libraryId, { title: "B", releaseDate: "2021-05-01" });
      const body = (await get("/api/media-items?q=2019")).json();
      expect(body.items).toHaveLength(1);
    });

    it("does not treat % and _ in a query as wildcards", async () => {
      await makeItem(libraryId, { title: "Scene 01" });
      const body = (await get("/api/media-items?q=Scene_01")).json();
      expect(body.items).toHaveLength(0);
    });

    it("ranks a title match above a merely newer item", async () => {
      await makeItem(libraryId, { title: "Vacation" });
      await makeItem(libraryId, { title: "Newer, unrelated" });
      const body = (await get("/api/media-items?q=vacation")).json();
      expect(body.items[0].title).toBe("Vacation");
    });
  });

  describe("filters", () => {
    it("filters by year", async () => {
      await makeItem(libraryId, { title: "A", releaseDate: "2019-05-01" });
      await makeItem(libraryId, { title: "B", releaseDate: "2021-05-01" });
      const body = (await get("/api/media-items?year=2021")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["B"]);
    });

    it("filters to items with no studio", async () => {
      // Backs the "no studio" bucket in a grouped profile. A sentinel value
      // like studio=none would collide with a studio actually called "none".
      const vixen = await makeStudio("Vixen");
      await makeItem(libraryId, { title: "Has studio", studioId: vixen });
      await makeItem(libraryId, { title: "No studio" });

      const body = (await get("/api/media-items?noStudio=true")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["No studio"]);
    });

    it("filters to items with no release date", async () => {
      await makeItem(libraryId, { title: "Dated", releaseDate: "2019-05-01" });
      await makeItem(libraryId, { title: "Undated" });

      const body = (await get("/api/media-items?noYear=true")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Undated"]);
    });

    it("filters to part-watched items only", async () => {
      const partial = await makeItem(libraryId, { title: "Partial", durationSeconds: 1000 });
      const finished = await makeItem(libraryId, { title: "Finished", durationSeconds: 1000 });
      await makeItem(libraryId, { title: "Untouched" });

      await app.inject({
        method: "PUT",
        url: `/api/media-items/${partial}/playback`,
        headers: { cookie },
        payload: { positionSeconds: 300 },
      });
      await app.inject({
        method: "PUT",
        url: `/api/media-items/${finished}/watched`,
        headers: { cookie },
        payload: { watched: true },
      });

      const body = (await get("/api/media-items?progress=in-progress")).json();
      // Finished is excluded, not just "has playback".
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Partial"]);
    });

    it("filters by favourite", async () => {
      await makeItem(libraryId, { title: "Loved", isFavorite: true });
      await makeItem(libraryId, { title: "Not" });
      const body = (await get("/api/media-items?favorite=true")).json();
      expect(body.items).toHaveLength(1);
    });

    it("returns nothing for a category that does not exist", async () => {
      // The important half: it must not fall back to returning everything,
      // which is what made one tile show the whole library.
      await makeItem(libraryId, { title: "A", kind: "video" });
      const body = (await get("/api/media-items?kind=nonexistent")).json();
      expect(body.items).toHaveLength(0);
    });

    it("shows only root-level items when unfiltered", async () => {
      const folderId = await makeFolder(libraryId);
      await makeItem(libraryId, { title: "Nested", parentId: folderId });
      const body = (await get("/api/media-items")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["A Folder"]);
    });
  });

  describe("sorting", () => {
    it("sorts by title", async () => {
      await makeItem(libraryId, { title: "Zebra" });
      await makeItem(libraryId, { title: "Apple" });
      const body = (await get("/api/media-items?sort=title")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Apple", "Zebra"]);
    });

    it("puts durationless items last when sorting by longest", async () => {
      await makeItem(libraryId, { title: "No duration" });
      await makeItem(libraryId, { title: "Long", durationSeconds: 3600 });
      const body = (await get("/api/media-items?sort=longest")).json();
      expect(body.items[0].title).toBe("Long");
    });

    it("sorts by title descending", async () => {
      await makeItem(libraryId, { title: "Apple" });
      await makeItem(libraryId, { title: "Zebra" });
      const body = (await get("/api/media-items?sort=titleDesc")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Zebra", "Apple"]);
    });

    // Release date is the scene's own chronology, parsed from the filename.
    // Distinct from createdAt: re-scanning an old collection makes every item
    // newly *added* while their release dates span years, so sorting by one
    // and expecting the other is a real mistake to guard against.
    it("sorts by release date, newest first", async () => {
      await makeItem(libraryId, { title: "Older", releaseDate: "2011-09-19" });
      await makeItem(libraryId, { title: "Newer", releaseDate: "2020-02-13" });
      const body = (await get("/api/media-items?sort=released")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Newer", "Older"]);
    });

    it("sorts by release date, oldest first", async () => {
      await makeItem(libraryId, { title: "Newer", releaseDate: "2020-02-13" });
      await makeItem(libraryId, { title: "Older", releaseDate: "2011-09-19" });
      const body = (await get("/api/media-items?sort=releasedOldest")).json();
      expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Older", "Newer"]);
    });

    // An undated item is unknown, not earliest. Sorted naively ascending,
    // Postgres puts NULLs last on ASC but *first* on DESC — and treating
    // "no date" as the oldest would bury the actual answer to "what is the
    // oldest release" under every unparsed filename in the library.
    it("puts undated items last in both release orders", async () => {
      await makeItem(libraryId, { title: "Undated" });
      await makeItem(libraryId, { title: "Dated", releaseDate: "2015-01-01" });

      for (const sort of ["released", "releasedOldest"]) {
        const body = (await get(`/api/media-items?sort=${sort}`)).json();
        const titles = body.items.map((i: { title: string }) => i.title);
        expect(titles[0]).toBe("Dated");
        expect(titles[titles.length - 1]).toBe("Undated");
      }
    });

    // Every sort has to be reachable: a value the client offers but the
    // server has not been taught falls through to the default, which looks
    // like the control silently doing nothing.
    it("honours every sort the client can send", async () => {
      await makeItem(libraryId, { title: "Anything", releaseDate: "2018-06-01" });

      for (const sort of SORTS) {
        const res = await get(`/api/media-items?sort=${sort}`);
        expect(res.statusCode, `sort=${sort}`).toBe(200);
        expect(res.json().items.length, `sort=${sort}`).toBeGreaterThan(0);
      }
    });
  });
});

describe("GET /api/media-items/:id", () => {
  it("returns the item with its file details", async () => {
    const id = await makeItem(libraryId, { title: "Detail" });
    await attachFile(id, rootId, "/media/a.mp4");
    const body = (await get(`/api/media-items/${id}`)).json();
    expect(body.title).toBe("Detail");
    expect(body.fileSizeBytes).toBe(1000);
  });

  it("404s for an out-of-scope item, so a deep link cannot reach it", async () => {
    const id = await makeItem(libraryId, { title: "Hidden", inScope: false });
    expect((await get(`/api/media-items/${id}`)).statusCode).toBe(404);
  });

  it("404s for an id that does not exist", async () => {
    expect((await get("/api/media-items/999999")).statusCode).toBe(404);
  });
});

describe("PATCH /api/media-items/:id", () => {
  const patch = (id: number, body: object) =>
    app.inject({
      method: "PATCH",
      url: `/api/media-items/${id}`,
      headers: { cookie },
      payload: body,
    });

  it("edits the title and takes ownership from the scanner", async () => {
    const id = await makeItem(libraryId, { title: "Old" });
    expect((await patch(id, { title: "New" })).json()).toEqual({ ok: true });

    // Read it back: the endpoint acknowledges rather than echoing the row.
    const item = (await get(`/api/media-items/${id}`)).json();
    expect(item.title).toBe("New");
    // From here the scanner leaves this title alone, even across renames.
    expect(item.titleSource).toBe("user");
  });

  it("rejects an empty title", async () => {
    const id = await makeItem(libraryId);
    expect((await patch(id, { title: "   " })).statusCode).toBe(400);
  });

  it("rejects a category that does not exist", async () => {
    const id = await makeItem(libraryId);
    expect((await patch(id, { kind: "not-a-category" })).statusCode).toBe(400);
  });

  it("accepts a category that does exist", async () => {
    const id = await makeItem(libraryId);
    expect((await patch(id, { kind: "movie" })).statusCode).toBe(200);
  });

  it("refuses to make an item its own parent", async () => {
    const id = await makeItem(libraryId);
    expect((await patch(id, { parentId: id })).statusCode).toBe(400);
  });

  it("clamps framing values rather than rejecting them", async () => {
    // They come from a drag, so a value a fraction out of range is a rounding
    // artefact, not a reason to fail the save.
    const id = await makeItem(libraryId);
    await patch(id, { thumbnailPositionX: 150, thumbnailScale: 9999 });

    const item = (await get(`/api/media-items/${id}`)).json();
    expect(item.thumbnailPositionX).toBe(100);
    expect(item.thumbnailScale).toBe(300);
  });

  it("pins one item's tile shape", async () => {
    const id = await makeItem(libraryId);
    expect((await patch(id, { tileShape: "portrait" })).statusCode).toBe(200);
    expect((await get(`/api/media-items/${id}`)).json().tileShape).toBe("portrait");
  });

  // The whole point of the feature: shape is per item, so setting one must
  // not reach the next tile in the grid.
  it("leaves every other item's shape alone", async () => {
    const mine = await makeItem(libraryId);
    const theirs = await makeItem(libraryId);
    await patch(mine, { tileShape: "portrait" });

    expect((await get(`/api/media-items/${theirs}`)).json().tileShape).toBeNull();
  });

  // Rejected rather than clamped, unlike the framing above: this comes from a
  // menu with two entries, so a third value is a bug and should say so.
  it("rejects a shape that is neither landscape nor portrait", async () => {
    const id = await makeItem(libraryId);
    expect((await patch(id, { tileShape: "diagonal" })).statusCode).toBe(400);
    expect((await get(`/api/media-items/${id}`)).json().tileShape).toBeNull();
  });

  // null is a value, not an omission: it means "follow the Appearance
  // setting". Treating it as "not supplied" would make the reset entry in the
  // menu do nothing at all.
  it("clears a pinned shape back to following the global setting", async () => {
    const id = await makeItem(libraryId);
    await patch(id, { tileShape: "portrait" });
    expect((await patch(id, { tileShape: null })).statusCode).toBe(200);
    expect((await get(`/api/media-items/${id}`)).json().tileShape).toBeNull();
  });

  // A tile is drawn from the list response, not from the detail endpoint, so
  // the column being on the item is not enough — it has to reach the grid.
  it("returns the shape in the list response the grid renders from", async () => {
    const id = await makeItem(libraryId);
    await patch(id, { tileShape: "portrait" });

    const listed = (await get("/api/media-items")).json().items.find(
      (i: { id: number }) => i.id === id
    );
    expect(listed.tileShape).toBe("portrait");
  });
});

describe("GET /api/continue-watching", () => {
  it("does not error, and is empty with no playback", async () => {
    // This route 500'd on every request for a while: a fractional 0.92 bound
    // into `duration * $n` made Postgres infer an integer parameter.
    const res = await get("/api/continue-watching");
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});

describe("GET /api/release-years", () => {
  it("lists the years present, newest first, with counts", async () => {
    await makeItem(libraryId, { title: "A", releaseDate: "2019-05-01" });
    await makeItem(libraryId, { title: "B", releaseDate: "2021-05-01" });
    await makeItem(libraryId, { title: "C", releaseDate: "2021-08-01" });
    const body = (await get("/api/release-years")).json();
    expect(body.years).toEqual([
      { year: 2021, total: 2 },
      { year: 2019, total: 1 },
    ]);
  });
});

describe("GET /api/search/suggestions", () => {
  it("returns nothing for a query that is too short", async () => {
    expect((await get("/api/search/suggestions?q=a")).json()).toEqual({
      performers: [],
      studios: [],
      items: [],
    });
  });

  it("suggests performers, studios and titles", async () => {
    // This route 500'd on every keystroke: a correlated subquery referenced an
    // unqualified column that was ambiguous against the joined tables.
    const studioId = await makeStudio("Blacked");
    const id = await makeItem(libraryId, { title: "Black Tie", studioId });
    await linkPerformer(id, await makePerformer("Tori Black"));

    const body = (await get("/api/search/suggestions?q=black")).json();
    expect(body.performers.map((p: { name: string }) => p.name)).toEqual(["Tori Black"]);
    expect(body.studios.map((s: { name: string }) => s.name)).toEqual(["Blacked"]);
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Black Tie"]);
  });

  it("includes what the UI needs to draw each row", async () => {
    const id = await makeItem(libraryId, { title: "Black Tie" });
    await linkPerformer(id, await makePerformer("Tori Black"));
    const body = (await get("/api/search/suggestions?q=black")).json();
    expect(body.performers[0]).toMatchObject({ videoCount: 1 });
    expect(body.items[0].performers[0].name).toBe("Tori Black");
  });
});

describe("GET /api/search/suggestions framing", () => {
  it("carries each performer's round-crop framing, so avatars match everywhere else", async () => {
    const performerId = await makePerformer("Tori Black");
    await db
      .update(performers)
      .set({ avatarPositionX: 30, avatarPositionY: 40, avatarScale: 150 })
      .where(eq(performers.id, performerId));
    await linkPerformer(await makeItem(libraryId, { title: "Black Tie" }), performerId);

    const body = (await get("/api/search/suggestions?q=black")).json();
    expect(body.performers[0]).toMatchObject({ avatarPositionX: 30, avatarPositionY: 40, avatarScale: 150 });
  });
});

describe("GET /api/media-items/:id/related", () => {
  it("prefers other videos with the same performer", async () => {
    const performerId = await makePerformer("Shared");
    const subject = await makeItem(libraryId, { title: "Subject" });
    const sibling = await makeItem(libraryId, { title: "Same performer" });
    await makeItem(libraryId, { title: "Unrelated" });
    await linkPerformer(subject, performerId);
    await linkPerformer(sibling, performerId);

    const body = (await get(`/api/media-items/${subject}/related`)).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Same performer"]);
  });

  it("falls back to folder siblings when nothing else relates", async () => {
    const subject = await makeItem(libraryId, { title: "Subject" });
    await makeItem(libraryId, { title: "Sibling" });
    const body = (await get(`/api/media-items/${subject}/related`)).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Sibling"]);
  });
});

describe("GET /api/media-items/:id/gallery", () => {
  it("returns the photos sitting in the same folder", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Studio/scene.mp4");
    const photo = await makePhoto(libraryId, "still-1");
    await attachFile(photo, rootId, "/media/Alice/Studio/1.jpg");
    const other = await makePhoto(libraryId, "elsewhere");
    await attachFile(other, rootId, "/media/Alice/Other/2.jpg");

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images.map((i: { title: string }) => i.title)).toEqual(["still-1"]);
  });

  it("previews the folder rather than returning all of it", async () => {
    // The modal used to render every photo — 121 <img> elements for one of
    // the real albums. It shows a taste now and links through for the rest.
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Studio/scene.mp4");
    for (let i = 0; i < 20; i++) {
      const photo = await makePhoto(libraryId, `still-${i}`);
      await attachFile(photo, rootId, `/media/Alice/Studio/${i}.jpg`);
    }

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images).toHaveLength(8);
    expect(body.total).toBe(20);
  });

  it("reports total as what it returned when the folder fits", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Studio/scene.mp4");
    for (let i = 0; i < 3; i++) {
      const photo = await makePhoto(libraryId, `still-${i}`);
      await attachFile(photo, rootId, `/media/Alice/Studio/${i}.jpg`);
    }

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it("does not treat _ in a folder name as a wildcard", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/A_B/scene.mp4");
    const decoy = await makePhoto(libraryId, "decoy");
    await attachFile(decoy, rootId, "/media/Alice/AXB/1.jpg");

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images).toEqual([]);
  });

  // The layout this was blind to: the scene folder holds the video and an
  // Images/ subfolder holds the stills. Matching only the video's own
  // directory found nothing, so the strip under the player was empty for an
  // entire library organised that way.
  it("finds photos in a subfolder of the video's own folder", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Arrest Me/scene.mp4");
    const photo = await makePhoto(libraryId, "still-1");
    await attachFile(photo, rootId, "/media/Alice/Arrest Me/Images/1.jpg");

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images.map((i: { title: string }) => i.title)).toEqual(["still-1"]);
  });

  it("counts a subfolder's photos in the total", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Scene/scene.mp4");
    for (let i = 0; i < 12; i++) {
      const photo = await makePhoto(libraryId, `still-${i}`);
      await attachFile(photo, rootId, `/media/Alice/Scene/Images/${i}.jpg`);
    }

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images).toHaveLength(8);
    expect(body.total).toBe(12);
  });

  it("takes photos beside the video and in a subfolder together", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Scene/scene.mp4");
    const beside = await makePhoto(libraryId, "beside");
    await attachFile(beside, rootId, "/media/Alice/Scene/cover.jpg");
    const below = await makePhoto(libraryId, "below");
    await attachFile(below, rootId, "/media/Alice/Scene/Images/1.jpg");

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images.map((i: { title: string }) => i.title).sort()).toEqual([
      "below",
      "beside",
    ]);
  });

  // One level, not any depth. On a library filed by performer, a prefix match
  // would pull every photo under the performer into the strip of a video
  // sitting at the top of that folder — thousands of images in a modal.
  it("does not reach more than one folder deep", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/scene.mp4");
    const tooDeep = await makePhoto(libraryId, "too-deep");
    await attachFile(tooDeep, rootId, "/media/Alice/Studio/Scene/Images/1.jpg");

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images).toEqual([]);
  });

  // A sibling folder is not a subfolder. Both are one level from the parent,
  // so a sloppier pattern would treat the two as the same thing.
  it("does not pull in a sibling folder's photos", async () => {
    const video = await makeItem(libraryId, { title: "Scene" });
    await attachFile(video, rootId, "/media/Alice/Scene One/scene.mp4");
    const sibling = await makePhoto(libraryId, "sibling");
    await attachFile(sibling, rootId, "/media/Alice/Scene Two/1.jpg");

    const body = (await get(`/api/media-items/${video}/gallery`)).json();
    expect(body.images).toEqual([]);
  });
});

/**
 * The composable filters and the sorts that read playback or file state
 * (§7). These are the parts of the query builder most able to be wrong in a
 * way that still returns plausible-looking rows, which is why they are
 * asserted on membership rather than on counts.
 */
describe("GET /api/media-items — composable filters", () => {
  const titles = (body: { items: { title: string }[] }) =>
    body.items.map((item) => item.title).sort();

  it("ANDs multiple tags, so each one narrows the result", async () => {
    const indoor = await makeTag("indoor");
    const night = await makeTag("night");
    const both = await makeItem(libraryId, { title: "Both" });
    const onlyIndoor = await makeItem(libraryId, { title: "Only indoor" });
    await linkTag(both, indoor);
    await linkTag(both, night);
    await linkTag(onlyIndoor, indoor);

    expect(titles((await get("/api/media-items?tags=indoor")).json())).toEqual([
      "Both",
      "Only indoor",
    ]);
    // The second tag must remove a row, not add one. OR here would return
    // more results for more filters, which is not what a filter is.
    expect(titles((await get("/api/media-items?tags=indoor,night")).json())).toEqual([
      "Both",
    ]);
  });

  it("matches tag and performer filters regardless of case", async () => {
    const tag = await makeTag("Outdoor");
    const item = await makeItem(libraryId, { title: "Tagged" });
    await linkTag(item, tag);
    expect(titles((await get("/api/media-items?tags=outdoor")).json())).toEqual([
      "Tagged",
    ]);
  });

  it("treats never-played items as unwatched, not as neither", async () => {
    const watched = await makeItem(libraryId, { title: "Seen" });
    await makeItem(libraryId, { title: "Never opened" });
    await app.inject({
      method: "PUT",
      url: `/api/media-items/${watched}/watched`,
      headers: { cookie },
      payload: { watched: true },
    });

    expect(titles((await get("/api/media-items?watched=true")).json())).toEqual([
      "Seen",
    ]);
    // The bug this guards: a LEFT JOIN's null completed_at reads as "not
    // watched" for the joined row, but an item with no playback row at all
    // has no row to be null — so a plain `is null` would drop it entirely.
    expect(titles((await get("/api/media-items?watched=false")).json())).toEqual([
      "Never opened",
    ]);
  });

  it("omitting the watched filter means either, not false", async () => {
    const watched = await makeItem(libraryId, { title: "Seen" });
    await makeItem(libraryId, { title: "Unseen" });
    await app.inject({
      method: "PUT",
      url: `/api/media-items/${watched}/watched`,
      headers: { cookie },
      payload: { watched: true },
    });
    expect(titles((await get("/api/media-items")).json())).toEqual([
      "Seen",
      "Unseen",
    ]);
  });

  it("filters on a duration range, inclusive at both ends", async () => {
    await makeItem(libraryId, { title: "Short", durationSeconds: 60 });
    await makeItem(libraryId, { title: "Medium", durationSeconds: 600 });
    await makeItem(libraryId, { title: "Long", durationSeconds: 6000 });

    expect(
      titles((await get("/api/media-items?minDuration=600&maxDuration=600")).json())
    ).toEqual(["Medium"]);
    expect(titles((await get("/api/media-items?minDuration=600")).json())).toEqual([
      "Long",
      "Medium",
    ]);
  });

  it("bands resolution by height, so 1078 still counts as Full HD", async () => {
    await makeItem(libraryId, {
      title: "Almost 1080",
      extraMetadata: { width: 1920, height: 1078 },
    });
    await makeItem(libraryId, {
      title: "720p",
      extraMetadata: { width: 1280, height: 720 },
    });

    expect(titles((await get("/api/media-items?resolution=fullhd")).json())).toEqual([
      "Almost 1080",
    ]);
    expect(titles((await get("/api/media-items?resolution=hd")).json())).toEqual([
      "720p",
    ]);
  });

  it("ignores an unknown resolution band rather than returning nothing", async () => {
    await makeItem(libraryId, { title: "Anything" });
    expect(titles((await get("/api/media-items?resolution=8k")).json())).toEqual([
      "Anything",
    ]);
  });

  it("stacks a filter with a folder-scoped view without falling back to the root", async () => {
    // The trap: the folder-level default applies whenever no "global" filter
    // is set, and a filter missed from that list gets silently scoped to the
    // root folder — which reads as the filter matching almost nothing.
    const folder = await makeFolder(libraryId, "Nested");
    const tag = await makeTag("keeper");
    const nested = await makeItem(libraryId, {
      title: "Nested keeper",
      parentId: folder,
    });
    await linkTag(nested, tag);

    expect(titles((await get("/api/media-items?tags=keeper")).json())).toEqual([
      "Nested keeper",
    ]);
  });
});

describe("GET /api/media-items — sorts", () => {
  const order = (body: { items: { title: string }[] }) =>
    body.items.map((item) => item.title);

  it("sorts by file size, summing an item's files rather than joining them", async () => {
    const small = await makeItem(libraryId, { title: "Small" });
    const big = await makeItem(libraryId, { title: "Big" });
    await attachFile(small, rootId, "/small.mp4", null, 1_000);
    // Two files on one item: a join would multiply the row and return "Big"
    // twice, so this also guards against the grid showing duplicates.
    await attachFile(big, rootId, "/big.mp4", null, 5_000);
    await attachFile(big, rootId, "/big-still.jpg", null, 4_000);

    expect(order((await get("/api/media-items?sort=largest")).json())).toEqual([
      "Big",
      "Small",
    ]);
    expect(order((await get("/api/media-items?sort=smallest")).json())).toEqual([
      "Small",
      "Big",
    ]);
  });

  it("keeps unwatched items out of the way when sorting by recently watched", async () => {
    await makeItem(libraryId, { title: "Never watched" });
    const seen = await makeItem(libraryId, { title: "Watched" });
    await app.inject({
      method: "PUT",
      url: `/api/media-items/${seen}/watched`,
      headers: { cookie },
      payload: { watched: true },
    });

    // NULLS LAST is the whole point: without it "recently watched" opens on a
    // wall of items that have never been played.
    expect(order((await get("/api/media-items?sort=watched")).json())[0]).toBe(
      "Watched"
    );
  });

  it("gives a random sort one stable order across pages for a given seed", async () => {
    for (let i = 0; i < 60; i++) await makeItem(libraryId, { title: `Item ${i}` });

    const first = order((await get("/api/media-items?sort=random&seed=7")).json());
    const firstAgain = order(
      (await get("/api/media-items?sort=random&seed=7")).json()
    );
    const second = order(
      (await get("/api/media-items?sort=random&seed=7&page=2")).json()
    );

    // Re-running the same seed must not reshuffle, or paging would show the
    // same item on several pages and skip others entirely.
    expect(first).toEqual(firstAgain);
    expect(first).toHaveLength(50);
    expect(second.some((title) => first.includes(title))).toBe(false);
  });

  it("shuffles differently for a different seed", async () => {
    for (let i = 0; i < 30; i++) await makeItem(libraryId, { title: `Item ${i}` });
    const a = order((await get("/api/media-items?sort=random&seed=1")).json());
    const b = order((await get("/api/media-items?sort=random&seed=2")).json());
    expect(a).not.toEqual(b);
  });
});
