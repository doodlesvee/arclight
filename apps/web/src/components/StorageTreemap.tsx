import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CornerLeftUp, Home, Loader2 } from "lucide-react";
import { CHART_COLORS, REST_COLOR } from "@/lib/donut";
import { formatBytes } from "@/lib/statsApi";
import { squarify } from "@/lib/treemap";
import { cn } from "@/lib/utils";

type TreemapNode = { name: string; path: string | null; bytes: number; files: number };
type TreemapResponse = {
  path: string | null;
  parent: string | null;
  nodes: TreemapNode[];
  totalBytes: number;
};

// The layout is computed in a 100 x 50 space and drawn as percentages, so it
// scales with the container without measuring it.
const WIDTH = 100;
const HEIGHT = 50;

async function fetchTreemap(path: string | undefined): Promise<TreemapResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/storage/treemap${query}`);
  if (!res.ok) throw new Error(`Failed to load the space map: ${res.status}`);
  return res.json();
}

/**
 * Where the disk space goes, folder by folder. Each block's area is its share
 * of the folder you are looking at; click one to look inside it.
 */
export function StorageTreemap() {
  const [path, setPath] = useState<string | undefined>(undefined);

  const { data, isLoading, error } = useQuery({
    queryKey: ["storage-treemap", path ?? "root"],
    queryFn: () => fetchTreemap(path),
  });

  const tiles = useMemo(
    () =>
      data
        ? squarify(
            data.nodes.map((node) => ({ ...node, value: node.bytes })),
            { x: 0, y: 0, w: WIDTH, h: HEIGHT },
          )
        : [],
    [data],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setPath(undefined)}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
            path === undefined
              ? "font-semibold text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Home className="size-3" />
          All folders
        </button>
        {data?.path && (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{data.path}</span>
            <button
              type="button"
              onClick={() => setPath(data.parent ?? undefined)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CornerLeftUp className="size-3" />
              Up
            </button>
          </>
        )}
        {data && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {formatBytes(data.totalBytes)}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex aspect-[2/1] items-center justify-center rounded-md bg-secondary/40 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Mapping…
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && tiles.length === 0 && (
        <p className="rounded-md bg-secondary/50 px-3 py-6 text-center text-sm text-muted-foreground">
          Nothing scanned in here yet.
        </p>
      )}

      {data && tiles.length > 0 && (
        <div className="relative aspect-[2/1] w-full overflow-hidden rounded-md bg-secondary/30">
          {tiles.map((tile, i) => {
            const node = tile.item;
            const openable = node.path !== null;
            const roomForText = tile.w > 12 && tile.h > 9;
            const content = (
              <>
                {roomForText && (
                  <>
                    <span className="block truncate text-xs font-semibold">{node.name}</span>
                    <span className="block truncate text-[11px] opacity-80">
                      {formatBytes(node.bytes)} · {node.files.toLocaleString()} files
                    </span>
                  </>
                )}
              </>
            );
            const className = cn(
              "absolute overflow-hidden p-1 text-left text-white",
              openable ? "cursor-pointer hover:brightness-125" : "cursor-default",
            );
            const style = {
              left: `${(tile.x / WIDTH) * 100}%`,
              top: `${(tile.y / HEIGHT) * 100}%`,
              width: `${(tile.w / WIDTH) * 100}%`,
              height: `${(tile.h / HEIGHT) * 100}%`,
            };
            const inner = (
              <div
                className="size-full overflow-hidden rounded-sm p-1.5"
                style={{ backgroundColor: openable ? CHART_COLORS[i % CHART_COLORS.length] : REST_COLOR }}
              >
                {content}
              </div>
            );
            const title = `${node.name} — ${formatBytes(node.bytes)}, ${node.files.toLocaleString()} files`;
            return openable ? (
              <button
                key={node.path}
                type="button"
                title={title}
                onClick={() => setPath(node.path ?? undefined)}
                className={className}
                style={style}
              >
                {inner}
              </button>
            ) : (
              <div key={node.name} title={title} className={className} style={style}>
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
