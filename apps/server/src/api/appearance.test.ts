import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDatabase, signIn, testApp } from "../test/harness.js";

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await testApp();
});
beforeEach(async () => {
  await resetDatabase();
  cookie = await signIn();
});

async function save(body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/appearance",
    headers: { cookie },
    payload: body,
  });
}

async function load() {
  const res = await app.inject({
    method: "GET",
    url: "/api/appearance",
    headers: { cookie },
  });
  return (res.json() as { appearance: Record<string, unknown> }).appearance;
}

describe("appearance settings", () => {
  // The allowlist is the whole point of this endpoint, and forgetting to
  // extend it is silent: the setting works until it round-trips the server,
  // then reverts with nothing logged anywhere.
  it("keeps the two banner heights apart", async () => {
    await save({ heroHeight: 90, bannerHeight: 40 });
    expect(await load()).toMatchObject({ heroHeight: 90, bannerHeight: 40 });
  });

  it("stores the preview-on-open preference", async () => {
    await save({ modalPreview: false });
    expect(await load()).toMatchObject({ modalPreview: false });
  });

  it("stores the ambient light preference", async () => {
    await save({ ambientLight: false });
    expect(await load()).toMatchObject({ ambientLight: false });
  });

  it("stores the screensaver preference", async () => {
    await save({ screensaver: false });
    expect(await load()).toMatchObject({ screensaver: false });
  });

  it("stores the pinned main event, and 0 to unpin it", async () => {
    await save({ hallOfFamePin: 1472 });
    expect(await load()).toMatchObject({ hallOfFamePin: 1472 });
    await save({ hallOfFamePin: 0 });
    expect(await load()).toMatchObject({ hallOfFamePin: 0 });
  });

  it("stores the screensaver's settings, keeping them in range", async () => {
    await save({
      screensaverMinutes: 500,
      screensaverSeconds: 8,
      screensaverSource: "favourites",
      screensaverClock: false,
    });
    expect(await load()).toMatchObject({
      screensaverMinutes: 60,
      screensaverSeconds: 8,
      screensaverSource: "favourites",
      screensaverClock: false,
    });
  });

  it("clamps a height to the range the slider offers", async () => {
    await save({ heroHeight: 5000, bannerHeight: -20 });
    expect(await load()).toMatchObject({ heroHeight: 100, bannerHeight: 30 });
  });

  it("drops a key it does not recognise rather than failing the save", async () => {
    const res = await save({ heroHeight: 55, somethingElse: "nonsense" });
    expect(res.statusCode).toBe(200);
    const stored = await load();
    expect(stored).toMatchObject({ heroHeight: 55 });
    expect(stored).not.toHaveProperty("somethingElse");
  });

  it("stores the view mode and density", async () => {
    await save({ viewMode: "large", density: "dense" });
    expect(await load()).toMatchObject({ viewMode: "large", density: "dense" });
  });

  it("drops a view mode that is not one of the real ones", async () => {
    await save({ viewMode: "hologram" });
    expect(await load()).not.toHaveProperty("viewMode");
  });

  // The failure this guards against is the one the module's own comment
  // describes: a setting added to the client and not to ENUM_KEYS saves
  // locally, looks like it worked, and reverts on the next round-trip with
  // nothing logged anywhere.
  it("stores the tile shape", async () => {
    await save({ tileShape: "portrait" });
    expect(await load()).toMatchObject({ tileShape: "portrait" });
  });

  it("drops a tile shape that is not one of the two", async () => {
    await save({ tileShape: "diagonal" });
    expect(await load()).not.toHaveProperty("tileShape");
  });

  it("ignores a height that is not a number", async () => {
    await save({ heroHeight: "tall" });
    expect(await load()).not.toHaveProperty("heroHeight");
  });
});

/**
 * Every setting the client can send must survive a round-trip.
 *
 * This allowlist is silent when it is wrong: the setting works, persists to
 * localStorage, and then reverts the next time the server's copy is read,
 * with nothing logged anywhere. It has gone stale twice — once for a view
 * mode, and once for an entire release's worth of settings, which is what
 * these cover.
 */
