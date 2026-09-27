import type React from "react";

export type PerformerSummary = {
  id: number;
  name: string;
  hasImage: boolean;
  hasBanner: boolean;
  /** Pins them to the top of the performers page. */
  isFavorite: boolean;
  videoCount: number;
  representativeItemId: number | null;
  /** Portrait framing. Defaults are 50 / 0 / 100 — centred, top-aligned. */
  imagePositionX: number;
  imagePositionY: number;
  imageScale: number;
  /** The round crops' own framing; null means "same as the tiles". */
  avatarPositionX?: number | null;
  avatarPositionY?: number | null;
  avatarScale?: number | null;
};

/** A group in the profile's breakdown. `null` is the "unset" bucket. */
export type StudioGroup = { name: string | null; count: number };
export type YearGroup = { year: number | null; count: number };

/**
 * Spelled out rather than extending PerformerSummary: the co-performer query
 * returns what a portrait needs and how many videos they *share*, not their
 * own total video count. Inheriting the summary would claim a field the
 * endpoint never sends.
 */
export type CoPerformer = {
  id: number;
  name: string;
  isFavorite: boolean;
  hasImage: boolean;
  hasBanner: boolean;
  representativeItemId: number | null;
  imagePositionX: number;
  imagePositionY: number;
  imageScale: number;
  /** How many videos they share with the performer whose page this is. */
  together: number;
  /** Their own catalogue size, for the tile's "N videos" line. */
  videoCount: number;
};

export type PerformerDetail = PerformerSummary & {
  /** Free text, on the profile only — the list endpoint does not carry it. */
  bio: string | null;
  studios: StudioGroup[];
  years: YearGroup[];
  watch: { watched: number; inProgress: number; unwatched: number };
  coPerformers: CoPerformer[];
  totalDurationSeconds: number;
  /** Which horizontal band of the banner is visible, for CSS object-position. */
  bannerPositionY: number;
  /** A different video's frame from the portrait where one exists, so the
   *  blurred backdrop isn't the same picture twice. */
  bannerItemId: number | null;
};

export type PerformerImageKind = "avatar" | "banner";

/**
 * URL for an uploaded performer image.
 *
 * `hasImage`/`hasBanner` is folded into the URL rather than checked at the
 * call site so a performer with nothing uploaded yields null, and callers
 * render their video-frame fallback instead of requesting a known 404.
 */
import { IMAGE_EPOCH } from "./mediaItemApi";

export function performerImageUrl(
  performer: { id: number; hasImage: boolean; hasBanner: boolean },
  kind: PerformerImageKind
): string | null {
  const present = kind === "banner" ? performer.hasBanner : performer.hasImage;
  // The filename already carries a random suffix, so a replaced image is a new
  // URL — but the filename isn't exposed here, so the epoch is what retires a
  // cached failure for this one.
  return present
    ? `/api/performers/${performer.id}/image?kind=${kind}&e=${IMAGE_EPOCH}`
    : null;
}

/**
 * The best available *banner* for a performer, in preference order: an
 * uploaded banner, then the frame chosen as one, then any frame from their
 * videos.
 *
 * The mirror of `performerPortraitUrl`, and here for the same reason: the
 * profile page worked its banner out inline, so anywhere else wanting the
 * same picture had to reproduce the preference order and hope it matched.
 */
export function performerBannerUrl(performer: {
  id: number;
  hasBanner: boolean;
  bannerItemId?: number | null;
  representativeItemId: number | null;
}): string | null {
  if (performer.hasBanner) {
    return `/api/performers/${performer.id}/image?kind=banner&e=${IMAGE_EPOCH}`;
  }
  const frame = performer.bannerItemId ?? performer.representativeItemId;
  return frame != null ? `/api/media-items/${frame}/thumbnail` : null;
}

/**
 * The best available portrait for a performer, in preference order:
 * an uploaded photo, then an uploaded banner, then a frame from one of their
 * videos. Falling back to the banner means a picture you uploaded always
 * shows up somewhere, even if you only filled one of the two slots.
 *
 * Single source of truth so the homepage row, the modal and the profile page
 * can't disagree about which image to show.
 */
export function performerPortraitUrl(performer: {
  id: number;
  hasImage: boolean;
  hasBanner: boolean;
  representativeItemId: number | null;
}): string | null {
  if (performer.hasImage) return `/api/performers/${performer.id}/image?kind=avatar`;
  if (performer.hasBanner) return `/api/performers/${performer.id}/image?kind=banner`;
  if (performer.representativeItemId != null) {
    return `/api/media-items/${performer.representativeItemId}/thumbnail`;
  }
  return null;
}

/**
 * A circle in the network graph: a performer, or — with studios drawn as
 * circles — a studio. Studios travel in the same shape so search, focus,
 * hiding and selection treat both alike; their ids are negated so they can
 * never collide with a performer's.
 */
