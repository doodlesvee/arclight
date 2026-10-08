import { useCallback, useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Inbox, SkipForward } from "lucide-react";
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
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-muted-foreground">
      <Inbox className="size-16 opacity-30" />
      <p className="text-lg font-medium">All caught up</p>
      <p className="text-sm">New items will appear here after a scan.</p>
    </div>
  );
}

export function InboxPage() {
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ["inbox"],
    queryFn: async () => {
      const res = await fetch("/api/inbox");
      if (!res.ok) throw new Error("Failed to load inbox");
      return res.json() as Promise<InboxResponse>;
    },
  });

  const items = data?.items ?? [];
  const item = items[index] ?? null;
  const total = items.length;

  const triageMutation = useMutation({
    mutationFn: (ids: number[]) => triageItems(ids),
    onSuccess: () => {
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
    },
  });

  const goNext = useCallback(() => {
    if (index < total - 1) setIndex((i) => i + 1);
  }, [index, total]);

  const goPrev = useCallback(() => {
    if (index > 0) setIndex((i) => i - 1);
  }, [index]);

  const markDone = useCallback(() => {
    if (!item) return;
    triageMutation.mutate([item.id]);
    if (index >= total - 1 && index > 0) {
      setIndex((i) => i - 1);
    }
  }, [item, index, total, triageMutation]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

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
  }, [total, index]);

  return (
    <AppShell title="Inbox">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Inbox className="size-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">
              {total > 0 ? `${total} unsorted` : "Inbox"}
            </h2>
          </div>
          {total > 0 && (
            <button
              type="button"
              onClick={() => triageAllMutation.mutate()}
              disabled={triageAllMutation.isPending}
              className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/80"
            >
              <CheckCircle2 className="size-3.5" />
              Mark all done
            </button>
          )}
        </div>

        {isLoading && (
          <div className="flex justify-center py-24">
            <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          </div>
        )}

        {!isLoading && total === 0 && <EmptyInbox />}

        {!isLoading && item && (
          <div className="space-y-6">
            {/* Navigation */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={goPrev}
                disabled={index === 0}
                className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
                Previous
              </button>
              <span className="tabular-nums text-sm text-muted-foreground">
                {index + 1} / {total}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={index >= total - 1}
                className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
              >
                Next
                <ChevronRight className="size-4" />
              </button>
            </div>

            {/* Card */}
            <div className="overflow-hidden rounded-xl border border-border bg-secondary/30">
              {/* Thumbnail */}
              <div className="relative aspect-video w-full bg-black">
                {item.thumbnailFile ? (
                  <img
                    key={item.id}
                    src={thumbnailUrl(item)}
                    alt={item.title}
                    className="size-full object-cover"
                    style={framingStyle(item)}
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    No thumbnail
                  </div>
                )}
                {item.durationSeconds != null && (
                  <span className="absolute bottom-3 right-3 rounded bg-black/70 px-2 py-0.5 text-xs font-medium tabular-nums text-white">
                    {formatDuration(item.durationSeconds)}
                  </span>
                )}
              </div>

              {/* Metadata */}
              <div className="space-y-5 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold leading-tight">{item.title}</h3>
                    {item.studioName && (
                      <p className="mt-1 text-sm text-muted-foreground">{item.studioName}</p>
                    )}
                    {item.releaseDate && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{item.releaseDate}</p>
                    )}
                  </div>
                  <StarRating itemId={item.id} rating={item.rating} size="md" />
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Performers
                    </label>
                    <PerformerEditor
                      itemId={item.id}
                      performers={item.performers}
                      source="user"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Tags
                    </label>
                    <TagEditor itemId={item.id} tags={item.tags.map((t) => ({ ...t, color: null }))} />
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={markDone}
                    className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <CheckCircle2 className="size-4" />
                    Done
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      markDone();
                      goNext();
                    }}
                    className="flex items-center gap-2 rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <SkipForward className="size-4" />
                    Skip
                  </button>
                  <span className="ml-auto text-xs text-muted-foreground">
                    <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">←</kbd>
                    <kbd className="ml-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">→</kbd>
                    {" "}navigate{" · "}
                    <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">Enter</kbd>
                    {" "}done
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
