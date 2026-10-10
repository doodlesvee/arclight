import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { saveTags, type Tag } from "@/lib/mediaItemApi";
import { useToast } from "@/lib/toast";

export function TagEditor({
  itemId,
  tags,
  readOnly = false,
  accent,
}: {
  itemId: number;
  tags: Tag[];
  /** Display only — chips without remove buttons, and no add input. */
  readOnly?: boolean;
  /** Sampled from the item's artwork, so chips match the rest of the modal. */
  accent?: string | null;
}) {
  const [pending, setPending] = useState<string[]>(tags.map((t) => t.name));
  const [input, setInput] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    setPending(tags.map((t) => t.name));
  }, [tags]);

  const mutation = useMutation({
    mutationFn: (tagNames: string[]) => saveTags(itemId, tagNames),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-item", itemId] });
      queryClient.invalidateQueries({ queryKey: ["media-items"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      queryClient.invalidateQueries({ queryKey: ["collection-items"] });
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
    // Tags are edited optimistically in `pending`, so a failed save otherwise
    // leaves the chips showing a state the server never accepted.
    onError: (error) => {
      setPending(tags.map((t) => t.name));
      toast({
        title: "Could not save tags",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    },
  });

  const dirty = JSON.stringify([...pending].sort()) !== JSON.stringify(tags.map((t) => t.name).sort());

  function addTag() {
    const name = input.trim();
    if (name && !pending.includes(name)) {
      setPending([...pending, name]);
    }
    setInput("");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pending.map((name) => (
        <span
          key={name}
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors duration-500"
          style={{
            backgroundColor: accent ? `color-mix(in oklab, ${accent} 18%, transparent)` : undefined,
            color: accent ?? undefined,
          }}
        >
          {name}
          {!readOnly && (
            <button
              type="button"
              onClick={() => setPending(pending.filter((n) => n !== name))}
              aria-label={`Remove tag ${name}`}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {readOnly && pending.length === 0 && (
        <span className="text-xs text-muted-foreground/60">—</span>
      )}
      {!readOnly && (
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag();
          }
        }}
        placeholder="Add tag…"
        className="w-24 border-b border-border bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      )}
      {!readOnly && dirty && (
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
  );
}