export type NetworkNode = PerformerSummary & {
  /** The studio they appear with most, which the graph colours them by. */
  topStudio: string | null;
  /** How many studios they have videos from. */
  studioCount?: number;
  /** Roughly how long you've spent watching them. */
  watchedSeconds?: number;
  /** Their videos' average rating, where any are rated. */
  averageRating?: number | null;
  kind?: "studio";
  /** The studio's real id, for its page. Set on studio circles only. */
  studioId?: number;
};

export type NetworkStudio = { id: number; name: string; videoCount: number };

/** How many of a performer's videos are from a studio. */
export type NetworkMembership = { performerId: number; studioId: number; videos: number };

/** What links two performers in the network graph. */
export type NetworkMode = "videos" | "studios";

/**
 * One connected pair; each pair appears once. `together` counts whatever the
 * mode connects by — videos they share, or studios in common.
 */
export type NetworkEdge = {
  source: number;
  target: number;
  together: number;
  /** Studios in common, rarest first. Absent for shared videos. */
  shared?: string[];
};

/**
 * Everything that makes a network view what it is, kept in the URL so the
 * back button and a bookmark return to the same picture. Lists are kept as
 * comma-separated strings so an unchanged view is an unchanged value.
 */
export type NetworkView = {
  /** Studios when absent — the default view links performers by studio. */
  by?: "videos";
  /** A performer (or negated studio) id to show only the neighbourhood of. */
  focus?: number;
  /** How far out from `focus`; one step when absent. */
  depth?: 2;
  /** Ids taken out of the graph, comma-separated. */
  hidden?: string;
  /** Draw studios themselves in studio mode. */
  studios?: 1;
  /** Two performer ids to trace the shortest connection between, "a,b". */
  path?: string;
};

export type PerformerNetwork = {
  by: NetworkMode;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Studio mode only: the studios, and who has worked for each. */
  studios?: NetworkStudio[];
  memberships?: NetworkMembership[];
};

/** Studio circles use negated ids, so they sit beside performers in one map. */
export const studioNodeId = (studioId: number) => -studioId;

/**
 * Turns studio mode's studios into circles and its memberships into lines,
 * so the graph can draw who works for whom instead of who has a studio in
 * common with whom.
 */
export function withStudioCircles(network: PerformerNetwork): PerformerNetwork {
  const studios = network.studios ?? [];
  return {
    ...network,
    nodes: [
      ...network.nodes,
      ...studios.map(
        (studio): NetworkNode => ({
          id: studioNodeId(studio.id),
          studioId: studio.id,
          kind: "studio",
          name: studio.name,
          // Coloured as itself, so a studio matches the rings of its regulars.
          topStudio: studio.name,
          videoCount: studio.videoCount,
          hasImage: false,
          hasBanner: false,
          isFavorite: false,
          representativeItemId: null,
          imagePositionX: 50,
          imagePositionY: 0,
          imageScale: 100,
        }),
      ),
    ],
    edges: (network.memberships ?? []).map((m) => ({
      source: m.performerId,
      target: studioNodeId(m.studioId),
      together: m.videos,
    })),
  };
}

export async function fetchPerformerNetwork(by: NetworkMode): Promise<PerformerNetwork> {
  const res = await fetch(`/api/performers/network?by=${by}`);
  if (!res.ok) throw new Error(`Failed to load the performer network: ${res.status}`);
  return res.json();
}

const NETWORK_UNITS: Record<NetworkMode, [string, string]> = {
  videos: ["video", "videos"],
  studios: ["studio", "studios"],
};

export function unit(mode: NetworkMode, n: number): string {
  return `${n} ${NETWORK_UNITS[mode][n === 1 ? 0 : 1]}`;
}

/** "3 videos together", "2 studios in common". */
export function togetherLabel(mode: NetworkMode, n: number): string {
  return mode === "videos" ? `${unit(mode, n)} together` : `${unit(mode, n)} in common`;
}

export type SharedVideo = { id: number; title: string; thumbnailFile: string | null };

/**
 * The first page of videos matching browse filters — a pair's shared videos,
 * or a performer's for one studio — for queueing them all at once.
 */
export async function fetchVideosWhere(
  filters: Record<string, string>,
): Promise<(SharedVideo & { durationSeconds?: number | null })[]> {
  const res = await fetch(`/api/media-items?${new URLSearchParams(filters)}`);
  if (!res.ok) throw new Error(`Failed to load videos: ${res.status}`);
  const body = await res.json();
  return body.items;
}

/** A performer's most recent videos, for the graph's previews. */
export async function fetchLatestVideos(name: string): Promise<SharedVideo[]> {
  const params = new URLSearchParams({ performer: name, sort: "newest" });
  const res = await fetch(`/api/media-items?${params}`);
  if (!res.ok) throw new Error(`Failed to load videos: ${res.status}`);
  const body = await res.json();
  return body.items;
}

