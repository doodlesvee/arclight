import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Archive, ChevronRight, Heart, LayoutGrid, Share2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import {
  PerformerCard,
  type PerformerSummary,
} from "@/components/PerformerCard";
import { AlphabetIndex } from "@/components/AlphabetIndex";
import { PerformerNetwork } from "@/components/PerformerNetwork";
import { pinsChangedEvent, readPins } from "@/lib/pinned";
import { tileWidthPx, useAppearance, PageScope } from "@/lib/appearance";
import { cardLayout } from "@/lib/layout";
import { cn } from "@/lib/utils";

const routeApi = getRouteApi("/performers");

/** Grid of cards, or the graph of who appears with whom. */
function ViewSwitch({ network }: { network: boolean }) {
  const navigate = useNavigate();
  const options = [
    { key: "grid", label: "Grid", icon: LayoutGrid, active: !network },
    { key: "network", label: "Network", icon: Share2, active: network },
  ] as const;
  return (
    <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label="View">
      {options.map(({ key, label, icon: Icon, active }) => (
        <button
          key={key}
          type="button"
          title={label}
          aria-pressed={active}
          onClick={() =>
            void navigate({
              to: "/performers",
              search: key === "network" ? { view: "network" } : {},
            })
          }
          className={cn(
            "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
            active
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {/* Icons alone on a phone, where the header also has to fit the
              page title. */}
          <span className="sr-only sm:not-sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One section of the page.
 *
 * Extracted because the page has three of these — favourites, with-videos,
 * and empty — and they were three copies of the same markup; changing the
 * spacing in two of them and forgetting the third is exactly the kind of
 * thing that survives review.
 */
function PerformerList({
  performers,
  onOpen,
  layout,
}: {
  performers: PerformerSummary[];
  onOpen: (performer: PerformerSummary) => void;
  layout: ReturnType<typeof cardLayout>;
}) {
  return (
    <div
      className="stagger flex flex-wrap"
      style={{ columnGap: layout.columnGapPx, rowGap: layout.rowGapPx }}
    >
      {performers.map((performer) => (
        <PerformerCard
          key={performer.id}
          performer={performer}
          onClick={() => onOpen(performer)}
        />
      ))}
    </div>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export function PerformersPage() {
  const navigate = useNavigate();
  const search = routeApi.useSearch();
  const network = search.view === "network";
  const { tileSizePercent, tileInfo, viewMode, tileShape, density } = useAppearance();
  // The same axes the media grid uses, so a layout choice made once applies
  // here too rather than only to videos. The shape is passed for the gaps and
  // column width to stay in step; the performer cards themselves keep their
  // own 2:3 frame, which is not a preference.
  const layout = cardLayout(
    tileWidthPx(tileSizePercent),
    viewMode,
    density,
    tileInfo,
    tileShape,
  );

  const openPerformer = (performer: PerformerSummary) =>
    void navigate({
      to: "/performer/$performerId",
      params: { performerId: String(performer.id) },
    });
  const [letter, setLetter] = useState<string | null>(null);
  // Folded away by default: archiving is for getting someone out of the
  // way, so the section shouldn't greet you on every visit.
  const [showArchived, setShowArchived] = useState(false);
  const [, refreshPins] = useState(0);

  useEffect(() => {
    const refresh = () => refreshPins((value) => value + 1);
    window.addEventListener(pinsChangedEvent(), refresh);
    return () => window.removeEventListener(pinsChangedEvent(), refresh);
  }, []);

  // Its own key, not ["performers"]: that one is the active-only list the
  // home row and the editor share, and caching this longer list under it
  // would leak archived performers back into them. Still under the prefix,
  // so every invalidation of ["performers"] refreshes this too.
  const { data } = useQuery({
    queryKey: ["performers", "with-archived"],
    queryFn: () =>
      fetchJson<{ performers: PerformerSummary[] }>(
        "/api/performers?archived=include",
      ),
  });

  // Favourites first, then alphabetical — so a performer stays put as their
  // video count changes; ordering by count meant every scan could reshuffle
  // the whole page. localeCompare so accented names sort next to their base
  // letter. The server orders the same way, but this page re-sorts anyway, so
  // the pin has to be repeated here or it would be thrown away.
  const pinnedIds = new Set(
    readPins()
      .filter((pin) => pin.type === "performer")
      .map((pin) => pin.performerId),
  );
  const all = [...(data?.performers ?? [])].sort(
    (a, b) =>
      Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id)) ||
      Number(b.isFavorite) - Number(a.isFavorite) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const performers = all.filter((p) => !p.archivedAt);
  const archived = all.filter((p) => p.archivedAt);

  // Unlike the homepage row, zero-video performers are kept: this is the page
  // where you'd go to find one you created by hand, or one whose folder is
  // currently unscanned.
  // Favourited performers get their own section at the top, so they're
  // excluded from the two below rather than appearing twice.
  const matchesLetter = (performer: PerformerSummary) => {
    if (!letter) return true;
    const initial = performer.name.trim().charAt(0).toUpperCase();
    return letter === "#" ? !/^[A-Z]$/.test(initial) : initial === letter;
  };
  const visiblePerformers = performers.filter(matchesLetter);
  const visibleArchived = archived.filter(matchesLetter);
  const visibleFavorites = visiblePerformers.filter((p) => p.isFavorite);
  const visibleWithVideos = visiblePerformers.filter(
    (p) => !p.isFavorite && p.videoCount > 0,
  );
  const visibleEmpty = visiblePerformers.filter(
    (p) => !p.isFavorite && p.videoCount === 0,
  );

  return (
    <PageScope name="performers">
      <AppShell
        title="Performers"
        subtitle={
          performers.length > 0
            ? `${performers.length} ${performers.length === 1 ? "performer" : "performers"}`
            : undefined
        }
        actions={<ViewSwitch network={network} />}
      >
        {network ? (
          <div className="px-4 py-6 md:px-6 md:py-8">
            <PerformerNetwork
              view={search}
              // Replacing rather than pushing: every hide, filter or drag of
              // the year slider would otherwise be its own back-button stop.
              onViewChange={(patch) =>
                void navigate({
                  to: "/performers",
                  search: (prev) => ({ ...prev, ...patch, view: "network" }),
                  replace: true,
                })
              }
            />
          </div>
        ) : (
        <div className="space-y-8 px-4 py-6 md:px-6 md:py-8">
          <AlphabetIndex
            value={letter}
            onChange={setLetter}
            available={performers.map((performer) => performer.name)}
          />
          {visiblePerformers.length === 0 && archived.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No performers yet. They're created automatically from your folder
              names when you scan.
            </p>
          )}

          {visibleFavorites.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                <Heart className="size-3.5 fill-red-500 text-red-500" />
                Favourites
              </h2>
              <PerformerList
                performers={visibleFavorites}
                onOpen={openPerformer}
                layout={layout}
              />
            </section>
          )}

          {visibleWithVideos.length > 0 && (
            <PerformerList
              performers={visibleWithVideos}
              onOpen={openPerformer}
              layout={layout}
            />
          )}

          {visibleEmpty.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">
                No videos right now
              </h2>
              <p className="max-w-prose text-xs text-muted-foreground/70">
                Either added by hand, or their folder isn't currently being
                scanned. Their details are kept either way.
              </p>
              <PerformerList
                performers={visibleEmpty}
                onOpen={openPerformer}
                layout={layout}
              />
            </section>
          )}

          {visibleArchived.length > 0 && (
            <section className="space-y-3">
              <button
                type="button"
                onClick={() => setShowArchived((open) => !open)}
                aria-expanded={showArchived}
                className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform",
                    showArchived && "rotate-90",
                  )}
                />
                <Archive className="size-3.5" />
                Archived
                <span className="font-normal tabular-nums">
                  {visibleArchived.length}
                </span>
              </button>
              {showArchived && (
                <>
                  <p className="max-w-prose text-xs text-muted-foreground/70">
                    Kept out of the home row, search and the network. Their
                    videos are untouched. Open one to restore them.
                  </p>
                  <div className="opacity-60 transition-opacity hover:opacity-100">
                    <PerformerList
                      performers={visibleArchived}
                      onOpen={openPerformer}
                      layout={layout}
                    />
                  </div>
                </>
              )}
            </section>
          )}
        </div>
        )}
      </AppShell>
    </PageScope>
  );
}
