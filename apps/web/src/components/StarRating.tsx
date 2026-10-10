import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star, X } from "lucide-react";
import { updateItem, type MediaItemDetail } from "@/lib/mediaItemApi";
import { cn } from "@/lib/utils";

/**
 * Five stars, set in one click.
 *
 * Clicking the rating an item already has clears it — the gesture people
 * reach for on every other star widget. That gesture is invisible, though,
 * so a rated item also shows a small × that does the same thing.
 *
 * Not gated behind the sheet's edit mode, for the same reason the favourite
 * heart is not: a rating is a state you set while watching, not metadata you
 * sit down to correct.
 */
export function StarRating({
  itemId,
  rating,
  size = "sm",
}: {
  itemId: number;
  rating: number | null;
  size?: "sm" | "md";
}) {
  const queryClient = useQueryClient();
  const [hovered, setHovered] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: (next: number | null) => updateItem(itemId, { rating: next }),
    // Optimistic: a star that lights up a round trip after the click reads
    // as a missed click, and you click it again.
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["media-item", itemId] });
      const previous = queryClient.getQueryData<MediaItemDetail>(["media-item", itemId]);
      if (previous) {
        queryClient.setQueryData<MediaItemDetail>(["media-item", itemId], {
          ...previous,
          rating: next,
        });
      }
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["media-item", itemId], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["media-item", itemId] });
      // Rating sorts and filters live in the grid queries.
      queryClient.invalidateQueries({ queryKey: ["media-items"] });
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  const shown = hovered ?? rating ?? 0;
  const iconSize = size === "md" ? "size-5" : "size-4";

  return (
    <span
      role="radiogroup"
      aria-label="Rating"
      className="inline-flex items-center"
      onMouseLeave={() => setHovered(null)}
    >
      {[1, 2, 3, 4, 5].map((stars) => (
        <button
          key={stars}
          type="button"
          role="radio"
          aria-checked={rating === stars}
          aria-label={`${stars} star${stars === 1 ? "" : "s"}`}
          title={rating === stars ? "Clear rating" : `Rate ${stars}`}
          onMouseEnter={() => setHovered(stars)}
          onClick={() => mutation.mutate(rating === stars ? null : stars)}
          className="p-0.5 transition-transform hover:scale-110"
        >
          <Star
            className={cn(
              iconSize,
              "transition-colors",
              stars <= shown
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/50",
            )}
          />
        </button>
      ))}
      {rating !== null && (
        <button
          type="button"
          aria-label="Remove rating"
          title="Remove rating"
          // Previews the cleared state, as hovering a star previews its rating.
          onMouseEnter={() => setHovered(0)}
          onClick={() => mutation.mutate(null)}
          className="ml-1 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <X className={size === "md" ? "size-4" : "size-3.5"} />
        </button>
      )}
    </span>
  );
}
