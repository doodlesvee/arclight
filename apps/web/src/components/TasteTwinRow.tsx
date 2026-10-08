import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ScrollRow } from "./ScrollRow";
import { performerPortraitUrl, portraitStyle } from "@/lib/performerApi";

type TasteTwin = {
  id: number;
  name: string;
  hasImage: boolean;
  imagePositionX: number;
  imagePositionY: number;
  imageScale: number;
  avatarPositionX: number | null;
  avatarPositionY: number | null;
  avatarScale: number | null;
  sharedCount: number;
};

export function TasteTwinRow() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["taste-twins"],
    queryFn: async () => {
      const res = await fetch("/api/taste-twins");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ performers: TasteTwin[] }>;
    },
  });

  const twins = data?.performers ?? [];
  if (!isLoading && twins.length === 0) return null;

  return (
    <ScrollRow
      title="You might like"
      itemCount={twins.length}
      loading={isLoading}
    >
      {twins.map((twin) => {
        // Only performers with an uploaded photo are shown one; the rest get
        // their initial, as before.
        const portrait = twin.hasImage
          ? performerPortraitUrl({ ...twin, hasBanner: false, representativeItemId: null })
          : null;
        return (
          <button
            key={twin.id}
            type="button"
            onClick={() => void navigate({ to: "/performer/$performerId", params: { performerId: String(twin.id) } })}
            className="group flex w-28 shrink-0 flex-col items-center gap-2"
          >
            <div className="relative size-20 overflow-hidden rounded-full bg-white/[0.06] ring-1 ring-white/10 transition-transform group-hover:scale-105">
              {portrait ? (
                <img
                  src={portrait}
                  alt=""
                  className="size-full object-cover"
                  style={portraitStyle(twin)}
                />
              ) : (
                <div className="flex size-full items-center justify-center text-lg font-bold text-muted-foreground">
                  {twin.name[0]?.toUpperCase()}
                </div>
              )}
            </div>
            <div className="w-full text-center">
              <p className="truncate text-sm font-medium">{twin.name}</p>
              <p className="text-xs text-muted-foreground">
                {twin.sharedCount} shared video{twin.sharedCount !== 1 && "s"}
              </p>
            </div>
          </button>
        );
      })}
    </ScrollRow>
  );
}
