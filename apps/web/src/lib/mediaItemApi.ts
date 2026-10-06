import type React from "react";
import { focalStyle } from "./reposition";
export type Tag = { id: number; name: string; color: string | null };
export type Performer = { id: number; name: string };
export type Folder = { id: number; title: string; parentId: number | null };

export type VideoMetadata = {
  width?: number;
  height?: number;
  codec?: string;
  containerFormat?: string;
};

export type PhotoMetadata = {
  cameraModel?: string | null;
  gps?: { latitude: number; longitude: number } | null;
};

export type MediaItemDetail = {
  id: number;
  itemType: "video" | "photo" | "folder";
  title: string;
  description: string | null;
  performers: Performer[];
  isFavorite: boolean;
  kind: "video" | "movie" | "series";
  thumbnailFile: string | null;
  /** How the thumbnail is framed wherever it's shown. Display only. */
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  thumbnailScale: number;
  /**
   * This item's own tile shape, or null to follow the Appearance setting.
   *
   * Null rather than a copy of the current global value, so changing the
   * Appearance setting later still moves every tile that was never set by
   * hand.
   */
  tileShape: "landscape" | "portrait" | null;
  /** 1–5 stars, or null when not rated. */
  rating: number | null;
  studio: string | null;
  studioSource: "scanner" | "user";
  performersSource: "scanner" | "user";
  parentId: number | null;
  durationSeconds: number | null;
  playbackWarning: string | null;
  tags: Tag[];
  takenAt: string | null;
  /** Release date parsed from the filename, ISO "YYYY-MM-DD", or null. */
  releaseDate: string | null;
  createdAt: string;
  extraMetadata: VideoMetadata | PhotoMetadata | null;
  lastPositionSeconds: number;
  /** Whether it's been played to the end (or marked watched by hand). */
  watched: boolean;
  watchedAt: string | null;
  playCount: number;
  seriesId: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  /** Detail responses only — the source file's own dates and size. */
  fileModifiedAt?: string | null;
  fileSizeBytes?: number | null;
};

/**
 * Thumbnail URL for an item, carrying a version token.
 *
 * The endpoint is served `immutable` for a year, so without a token that
 * changes, replacing a thumbnail would leave every browser showing the old
 * one indefinitely. The uploaded filename carries a random suffix, which
 * makes the new URL distinct from the old.
 */
/**
 * Bump to retire every cached image in every browser at once.
 *
 * Image routes send `Cache-Control: immutable, max-age=31536000`, which is
 * right for the picture and was briefly catastrophic for the failures: the
 * header is set on the reply *before* the file is streamed, so an error sent
 * afterwards inherited it. Browsers were told to remember those failures for
 * a year, and `immutable` means they won't even revalidate. Nothing
 * server-side can evict that — only a different URL can, which is what this
 * is for.
 */
export const IMAGE_EPOCH = "2";

/**
 * The `v` token changes the URL when the image behind it changes, so a
 * replaced thumbnail defeats the browser cache with no invalidation logic.
 */
export function thumbnailUrl(item: { id: number; thumbnailFile?: string | null }): string {
  const version = item.thumbnailFile ?? "auto";
  return `/api/media-items/${item.id}/thumbnail?v=${version}&e=${IMAGE_EPOCH}`;
}

export async function uploadThumbnail(id: number, file: File): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`/api/media-items/${id}/thumbnail`, { method: "POST", body });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Upload failed: ${res.status}`);
  }
}

export async function resetThumbnail(id: number): Promise<void> {
  const res = await fetch(`/api/media-items/${id}/thumbnail`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to reset thumbnail: ${res.status}`);
}

