import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Database,
  Eye,
  EyeOff,
  Lock,
  FileEdit,
  FilePlus2,
  FolderSync,
  Shield,
  Tag,
  Trash2,
  User,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type ActivityEvent = {
  id: number;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  mediaItemId: number | null;
  createdAt: string;
};

const TYPE_CONFIG: Record<
  string,
  { icon: typeof Archive; label: string; color: string }
> = {
  add: { icon: FilePlus2, label: "Added", color: "text-green-400" },
  watch: { icon: Eye, label: "Watched", color: "text-blue-400" },
  edit: { icon: FileEdit, label: "Edited", color: "text-amber-400" },
  tag: { icon: Tag, label: "Tags", color: "text-purple-400" },
  performer: { icon: User, label: "Performers", color: "text-pink-400" },
  hide: { icon: EyeOff, label: "Hidden", color: "text-zinc-400" },
  vault: { icon: Lock, label: "Vault", color: "text-rose-400" },
  scan: { icon: FolderSync, label: "Scans", color: "text-cyan-400" },
  backup: { icon: Archive, label: "Backups", color: "text-orange-400" },
  library: { icon: Database, label: "Library", color: "text-teal-400" },
  cache: { icon: Database, label: "Cache", color: "text-zinc-400" },
  privacy: { icon: Shield, label: "Privacy", color: "text-rose-400" },
  metadata: { icon: FileEdit, label: "Metadata", color: "text-amber-400" },
  collection: { icon: Database, label: "Collection", color: "text-indigo-400" },
};

const FILTER_TABS = [
  { key: undefined as string | undefined, label: "All" },
  { key: "add", label: "Added" },
  { key: "watch", label: "Watched" },
  { key: "edit", label: "Edited" },
  { key: "scan", label: "Scans" },
  { key: "backup", label: "Backups" },
];

async function fetchActivity(
  type?: string,
): Promise<{ events: ActivityEvent[] }> {
  const params = new URLSearchParams();
  params.set("limit", "200");
  if (type) params.set("type", type);
  const response = await fetch(`/api/activity?${params}`);
  if (!response.ok)
    throw new Error(`Activity request failed: ${response.status}`);
  return response.json();
}

function dayKey(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function groupByDay(
  events: ActivityEvent[],
): { day: string; events: ActivityEvent[] }[] {
  const groups: Map<string, ActivityEvent[]> = new Map();
  for (const event of events) {
    const key = dayKey(event.createdAt);
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }
  return Array.from(groups, ([day, events]) => ({ day, events }));
}

function timeOnly(dateStr: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
  }).format(new Date(dateStr));
}

export function ActivityLogSection() {
  const queryClient = useQueryClient();
  const [activeType, setActiveType] = useState<string | undefined>(undefined);

  const { data, isError, isLoading } = useQuery({
    queryKey: ["activity", activeType],
    queryFn: () => fetchActivity(activeType),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/activity", { method: "DELETE" });
      if (!response.ok)
        throw new Error(`Failed to clear activity: ${response.status}`);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
  });

  if (isLoading) return <div className="skeleton h-64 rounded-lg" />;
  if (isError || !data) {
    return (
      <p className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
        Activity log is unavailable.
      </p>
    );
  }

  const grouped = groupByDay(data.events);

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card/60 p-5"
      aria-labelledby="activity-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="activity-title" className="text-base font-semibold">
            Activity Log
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Full history of what happened in your library.
          </p>
        </div>
        {data.events.length > 0 && (
          <button
            type="button"
            onClick={() => clear.mutate()}
            disabled={clear.isPending}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="size-3.5" /> Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key ?? "all"}
            type="button"
            onClick={() => setActiveType(tab.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              activeType === tab.key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-md bg-secondary/50 px-3 py-4 text-sm text-muted-foreground">
          No activity yet.
        </p>
      ) : (
        <div className="space-y-5">
          {grouped.map(({ day, events }) => (
            <div key={day}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {day}
              </h3>
              <ol className="divide-y divide-border rounded-md border border-border bg-card/40">
                {events.map((event) => {
                  const config = TYPE_CONFIG[event.type] ?? {
                    icon: Database,
                    label: event.type,
                    color: "text-muted-foreground",
                  };
                  const Icon = config.icon;
                  return (
                    <li
                      key={event.id}
                      className="flex items-start gap-3 px-3 py-2.5"
                    >
                      <Icon
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          config.color,
                        )}
                      />
                      <span className="min-w-0 flex-1 text-sm">
                        {event.message}
                      </span>
                      <time
                        className="shrink-0 text-xs tabular-nums text-muted-foreground"
                        dateTime={event.createdAt}
                      >
                        {timeOnly(event.createdAt)}
                      </time>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
