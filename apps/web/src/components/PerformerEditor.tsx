import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { savePerformers, type Performer } from "@/lib/mediaItemApi";
import { circleStyle, performerPortraitUrl } from "@/lib/performerApi";
import { PerformerAvatar } from "./PerformerAvatar";
import type { PerformerSummary } from "./PerformerCard";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export function PerformerEditor({
  itemId,
  performers,
  source,
  readOnly = false,
}: {
  itemId: number;
  performers: Performer[];
  source: "scanner" | "user";
  /** Display only — no remove buttons, no input, no provenance hint. */
  readOnly?: boolean;
}) {
  const [pending, setPending] = useState<string[]>(performers.map((p) => p.name));
  const [input, setInput] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    setPending(performers.map((p) => p.name));
  }, [performers]);

  // The item payload carries only id and name, so the portrait comes from the
  // performers list. Same query key the homepage row uses, so this is served
  // from cache rather than costing another request.
  const { data: allPerformers } = useQuery({
    queryKey: ["performers"],
    queryFn: () => fetchJson<{ performers: PerformerSummary[] }>("/api/performers"),
  });

  const summaryByName = new Map(
    (allPerformers?.performers ?? []).map((p) => [p.name.toLowerCase(), p])
  );

  const mutation = useMutation({
    mutationFn: (performerNames: string[]) => savePerformers(itemId, performerNames),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-item", itemId] });
      queryClient.invalidateQueries({ queryKey: ["media-items"] });
      queryClient.invalidateQueries({ queryKey: ["performers"] });
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  // Guards more than a redundant request: any successful save hands this item
  // over to you permanently, so the folder layout stops updating it. Opening
  // the editor and idly clicking Save must not silently do that.
  const dirty =
    JSON.stringify([...pending].sort()) !==
    JSON.stringify(performers.map((p) => p.name).sort());

  function addPerformer() {
    const name = input.trim();
    if (name && !pending.some((n) => n.toLowerCase() === name.toLowerCase())) {
      setPending([...pending, name]);
    }
    setInput("");
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-start gap-4">
        {pending.map((name) => {
          const summary = summaryByName.get(name.toLowerCase());
          return (
            <div key={name} className="group relative w-20">
              <button
                type="button"
                // A name you've only just typed has no performer record yet,
                // so there's nowhere to navigate to until it's saved.
                onClick={() =>
                  summary &&
                  void navigate({
                    to: "/performer/$performerId",
                    params: { performerId: String(summary.id) },
                  })
                }
                disabled={!summary}
                title={summary ? `See ${name}` : name}
                className="block w-full focus-visible:outline-none disabled:cursor-default"
              >
                <PerformerAvatar
                  name={name}
                  src={summary ? performerPortraitUrl(summary) : null}
                  framing={summary ? circleStyle(summary) : undefined}
                  className="aspect-square w-20 transition-all duration-200 group-hover:ring-2 group-hover:ring-white/50"
                  fallbackClassName="text-xl"
                />
                <span
                  className="mt-1.5 block truncate text-center text-[11px] font-medium leading-tight"
                  title={name}
                >
                  {name}
                </span>
              </button>

              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setPending(pending.filter((n) => n !== name))}
                  aria-label={`Remove performer ${name}`}
                  className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-black/80 text-white opacity-0 ring-1 ring-white/30 transition-opacity hover:bg-black focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          );
        })}

        {pending.length === 0 && !readOnly && (
          <span className="text-xs text-muted-foreground">No performers yet</span>
        )}
        {pending.length === 0 && readOnly && (
          <span className="text-xs text-muted-foreground/60">—</span>
        )}
      </div>

      {!readOnly && (
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addPerformer();
            }
          }}
          placeholder="Add performer…"
          className="w-28 border-b border-border bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        {dirty && (
          <button
            type="button"
            onClick={() => mutation.mutate(pending)}
            disabled={mutation.isPending}
            className="rounded bg-secondary px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            Save
          </button>
        )}
      </div>
      )}

      {!readOnly && (
        <p className="text-[11px] text-muted-foreground/70">
          {source === "scanner"
            ? "From the folder name — saving takes over."
            : "Set by you; the folder no longer updates this."}
        </p>
      )}
    </div>
  );
}