/**
 * The first page of videos two performers are both credited on, through the
 * browse endpoint's performers filter, which requires every name it's given.
 */
export async function fetchSharedVideos(
  a: string,
  b: string,
): Promise<{ items: SharedVideo[]; total: number | null; hasMore: boolean }> {
  const params = new URLSearchParams({ performers: `${a},${b}` });
  const res = await fetch(`/api/media-items?${params}`);
  if (!res.ok) throw new Error(`Failed to load shared videos: ${res.status}`);
  const body = await res.json();
  return { items: body.items, total: body.total ?? null, hasMore: body.hasMore };
}

export async function fetchPerformer(id: number): Promise<PerformerDetail> {
  const res = await fetch(`/api/performers/${id}`);
  if (!res.ok) throw new Error(`Failed to load performer: ${res.status}`);
  return res.json();
}

/**
 * Inline style applying a performer's portrait framing.
 *
 * Mirrors framingStyle for media thumbnails — the portrait appears on the
 * performers page, the home-page row and the detail modal's avatar, and all
 * three should crop it the same way.
 */
export function portraitStyle(performer: {
  imagePositionX?: number;
  imagePositionY?: number;
  imageScale?: number;
}): React.CSSProperties {
  const x = performer.imagePositionX ?? 50;
  // Top-aligned by default: faces are usually up there, which is why the
  // cards used to hardcode `object-top`.
  const y = performer.imagePositionY ?? 0;
  const scale = performer.imageScale ?? 100;
  return {
    objectPosition: `${x}% ${y}%`,
    transform: scale === 100 ? undefined : `scale(${scale / 100})`,
    transformOrigin: `${x}% ${y}%`,
  };
}

/**
 * The framing a round crop should use: the circle's own where one has been
 * set, otherwise the tile framing, so an unadjusted circle looks as it
 * always did.
 */
export function circleFraming(performer: {
  imagePositionX?: number;
  imagePositionY?: number;
  imageScale?: number;
  avatarPositionX?: number | null;
  avatarPositionY?: number | null;
  avatarScale?: number | null;
}): { imagePositionX?: number; imagePositionY?: number; imageScale?: number } {
  const own = performer.avatarPositionX != null && performer.avatarPositionY != null;
  return own
    ? {
        imagePositionX: performer.avatarPositionX!,
        imagePositionY: performer.avatarPositionY!,
        imageScale: performer.avatarScale ?? 100,
      }
    : performer;
}

/** `portraitStyle` for round crops — see `circleFraming`. */
export function circleStyle(performer: Parameters<typeof circleFraming>[0]): React.CSSProperties {
  return portraitStyle(circleFraming(performer));
}

export async function saveCircleFraming(
  id: number,
  framing: { avatarPositionX: number; avatarPositionY: number; avatarScale: number } | null,
): Promise<void> {
  const res = await fetch(`/api/performers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      framing ?? { avatarPositionX: null, avatarPositionY: null, avatarScale: null },
    ),
  });
  if (!res.ok) throw new Error(`Failed to save circle framing: ${res.status}`);
}

export async function savePerformerBio(id: number, bio: string): Promise<void> {
  const res = await fetch(`/api/performers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // Sent alone: the endpoint accepts any single field without the name.
    body: JSON.stringify({ bio }),
  });
  if (!res.ok) throw new Error(`Failed to save bio: ${res.status}`);
}

export async function savePortraitFraming(
  id: number,
  framing: { imagePositionX: number; imagePositionY: number; imageScale: number }
): Promise<void> {
  const res = await fetch(`/api/performers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(framing),
  });
  if (!res.ok) throw new Error(`Failed to save portrait framing: ${res.status}`);
}

export async function setPerformerFavorite(id: number, isFavorite: boolean): Promise<void> {
  const res = await fetch(`/api/performers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isFavorite }),
  });
  if (!res.ok) throw new Error(`Failed to save favourite: ${res.status}`);
}

export async function saveBannerPosition(id: number, bannerPositionY: number): Promise<void> {
  const res = await fetch(`/api/performers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bannerPositionY }),
  });
  if (!res.ok) throw new Error(`Failed to save banner position: ${res.status}`);
}

export async function uploadPerformerImage(
  id: number,
  kind: PerformerImageKind,
  file: File
): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`/api/performers/${id}/image?kind=${kind}`, { method: "POST", body });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Upload failed: ${res.status}`);
  }
}

export async function deletePerformerImage(id: number, kind: PerformerImageKind): Promise<void> {
  const res = await fetch(`/api/performers/${id}/image?kind=${kind}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to remove image: ${res.status}`);
}
