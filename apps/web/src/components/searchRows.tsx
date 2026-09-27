import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import { circleStyle, performerPortraitUrl } from "@/lib/performerApi";

/**
 * The shared half of search: what a suggestion is, how it's fetched, and how
 * each kind of row is drawn.
 *
 * Two surfaces show these — the header field and the spotlight palette — and
 * they have to agree on what a match looks like, so the pieces live here
 * rather than being copied into the second one.
 */

export type PerformerHit = {
  id: number;
  name: string;
  hasImage: boolean;
  hasBanner: boolean;
  representativeItemId: number | null;
  imagePositionX: number;
  avatarPositionX?: number | null;
  avatarPositionY?: number | null;
  avatarScale?: number | null;
  imagePositionY: number;
  imageScale: number;
  videoCount: number;
};

export type ItemHit = {
  id: number;
  title: string;
  description: string | null;
  thumbnailFile: string | null;
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  thumbnailScale: number;
  releaseDate: string | null;
  performers: { id: number; name: string }[];
};

export type Suggestions = {
  performers: PerformerHit[];
  studios: { id: number; name: string }[];
  items: ItemHit[];
};

/** A flattened row, so the keyboard can walk the groups as one list. */
export type Row =
  | { kind: "performer"; label: string; performer: PerformerHit }
  | { kind: "studio"; label: string }
  | { kind: "item"; label: string; item: ItemHit }
  | { kind: "query"; label: string };

export async function fetchSuggestions(q: string): Promise<Suggestions> {
  const res = await fetch(`/api/search/suggestions?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Suggestions failed: ${res.status}`);
  return res.json();
}

/** A circular portrait plus the name and how many videos they're in. */
export function PerformerRowContent({ performer }: { performer: PerformerHit }) {
  const portrait = performerPortraitUrl(performer);
  return (
    <>
      <span className="size-9 shrink-0 overflow-hidden rounded-full bg-secondary">
        {portrait ? (
          <img
            src={portrait}
            alt=""
            style={circleStyle(performer)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-xs font-semibold text-muted-foreground">
            {performer.name.trim()[0]?.toUpperCase() ?? "?"}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{performer.name}</span>
        <span className="block text-[11px] text-muted-foreground">
          {performer.videoCount} {performer.videoCount === 1 ? "video" : "videos"}
        </span>
      </span>
    </>
  );
}

/**
 * A tile, the cast, and the description — capped at two lines so one verbose
 * item can't push the rest of the list off the screen.
 */
export function ItemRowContent({ item }: { item: ItemHit }) {
  const cast = item.performers.map((p) => p.name).join(", ");
  const year = item.releaseDate ? item.releaseDate.slice(0, 4) : null;
  return (
    <>
      <span className="w-24 shrink-0 overflow-hidden rounded bg-secondary">
        <img
          src={thumbnailUrl(item)}
          alt=""
          loading="lazy"
          style={framingStyle(item)}
          className="aspect-video w-full object-cover"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.title}</span>
        {(cast || year) && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {[cast, year].filter(Boolean).join(" · ")}
          </span>
        )}
        {item.description && (
          <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
            {item.description}
          </span>
        )}
      </span>
    </>
  );
}


export const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 150;

export const GROUP_LABEL: Record<Row["kind"], string> = {
  performer: "Performers",
  studio: "Studios",
  item: "Videos",
  query: "",
};

/**
 * Debounced suggestions for a query, flattened into one keyboard-walkable
 * list. The plain-text row is always last, so a query matching nothing named
 * still has somewhere to go.
 */
export function useSuggestionRows(value: string): { rows: Row[]; ready: boolean } {
  // Separate from the caller's value so every keystroke doesn't fire a
  // request; the input stays instant while the query trails it.
  const [debounced, setDebounced] = useState(value.trim());

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const { data } = useQuery({
    queryKey: ["search-suggestions", debounced],
    queryFn: () => fetchSuggestions(debounced),
    enabled: debounced.length >= MIN_QUERY_LENGTH,
    // Suggestions for a given prefix don't change as you type past it, and
    // backspacing is common — keeping them briefly makes that feel instant.
    staleTime: 30_000,
  });

  const rows: Row[] = [
    ...(data?.performers ?? []).map((p) => ({
      kind: "performer" as const,
      label: p.name,
      performer: p,
    })),
    ...(data?.studios ?? []).map((s) => ({ kind: "studio" as const, label: s.name })),
    ...(data?.items ?? []).map((i) => ({ kind: "item" as const, label: i.title, item: i })),
  ];
  if (value.trim()) rows.push({ kind: "query" as const, label: value.trim() });

  return { rows, ready: value.trim().length >= MIN_QUERY_LENGTH && rows.length > 0 };
}

/** Where a chosen row takes you. */
export function rowTarget(row: Row): { performer?: string; studio?: string; q?: string } {
  if (row.kind === "performer") return { performer: row.label };
  if (row.kind === "studio") return { studio: row.label };
  // An item row searches its title rather than opening the video: the grid is
  // where you can then refine, and opening a modal straight from a search box
  // would leave you nowhere to go back to.
  return { q: row.label };
}
