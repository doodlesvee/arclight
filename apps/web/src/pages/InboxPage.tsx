import { useCallback, useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AlertCircle, Check, CheckCheck, ChevronLeft, ChevronRight, Film, Inbox, LoaderCircle, RefreshCw, SkipForward } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PerformerEditor } from "@/components/PerformerEditor";
import { TagEditor } from "@/components/TagEditor";
import { StarRating } from "@/components/StarRating";
import { thumbnailUrl, framingStyle } from "@/lib/mediaItemApi";
import { formatDuration } from "@/lib/utils";

type InboxPerformer = { id: number; name: string };
type InboxTag = { id: number; name: string };

type InboxItem = {
  id: number;
  title: string;
  thumbnailFile: string | null;
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  thumbnailScale: number;
  durationSeconds: number | null;
  releaseDate: string | null;
  itemType: string;
  studioId: number | null;
  studioName: string | null;
  rating: number | null;
  isFavorite: boolean;
  performers: InboxPerformer[];
  tags: InboxTag[];
};

type InboxResponse = {
  items: InboxItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

async function triageItems(ids: number[]) {
  const res = await fetch("/api/inbox/triage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error("Failed to triage");
  return res.json();
}

async function triageAll() {
  const res = await fetch("/api/inbox/triage-all", { method: "POST" });
  if (!res.ok) throw new Error("Failed to triage all");
  return res.json();
}

function EmptyInbox() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <CheckCheck className="mb-2 size-9 text-muted-foreground" />
      <h2 className="text-xl font-semibold">All caught up</h2>
      <p className="text-sm text-muted-foreground">No items awaiting review.</p>
    </div>
  );
}

function InboxThumbnail({ item, compact = false }: { item: InboxItem; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
      {failed ? (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <Film className={compact ? "size-5" : "size-10"} aria-label="No preview available" />
        </div>
      ) : (
        <img src={thumbnailUrl(item)} alt={compact ? "" : item.title}
          className="size-full object-cover" style={framingStyle(item)}
          loading={compact ? "lazy" : "eager"} onError={() => setFailed(true)} />
      )}
      {!compact && item.durationSeconds != null && (
        <span className="absolute bottom-3 right-3 rounded bg-black/80 px-2 py-1 text-xs tabular-nums text-white">
          {formatDuration(item.durationSeconds)}
        </span>
      )}
    </div>
  );
}

