import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { FramingEditor, type FramingValue } from "@/components/FramingEditor";
import { getRouteApi } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { MediaDetailModal } from "@/components/MediaDetailModal";
import { PerformerContinueWatching } from "@/components/PerformerContinueWatching";
import { AlbumRow } from "@/components/AlbumRow";
import { PerformerCoPerformers } from "@/components/PerformerCoPerformers";
import { PerformerStats } from "@/components/PerformerStats";
import { PerformerVideos } from "@/components/PerformerVideos";
import { PerformerBanner } from "@/components/PerformerBanner";
import { PerformerBio } from "@/components/PerformerBio";
import { PerformerImageMenu } from "@/components/PerformerImageMenu";
import { PerformerImagePicker } from "@/components/PerformerImagePicker";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import {
  fetchPerformer,
  performerBannerUrl,
  performerPortraitUrl,
  circleFraming,
  circleStyle,
  saveCircleFraming,
  savePortraitFraming,
  setPerformerFavorite,
} from "@/lib/performerApi";

const routeApi = getRouteApi("/performer/$performerId");

export function PerformerPage() {
  const { performerId } = routeApi.useParams();
  const id = Number(performerId);
  // Which crop is being adjusted: the tiles' 2:3, or the round picture here.
  const [reframing, setReframing] = useState<"tile" | "circle" | null>(null);
  // Opening a video from here shows the modal in place, rather than
  // navigating away and losing your position on the profile.
  const [open, setOpen] = useState<{ id: number; autoPlay: boolean } | null>(
    null,
  );
  const openItem = (id: number, autoPlay: boolean) => setOpen({ id, autoPlay });
  const [bannerEditRequest, setBannerEditRequest] = useState(0);
  const queryClient = useQueryClient();

  const saveFraming = useMutation({
    mutationFn: (next: FramingValue) =>
      savePortraitFraming(id, {
        imagePositionX: next.x,
        imagePositionY: next.y,
        imageScale: next.scale,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["performer", id] });
      // The cards on the performers page and the home row show the same
      // portrait, so they have to repaint too.
      queryClient.invalidateQueries({ queryKey: ["performers"] });
      setReframing(null);
    },
  });

  const saveCircle = useMutation({
    mutationFn: (next: FramingValue | null) =>
      saveCircleFraming(
        id,
        next && { avatarPositionX: next.x, avatarPositionY: next.y, avatarScale: next.scale },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["performer", id] });
      // Everywhere else a round picture of them appears.
      queryClient.invalidateQueries({ queryKey: ["performers"] });
      setReframing(null);
    },
  });

  const favorite = useMutation({
    mutationFn: (next: boolean) => setPerformerFavorite(id, next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["performer", id] });
      // The performers page pins favourites to the top, so its list has to
      // re-sort too.
      queryClient.invalidateQueries({ queryKey: ["performers"] });
    },
  });

  const { data: performer, isError } = useQuery({
    queryKey: ["performer", id],
    queryFn: () => fetchPerformer(id),
  });

  if (isError) {
    return (
      <AppShell title="Performer not found">
        <p className="px-4 text-sm text-muted-foreground md:px-6">
          That performer doesn’t exist — it may have been deleted.
        </p>
      </AppShell>
    );
  }

  // Same resolver the hover card uses, so the two cannot disagree about which
  // picture is this performer's banner. It was worked out inline here, which
  // is how the second caller ended up reproducing the preference order.
  //
  // Still falls back to a frame from one of their videos, so a performer
  // never renders as an empty grey slab.
  const bannerSrc = performer ? performerBannerUrl(performer) : null;
  // Same resolver the homepage row and the modal use, so all three show the
  // same face for a given performer.
  const avatarSrc = performer ? performerPortraitUrl(performer) : null;

  return (
    <AppShell>
      <section className="relative">
        {performer && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/60 to-transparent px-4 pb-10 pt-4 md:px-6">
            <Breadcrumbs
              overlay
              items={[
                { label: "Performers", to: "/performers" },
                { label: performer.name },
              ]}
            />
          </div>
        )}
        <PerformerBanner
          performerId={performer?.id ?? 0}
          src={bannerSrc}
          positionY={performer?.bannerPositionY ?? 50}
          editRequest={bannerEditRequest}
        >
          {performer && (
            <PerformerImagePicker
              performerId={performer.id}
              kind="banner"
              hasImage={performer.hasBanner}
              onUploaded={() => setBannerEditRequest((n) => n + 1)}
            />
          )}
        </PerformerBanner>

        {/* Minimal overlap — just enough to tie the portrait to the banner. */}
        <div className="relative -mt-8 flex flex-col items-start gap-4 px-4 sm:-mt-10 sm:flex-row sm:items-end md:px-6">
          <div className="group relative shrink-0">
            <div className="size-28 overflow-hidden rounded-full bg-secondary ring-4 ring-background sm:size-36">
              {avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt=""
                  style={performer ? circleStyle(performer) : undefined}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-4xl font-semibold text-muted-foreground">
                  {performer?.name.trim()[0]?.toUpperCase() ?? "?"}
                </div>
              )}
            </div>

            {performer && (
              <PerformerImageMenu
                performerId={performer.id}
                kind="avatar"
                hasImage={performer.hasImage}
                // A video-frame fallback can be reframed too — it's the same
                // CSS object-position, and nothing about the file changes.
                canReposition={Boolean(avatarSrc)}
                onReposition={() => setReframing("tile")}
                onRepositionCircle={() => setReframing("circle")}
                onUploaded={() => setReframing("tile")}
                // Bottom-right of the circle, the way a profile picture is
                // edited everywhere else.
                className="bottom-0 right-0"
              />
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2 pb-1">
            <div className="flex items-center gap-2">
              <h1 className="sensitive truncate text-3xl font-bold tracking-tight sm:text-4xl">
                {performer?.name ?? " "}
              </h1>
              {performer && (
                <button
                  type="button"
                  onClick={() => favorite.mutate(!performer.isFavorite)}
                  disabled={favorite.isPending}
                  aria-pressed={performer.isFavorite}
                  aria-label={
                    performer.isFavorite
                      ? "Remove from favourites"
                      : "Add to favourites"
                  }
                  title={
                    performer.isFavorite
                      ? "Remove from favourites"
                      : "Add to favourites"
                  }
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                >
                  <Heart
                    className={
                      performer.isFavorite
                        ? "size-5 fill-red-500 text-red-500"
                        : "size-5"
                    }
                  />
                </button>
              )}
            </div>
            {/* Gated on `reframing` rather than rendering an empty wrapper on
                every other view — that wrapper still counted as a flex child
                and added a gap under the stats you could see but not explain. */}
            {performer && reframing === "circle" && avatarSrc && (
              <div className="space-y-1.5">
                <FramingEditor
                  // Keyed so a reset starts the drag from the tile framing.
                  key={`${performer.avatarPositionX}-${performer.avatarPositionY}-${performer.avatarScale}`}
                  src={avatarSrc}
                  value={{
                    x: circleFraming(performer).imagePositionX ?? 50,
                    y: circleFraming(performer).imagePositionY ?? 0,
                    scale: circleFraming(performer).imageScale ?? 100,
                  }}
                  aspectClass="aspect-square"
                  round
                  saving={saveCircle.isPending}
                  onSave={(next) => saveCircle.mutate(next)}
                  onCancel={() => setReframing(null)}
                  note="Used for the round picture here, in a video's details, in search and in the network graph. The tiles keep their own framing."
                />
                {performer.avatarPositionX != null && (
                  <button
                    type="button"
                    onClick={() => saveCircle.mutate(null)}
                    disabled={saveCircle.isPending}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    Match the tiles again
                  </button>
                )}
              </div>
            )}
            {performer && reframing === "tile" && avatarSrc && (
              <FramingEditor
                src={avatarSrc}
                value={{
                  x: performer.imagePositionX,
                  y: performer.imagePositionY,
                  scale: performer.imageScale,
                }}
                // The portrait's tallest frame is the 2:3 card on the
                // performers page; framing here matches what that shows.
                // The circular avatars crop further in from the same band.
                aspectClass="aspect-[2/3]"
                saving={saveFraming.isPending}
                onSave={(next) => saveFraming.mutate(next)}
                onCancel={() => setReframing(null)}
                note="Used for the tiles on the performers page, the home row and elsewhere. The round picture has its own framing."
              />
            )}
          </div>
        </div>
      </section>

      {/* Out of the header column for the same reason the bio is: five figures
          crammed beside a 4xl name and a portrait had nowhere to be noticed. */}
      {performer && (
        // The margin lives here rather than in the component: the strip should
        // not have an opinion about what sits above it.
        <div className="mt-6">
          <PerformerStats performer={performer} />
        </div>
      )}

      {/* Full width rather than squeezed into the header column beside the
          avatar — prose needs a readable line length. */}
      {performer && (
        <div className="px-4 pt-6 md:px-6">
          <PerformerBio performerId={performer.id} bio={performer.bio} />
        </div>
      )}

      {performer && (
        <div className="space-y-8 px-4 py-6 md:px-6 md:py-8">
          {/* What you most likely came back for, before anything to browse. */}
          <PerformerContinueWatching
            performer={performer}
            onSelect={openItem}
          />

          <PerformerCoPerformers performers={performer.coPerformers} />

          <AlbumRow performer={performer.name} />

          <PerformerVideos performer={performer} onSelect={openItem} />
        </div>
      )}

      {open && (
        <MediaDetailModal
          itemId={open.id}
          autoPlay={open.autoPlay}
          onClose={() => setOpen(null)}
        />
      )}
    </AppShell>
  );
}
