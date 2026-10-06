import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  EyeOff,
  EyeClosed,
  FolderOpen,
  Heart,
  ListPlus,
  ListVideo,
  Pencil,
  Play,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  ScanEye,
} from "lucide-react";
import type { ContextMenuEntry, ContextMenuState } from "@/components/ContextMenu";
import type { MediaCardItem } from "@/components/MediaCard";
import { updateItem, hideItem } from "./mediaItemApi";
import { useAppearance } from "./appearance";
import { useCardShortcuts } from "./cardShortcuts";
import { useQueue, type QueueItem } from "./queue";
import { playItem } from "./appEvents";
import { recordRecent } from "./recent";
import type { TileShape } from "./layout";

/**
 * The tile right-click menu, in one place.
 *
 * It used to live only in MediaGrid, which meant the library page had a menu
 * and every row on the home page, every performer page and Related items had
 * none — right-clicking those fell through to the browser's own menu. Since
 * tile shape is set from this menu, "set it per tile" only worked on one page
 * out of several that draw the same tiles.
 *
 * Split into two exports rather than one, because the two callers need
 * different amounts of it. The grid has entries nothing else can offer — a
 * selection to act on, a position in a list to play from — so it keeps its
 * own menu and takes only `tileShapeEntries` from here. Everything else takes
 * the whole `useTileMenu`. What matters is that the shape entries have a
 * single definition: two copies would drift, and the drift would be invisible
 * until someone right-clicked the same tile in two places and got different
 * answers.
 */

export function queueItemFor(item: MediaCardItem): QueueItem {
  return {
    id: item.id,
    title: item.title,
    thumbnailFile: item.thumbnailFile,
    durationSeconds: item.durationSeconds,
  };
}

/**
 * Pins one tile's shape, or clears it back to the Appearance setting.
 *
 * Invalidates every query that draws this item rather than just the caller's:
 * the same tile appears in the library grid, in half a dozen home rows and in
 * Related items at once, and a shape that changed in one and not the others
 * reads as a bug in whichever you looked at second.
 */
export function useTileShape() {
  const queryClient = useQueryClient();

  return async function setTileShape(item: MediaCardItem, shape: TileShape | null) {
    await updateItem(item.id, { tileShape: shape });
    for (const key of [
      ["media-items"],
      ["collection-items"],
      ["continue-watching"],
      ["media-item", item.id],
    ]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/**
 * The Landscape / Portrait pair, plus a reset once there is one to undo.
 *
 * `checked` reflects the shape the tile is *drawn* at, which for one that has
 * never been set is whatever the Appearance panel says — so the tick always
 * matches the screen rather than only the stored value.
 */
export function tileShapeEntries(
  item: MediaCardItem,
  globalShape: TileShape,
  setTileShape: (item: MediaCardItem, shape: TileShape | null) => Promise<void>,
): ContextMenuEntry[] {
  const effective = item.tileShape ?? globalShape;
  return [
    {
      label: "Landscape tile",
      icon: RectangleHorizontal,
      checked: effective === "landscape",
      onSelect: () => void setTileShape(item, "landscape"),
    },
    {
      label: "Portrait tile",
      icon: RectangleVertical,
      checked: effective === "portrait",
      onSelect: () => void setTileShape(item, "portrait"),
    },
    // Only once there is something to clear, so most tiles do not carry a
    // reset for a state they are already in.
    ...(item.tileShape
      ? [
          {
            label: "Use default shape",
            icon: RotateCcw,
            onSelect: () => void setTileShape(item, null),
          },
        ]
      : []),
  ];
}

/**
 * A complete tile menu for the surfaces that draw tiles without a grid around
 * them — the home rows, performer pages, Related items.
 *
 * Deliberately the grid's menu minus the entries that need a grid: there is
 * no selection to act on and no list position to play from, so "Play from
 * here" and the bulk actions are absent. Everything else matches, because a
 * tile that offers different actions depending on which page it is drawn on
 * is harder to learn than one that offers the same ones everywhere.
 */
export function useTileMenu({
  onOpenFolder,
  onEdit,
}: {
  onOpenFolder?: (id: number, title: string) => void;
  onEdit?: (id: number) => void;
}) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const { tileShape } = useAppearance();
  const { peek, toggleFavourite, toggleWatched } = useCardShortcuts();
  const { add, addNext } = useQueue();
  const setTileShape = useTileShape();
  const queryClient = useQueryClient();

  async function hide(item: MediaCardItem) {
    await hideItem(item.id, true);
    queryClient.invalidateQueries({ queryKey: ["media-items"] });
    queryClient.invalidateQueries({ queryKey: ["collection-items"] });
    queryClient.invalidateQueries({ queryKey: ["continue-watching"] });
    queryClient.invalidateQueries({ queryKey: ["on-this-day"] });
    queryClient.invalidateQueries({ queryKey: ["forgotten-gems"] });
    queryClient.invalidateQueries({ queryKey: ["daily-pick"] });
  }

  function openMenu(event: React.MouseEvent, item: MediaCardItem) {
    event.preventDefault();

    const isVideo = item.itemType === "video";
    const isFolder = item.itemType === "folder";

    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        ...(isFolder && onOpenFolder
          ? [
              {
                label: "Open folder",
                icon: FolderOpen,
                onSelect: () => onOpenFolder(item.id, item.title),
              },
            ]
          : []),
        ...(isVideo
          ? [
              {
                label: "Play",
                icon: Play,
                onSelect: () => {
                  recordRecent("played", item);
                  playItem(item.id);
                },
              },
              ...(item.lastPositionSeconds
                ? [
                    {
                      label: "Resume",
                      icon: Play,
                      onSelect: () => {
                        recordRecent("played", item);
                        playItem(item.id, { resume: true });
                      },
                    },
                  ]
                : []),
            ]
          : []),
        ...(isFolder
          ? []
          : [{ label: "Peek", icon: ScanEye, onSelect: () => peek(item) }]),
        ...(isVideo
          ? [
              { separator: true as const },
              {
                label: "Add to queue",
                icon: ListPlus,
                onSelect: () => add(queueItemFor(item)),
              },
              {
                label: "Play next",
                icon: ListVideo,
                onSelect: () => addNext(queueItemFor(item)),
              },
            ]
          : []),
        { separator: true as const },
        ...tileShapeEntries(item, tileShape, setTileShape),
        ...(isFolder
          ? []
          : [
              { separator: true as const },
              {
                label: "Favourite",
                icon: Heart,
                onSelect: () => toggleFavourite(item),
              },
              ...(isVideo
                ? [
                    {
                      label: "Toggle watched",
                      icon: item.lastPositionSeconds ? Eye : EyeOff,
                      onSelect: () => toggleWatched(item),
                    },
                  ]
                : []),
              ...(onEdit
                ? [
                    {
                      label: "Edit details",
                      icon: Pencil,
                      onSelect: () => onEdit(item.id),
                    },
                  ]
                : []),
              {
                label: "Hide",
                icon: EyeClosed,
                onSelect: () => void hide(item),
              },
            ]),
      ],
    });
  }

  return { menu, setMenu, openMenu };
}