export function InboxPage() {
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["inbox", page],
    queryFn: async () => {
      const res = await fetch(`/api/inbox?page=${page}`);
      if (!res.ok) throw new Error("Failed to load inbox");
      return res.json() as Promise<InboxResponse>;
    },
  });

  const { data: countData } = useQuery({
    queryKey: ["inbox-count"],
    queryFn: async () => {
      const res = await fetch("/api/inbox/count");
      if (!res.ok) throw new Error("Failed to load inbox count");
      return res.json() as Promise<{ count: number }>;
    },
  });

  const items = data?.items ?? [];
  const item = items[index] ?? null;
  const total = items.length;

  const triageMutation = useMutation({
    mutationFn: (ids: number[]) => triageItems(ids),
    onSuccess: (_result, ids) => {
      queryClient.setQueryData<InboxResponse>(["inbox", page], (current) => current
        ? { ...current, items: current.items.filter((entry) => !ids.includes(entry.id)) }
        : current);
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
      queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
    },
  });

  const triageAllMutation = useMutation({
    mutationFn: triageAll,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
      queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
      setIndex(0);
      setPage(1);
    },
  });

  const goNext = useCallback(() => {
    if (index < total - 1) setIndex((i) => i + 1);
  }, [index, total]);

  const goPrev = useCallback(() => {
    if (index > 0) setIndex((i) => i - 1);
  }, [index]);

  const markDone = useCallback(() => {
    if (!item || triageMutation.isPending || triageAllMutation.isPending) return;
    triageMutation.mutate([item.id]);
  }, [item, triageMutation, triageAllMutation.isPending]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey ||
        (e.target instanceof Element && e.target.closest("input, textarea, select, button, a, [contenteditable], [role='dialog']"))) return;

      switch (e.key) {
        case "ArrowRight":
        case "j":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
        case "k":
          e.preventDefault();
          goPrev();
          break;
        case "Enter":
          e.preventDefault();
          markDone();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, markDone]);

  useEffect(() => {
    if (index >= total && total > 0) setIndex(total - 1);
    if (data && total === 0 && page > 1) {
      setPage((current) => current - 1);
      setIndex(0);
    }
  }, [total, index, data, page]);

  const busy = triageMutation.isPending || triageAllMutation.isPending;
  const actionError = triageMutation.error ?? triageAllMutation.error;
  const changePage = (next: number) => { setPage(next); setIndex(0); };

  return (
    <AppShell title="Inbox">
      <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
          <div className="flex items-center gap-3">
            <Inbox className="size-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Awaiting review</h2>
            {!isLoading && !isError && <span className="text-sm tabular-nums text-muted-foreground">{countData?.count ?? total}</span>}
          </div>
          {total > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Mark all ${countData?.count ?? total} inbox items as reviewed?`)) triageAllMutation.mutate();
              }}
              disabled={busy}
              className="inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <CheckCheck className="size-4" />
              Mark all done
            </button>
          )}
        </header>

        {isLoading && (
          <div role="status" aria-label="Loading inbox" className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="space-y-3">{[1, 2, 3, 4].map((entry) => <div key={entry} className="h-20 animate-pulse rounded-md bg-muted" />)}</div>
            <div className="aspect-video max-w-2xl animate-pulse rounded-md bg-muted" />
          </div>
        )}

        {isError && <div role="alert" className="flex flex-col items-center gap-4 py-20 text-center">
          <AlertCircle className="size-8 text-muted-foreground" />
          <p>Could not load the inbox.</p>
          <button type="button" onClick={() => void refetch()} className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm"><RefreshCw className="size-4" />Retry</button>
        </div>}

        {actionError && <p role="alert" className="mb-4 flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{actionError.message}. Please try again.</p>}

        {!isLoading && !isError && total === 0 && <EmptyInbox />}

        {!isLoading && item && (
          <div className="grid min-w-0 gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-8">
            <aside className="min-w-0 lg:border-r lg:border-border lg:pr-6" aria-label="Review queue">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted-foreground">Queue</h3>
                <span className="text-xs tabular-nums text-muted-foreground">{index + 1} of {total}</span>
              </div>
              <div className="flex max-h-44 gap-2 overflow-auto pb-2 lg:max-h-[65vh] lg:flex-col lg:pb-0">
                {items.map((entry, entryIndex) => (
                  <button key={entry.id} type="button" onClick={() => setIndex(entryIndex)} disabled={busy}
                    aria-current={entry.id === item.id ? "true" : undefined}
                    className={`flex w-56 shrink-0 items-center gap-3 rounded-md border p-2 text-left transition-colors disabled:opacity-50 lg:w-full ${entry.id === item.id ? "border-foreground/25 bg-accent" : "border-transparent hover:bg-muted"}`}>
                    <span className="w-20 shrink-0"><InboxThumbnail key={`${entry.id}-${entry.thumbnailFile}`} item={entry} compact /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={entry.title}>{entry.title}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">{entry.studioName ?? (entry.performers.map((performer) => performer.name).join(", ") || "No studio")}</span>
                      {entry.durationSeconds != null && <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">{formatDuration(entry.durationSeconds)}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {(page > 1 || data?.hasMore) && <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <button type="button" aria-label="Previous queue page" title="Previous queue page" disabled={page === 1 || busy} onClick={() => changePage(page - 1)} className="flex size-9 items-center justify-center rounded-md hover:bg-accent disabled:opacity-30"><ChevronLeft className="size-4" /></button>
                <span className="text-xs text-muted-foreground">Page {page}</span>
                <button type="button" aria-label="Next queue page" title="Next queue page" disabled={!data?.hasMore || busy} onClick={() => changePage(page + 1)} className="flex size-9 items-center justify-center rounded-md hover:bg-accent disabled:opacity-30"><ChevronRight className="size-4" /></button>
              </div>}
            </aside>

            <section className="min-w-0" aria-label="Selected item">
              <div className="mb-4 flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">Review item</span>
                <div className="flex gap-1">
                  <button type="button" onClick={goPrev} disabled={index === 0 || busy} aria-label="Previous item" title="Previous item" className="flex size-9 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent disabled:opacity-30"><ChevronLeft className="size-4" /></button>
                  <button type="button" onClick={goNext} disabled={index >= total - 1 || busy} aria-label="Next item" title="Next item" className="flex size-9 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent disabled:opacity-30"><ChevronRight className="size-4" /></button>
                </div>
              </div>
              <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <InboxThumbnail key={`${item.id}-${item.thumbnailFile}`} item={item} />
                  <h3 className="mt-4 break-words text-xl font-semibold leading-snug [overflow-wrap:anywhere]">{item.title}</h3>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {item.studioName && <span className="break-words">{item.studioName}</span>}
                    {item.releaseDate && <time dateTime={item.releaseDate}>{item.releaseDate}</time>}
                  </div>
                </div>
                <div key={item.id} className="min-w-0 space-y-6 xl:border-l xl:border-border xl:pl-6">
                  <div>
                    <h4 className="mb-3 text-xs font-medium text-muted-foreground">Rating</h4>
                    <StarRating itemId={item.id} rating={item.rating} size="md" />
                  </div>
                  <div>
                    <h4 className="mb-3 text-xs font-medium text-muted-foreground">Performers</h4>
                    <PerformerEditor itemId={item.id} performers={item.performers} source="user" />
                  </div>
                  <div>
                    <h4 className="mb-3 text-xs font-medium text-muted-foreground">Tags</h4>
                    <TagEditor itemId={item.id} tags={item.tags.map((t) => ({ ...t, color: null }))} />
                  </div>
                </div>
              </div>
              <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <button type="button" onClick={goNext} disabled={index >= total - 1 || busy} className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><SkipForward className="size-4" />Skip for now</button>
                <button type="button" onClick={markDone} disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {triageMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
                  Mark done
                </button>
              </footer>
            </section>
          </div>
        )}
      </div>
    </AppShell>
  );
}