describe("appearance settings — every client setting round-trips", () => {
  it("keeps autoplayNext", async () => {
    await save({ autoplayNext: false });
    expect(await load()).toMatchObject({ autoplayNext: false });
  });

  it("keeps the motion level", async () => {
    await save({ motion: "reduced" });
    expect(await load()).toMatchObject({ motion: "reduced" });
  });

  it("rejects a motion level that is not one of the three", async () => {
    await save({ motion: "sideways" });
    expect(await load()).not.toHaveProperty("motion");
  });

  // Not rounded, unlike the percentages. Rounding would snap 0.625rem to 1rem
  // and a 1.15 scale to 1 — the setting would appear to work and then jump on
  // the next round-trip.
  it("keeps fractional numbers fractional", async () => {
    await save({ cardRadiusRem: 0.625, typeScale: 1.15 });
    expect(await load()).toMatchObject({
      cardRadiusRem: 0.625,
      typeScale: 1.15,
    });
  });

  it("clamps those numbers into range rather than storing nonsense", async () => {
    await save({ cardRadiusRem: 99, typeScale: -4 });
    expect(await load()).toMatchObject({ cardRadiusRem: 1.5, typeScale: 0.85 });
  });

  it("keeps every home row this build has", async () => {
    const rows = [
      "categories",
      "continue",
      "favourites",
      "performers",
      "studios",
      "recent",
      "recentlyWatched",
      "mostPlayed",
      "unwatched",
      "recentlyBrowsed",
      "recentlyInteracted",
      "randomPicks",
      "pinned",
      "collections",
      "tags",
    ].map((key) => ({ key, visible: true }));

    await save({ homeRows: rows });
    const stored = (await load()).homeRows as { key: string }[];
    expect(stored.map((row) => row.key)).toEqual(rows.map((row) => row.key));
  });

  it("keeps a hidden row hidden", async () => {
    await save({
      homeRows: [
        { key: "pinned", visible: false },
        { key: "recent", visible: true },
      ],
    });
    expect(await load()).toMatchObject({
      homeRows: [
        { key: "pinned", visible: false },
        { key: "recent", visible: true },
      ],
    });
  });

  it("keeps per-page layout overrides", async () => {
    await save({
      pageOverrides: {
        library: { viewMode: "compact", density: "dense" },
        collection: { tileInfo: "none", tileSizePercent: 90 },
      },
    });
    expect(await load()).toMatchObject({
      pageOverrides: {
        library: { viewMode: "compact", density: "dense" },
        collection: { tileInfo: "none", tileSizePercent: 90 },
      },
    });
  });

  // A page pinning its own shape goes through the override validator rather
  // than the top-level one, so passing there does not mean passing here.
  it("keeps a tile shape pinned to one page", async () => {
    await save({
      tileShape: "landscape",
      pageOverrides: { library: { tileShape: "portrait" } },
    });
    expect(await load()).toMatchObject({
      tileShape: "landscape",
      pageOverrides: { library: { tileShape: "portrait" } },
    });
  });

  it("drops an invalid tile shape inside an override", async () => {
    await save({ pageOverrides: { library: { tileShape: "diagonal", density: "dense" } } });
    const stored = (await load()) as { pageOverrides: Record<string, unknown> };
    expect(stored.pageOverrides.library).toEqual({ density: "dense" });
  });

  // The scope names are the client's and are not enumerated server-side, but
  // the values are — a hand-built request must not store a view mode that
  // does not exist.
  it("drops an invalid value inside an override", async () => {
    await save({
      pageOverrides: {
        library: { viewMode: "cinematic", density: "dense" },
      },
    });
    expect(await load()).toMatchObject({
      pageOverrides: { library: { density: "dense" } },
    });
  });

  // An override with nothing left in it is the same as no override, and
  // storing one would show the page as customised while changing nothing.
  it("drops an override left empty by validation", async () => {
    await save({ pageOverrides: { library: { viewMode: "nonsense" } } });
    expect((await load()).pageOverrides).toEqual({});
  });

  it("lets a page's overrides be cleared", async () => {
    await save({ pageOverrides: { library: { viewMode: "compact" } } });
    await save({ pageOverrides: {} });
    expect((await load()).pageOverrides).toEqual({});
  });
});
