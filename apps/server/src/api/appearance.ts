import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

const APPEARANCE_KEY = "appearance";

/**
 * How the app looks, stored per install rather than per browser.
 *
 * These began in localStorage, which meant a different tile size in Safari
 * than in Chrome and nothing at all on a second machine. The server is the
 * single copy; the browser still keeps one so a reload paints immediately
 * instead of flashing the defaults.
 *
 * Validated here as well as in the client, because "the client already
 * checked" is never a reason for a server to store whatever it's handed.
 * Anything unrecognised is dropped rather than rejected — an older browser
 * sending a key this build no longer has shouldn't fail the whole save.
 */

const PERCENT_KEYS = {
  tileSizePercent: [40, 100],
  // The homepage hero and the performer/studio headers size independently.
  heroHeight: [30, 100],
  bannerHeight: [30, 100],
  discreetBlurPercent: [10, 100],
} as const;

const BOOLEAN_KEYS = [
  "hoverZoom",
  "hoverPreview",
  "modalPreview",
  "discreet",
  "discreetText",
  "autoplayNext",
  "ambientLight",
  "screensaver",
  "screensaverClock",
] as const;

/**
 * Settings that are a plain number rather than a percentage.
 *
 * Kept apart from PERCENT_KEYS because those round to a whole number, which
 * would snap a 0.625rem radius to 1rem and a 1.15 text scale to 1 — the
 * setting would appear to work and then jump on the next round-trip.
 */
const NUMBER_KEYS = {
  cardRadiusRem: [0, 1.5],
  typeScale: [0.85, 1.3],
  // Minutes idle before it starts, and seconds each poster stays up.
  screensaverMinutes: [1, 60],
  screensaverSeconds: [3, 60],
  // The video pinned as the Hall of fame's main event; 0 means "pick for me".
  hallOfFamePin: [0, 2147483647],
} as const;

/**
 * Settings whose value must be one of a fixed set.
 *
 * A table rather than a check per key: adding a view mode and forgetting the
 * server means it saves locally and reverts on the next round-trip, with
 * nothing logged. That has already happened once here.
 */
const ENUM_KEYS: Record<string, string[]> = {
  tileInfo: ["full", "title", "none", "below"],
  viewMode: ["grid", "compact", "large"],
  tileShape: ["landscape", "portrait"],
  density: ["spacious", "comfortable", "compact", "dense"],
  motion: ["full", "reduced", "none"],
  screensaverSource: ["all", "favourites", "unwatched", "topRated"],
};

/** The layout settings a single page may pin for itself. */
const PAGE_OVERRIDE_ENUMS = ["viewMode", "tileShape", "density", "tileInfo"] as const;

/**
 * Must track the client's HOME_ROWS. There is no shared package between the
 * two, so this is a second copy of that list, and a row missing from here is
 * a row the server silently strips on save — which is how every section
 * added in one release failed to survive a round-trip.
 *
 * The client re-reconciles whatever it receives against its own list, so a
 * stale copy here costs the *order* rather than the row itself. That is the
 * safety net, not the fix.
 */
const HOME_ROW_KEYS = [
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
];

function clean(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const body = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, [min, max]] of Object.entries(PERCENT_KEYS)) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof body[key] === "boolean") out[key] = body[key];
  }

  for (const [key, [min, max]] of Object.entries(NUMBER_KEYS)) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(max, Math.max(min, value));
    }
  }

  for (const [key, allowed] of Object.entries(ENUM_KEYS)) {
    const value = body[key];
    if (typeof value === "string" && allowed.includes(value)) out[key] = value;
  }

  if (Array.isArray(body.homeRows)) {
    const seen = new Set<string>();
    const rows: { key: string; visible: boolean }[] = [];
    for (const entry of body.homeRows) {
      const key = (entry as { key?: unknown })?.key;
      if (typeof key !== "string" || !HOME_ROW_KEYS.includes(key) || seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, visible: (entry as { visible?: unknown }).visible !== false });
    }
    if (rows.length > 0) out.homeRows = rows;
  }

  // Per-page layout overrides: a map of scope name to a partial layout.
  //
  // The scope names are the client's and deliberately not enumerated here —
  // they come from what a page calls itself, and a server-side list would be
  // a third copy to keep in step. The *values* are validated, which is what
  // stops a hand-built request storing a view mode that does not exist.
  if (body.pageOverrides && typeof body.pageOverrides === "object") {
    const overrides: Record<string, Record<string, unknown>> = {};

    for (const [scope, raw] of Object.entries(
      body.pageOverrides as Record<string, unknown>
    )) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const next: Record<string, unknown> = {};

      for (const key of PAGE_OVERRIDE_ENUMS) {
        const value = entry[key];
        if (typeof value === "string" && ENUM_KEYS[key].includes(value)) {
          next[key] = value;
        }
      }
      const size = entry.tileSizePercent;
      if (typeof size === "number" && Number.isFinite(size)) {
        const [min, max] = PERCENT_KEYS.tileSizePercent;
        next.tileSizePercent = Math.min(max, Math.max(min, Math.round(size)));
      }

      // An override with nothing left in it is the same as no override, and
      // storing one would show the page as customised while changing nothing.
      if (Object.keys(next).length > 0) overrides[scope] = next;
    }

    out.pageOverrides = overrides;
  }

  return out;
}

export async function appearanceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/appearance", async () => {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, APPEARANCE_KEY));
    // An empty object means "never set" — the client fills in its own
    // defaults rather than the server having a second opinion about them.
    return { appearance: clean(row?.value) };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/appearance", async (request) => {
    // Merged, not replaced: a client that predates a setting would otherwise
    // wipe it by saving without it.
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, APPEARANCE_KEY));
    const value = { ...clean(row?.value), ...clean(request.body) };

    await db
      .insert(appSettings)
      .values({ key: APPEARANCE_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    return { appearance: value };
  });
}