/**
 * Inline style applying an item's chosen thumbnail framing.
 *
 * Every surface that shows a thumbnail uses this — tile, hero, hover card,
 * modal backdrop — so one framing decision holds everywhere the image
 * appears, rather than each place cropping it its own way.
 *
 * That works because the stored pair is a *focal point*, not an offset tuned
 * for one frame: `object-position: p%` puts the source point at fraction p at
 * fraction p of the frame whatever its shape, so the subject cannot be cropped
 * out at any ratio. `focalStyle` carries the proof.
 *
 * Returns undefined when the framing is untouched, so React doesn't attach a
 * style attribute to hundreds of grid images that don't need one.
 */
export function framingStyle(item: {
  thumbnailPositionX?: number;
  thumbnailPositionY?: number;
  thumbnailScale?: number;
}): React.CSSProperties | undefined {
  const x = item.thumbnailPositionX ?? 50;
  const y = item.thumbnailPositionY ?? 50;
  const scale = item.thumbnailScale ?? 100;
  if (x === 50 && y === 50 && scale === 100) return undefined;

  return focalStyle({ x, y }, scale);
}

export async function fetchItem(id: number): Promise<MediaItemDetail> {
  const res = await fetch(`/api/media-items/${id}`);
  if (!res.ok) throw new Error(`Failed to load item: ${res.status}`);
  return res.json();
}

export async function updateItem(
  id: number,
  patch: {
    title?: string;
    description?: string | null;
    isFavorite?: boolean;
    kind?: string;
    studio?: string | null;
    thumbnailPositionX?: number;
    thumbnailPositionY?: number;
    thumbnailScale?: number;
    tileShape?: "landscape" | "portrait" | null;
    rating?: number | null;
    seriesId?: number | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    episodeTitle?: string | null;
  }
) {
  const res = await fetch(`/api/media-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to update item: ${res.status}`);
}

export async function fetchFolders(): Promise<{ folders: Folder[] }> {
  const res = await fetch("/api/folders");
  if (!res.ok) throw new Error(`Failed to load folders: ${res.status}`);
  return res.json();
}

export async function moveToFolder(id: number, parentId: number | null) {
  const res = await fetch(`/api/media-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) throw new Error(`Failed to move item: ${res.status}`);
}

export async function savePerformers(
  id: number,
  performerNames: string[]
): Promise<{ performers: Performer[] }> {
  const res = await fetch(`/api/media-items/${id}/performers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ performerNames }),
  });
  if (!res.ok) throw new Error(`Failed to save performers: ${res.status}`);
  return res.json();
}

export async function saveTags(id: number, tagNames: string[]): Promise<{ tags: Tag[] }> {
  const res = await fetch(`/api/media-items/${id}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagNames }),
  });
  if (!res.ok) throw new Error(`Failed to save tags: ${res.status}`);
  return res.json();
}

// Fire-and-forget by design at call sites — losing an occasional progress
// tick isn't worth surfacing an error for, unlike the edit actions above.
export async function savePlaybackPosition(id: number, positionSeconds: number): Promise<void> {
  await fetch(`/api/media-items/${id}/playback`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionSeconds }),
  });
}

/**
 * Marks an item watched or unwatched.
 *
 * Deliberately not folded into `savePlaybackPosition`: that fires every few
 * seconds during playback, and incrementing a play count there would count a
 * single viewing dozens of times.
 */
export async function setWatched(id: number, watched: boolean): Promise<void> {
  const res = await fetch(`/api/media-items/${id}/watched`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ watched }),
  });
  if (!res.ok) throw new Error(`Failed to update watched state: ${res.status}`);
}

export async function hideItem(id: number, hidden: boolean): Promise<void> {
  const res = await fetch(`/api/media-items/${id}/hidden`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden }),
  });
  if (!res.ok) throw new Error(`Failed to update hidden state: ${res.status}`);
}

export async function reorderCollectionItems(
  collectionId: number,
  orderedIds: number[],
): Promise<void> {
  const res = await fetch(`/api/collections/${collectionId}/items/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  if (!res.ok) throw new Error(`Failed to reorder: ${res.status}`);
}
