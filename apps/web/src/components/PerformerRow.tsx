import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PerformerCard, type PerformerSummary } from "./PerformerCard";
import { ScrollRow } from "./ScrollRow";
import { pinsChangedEvent, readPins } from "@/lib/pinned";
import { PERFORMER_ROW_TILE_LIMIT } from "@/lib/rowLimits";
import { seededRank } from "@/lib/shuffle";
import { SeeMoreTile } from "./SeeMoreTile";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export function PerformerRow() {
  const navigate = useNavigate();
  const [, refreshPins] = useState(0);
  useEffect(() => {
    const refresh = () => refreshPins((value) => value + 1);
    window.addEventListener(pinsChangedEvent(), refresh);
    return () => window.removeEventListener(pinsChangedEvent(), refresh);
  }, []);

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["performers"],
    queryFn: () =>
      fetchJson<{ performers: PerformerSummary[] }>("/api/performers"),
  });

  // The API deliberately returns performers with no videos — you can create
  // one ahead of the files arriving — but there's nothing to show for them
  // here, so the row filters them out rather than the endpoint.
  const performers = (data?.performers ?? [])
    .filter((p) => p.videoCount > 0)
    // Pinned first, then shuffled. Alphabetical made this row a permanent
    // window onto the letter A — with only twelve tiles showing, the same
    // dozen names appeared every visit and the rest of the library may as
    // well not have existed. Pins stay at the front because that is what
    // pinning is for.
    //
    // Seeded on the fetch rather than random during render, so the row holds
    // its order while you look at it and reshuffles when the data returns.
    .sort(
      (a, b) =>
        Number(
          readPins().some(
            (pin) => pin.type === "performer" && pin.performerId === b.id,
          ),
        ) -
          Number(
            readPins().some(
              (pin) => pin.type === "performer" && pin.performerId === a.id,
            ),
          ) ||
        seededRank(a.id, dataUpdatedAt) - seededRank(b.id, dataUpdatedAt),
    )
    // Capped after sorting, so what survives is the top of the order rather
    // than whichever names the API happened to send first.
    .slice(0, PERFORMER_ROW_TILE_LIMIT);

  return (
    <ScrollRow
      title="Performers"
      itemCount={performers.length}
      loading={isLoading}
    >
      {isLoading
        ? // Portraits are narrow, so more of them fit before the row's edge.
          Array.from({ length: 8 }).map((_, index) => (
            <div
              key={`placeholder-${index}`}
              className="skeleton aspect-[2/3] w-34 shrink-0 rounded-lg sm:w-[275px]"
            />
          ))
        : performers.map((performer) => (
            <PerformerCard
              key={performer.id}
              performer={performer}
              onClick={() =>
                void navigate({
                  to: "/performer/$performerId",
                  params: { performerId: String(performer.id) },
                })
              }
            />
          ))}

      {!isLoading && performers.length > 0 && (
        // Matches the portrait tiles it follows: same width rule, same 2:3.
        <SeeMoreTile
          destination={{ to: "/performers" }}
          className="w-34 shrink-0 sm:w-[275px]"
          aspectRatio="2 / 3"
        />
      )}
    </ScrollRow>
  );
}
