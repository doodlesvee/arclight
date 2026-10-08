import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  CornerLeftUp,
  Folder,
  Home,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import {
  addRoot,
  browseFolders,
  cleanupQueryKey,
  fetchRoots,
  removeRoot,
} from "@/lib/libraryApi";
import { fetchSettings, saveScanInterval } from "@/lib/settingsApi";
import { RescanButton } from "./RescanButton";
import { SettingsSection } from "./SettingsSection";

export function LibrarySettingsSection() {
  const queryClient = useQueryClient();
  const [browsing, setBrowsing] = useState(false);
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const { data: rootsData } = useQuery({ queryKey: ["library-roots"], queryFn: fetchRoots });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

  // Named with a trailing underscore to avoid shadowing window.setInterval.
  const setInterval_ = useMutation({
    mutationFn: saveScanInterval,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
  const { data: listing } = useQuery({
    queryKey: ["library-browse", dir ?? "root"],
    queryFn: () => browseFolders(dir),
    enabled: browsing,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["library-roots"] });
  }

  const add = useMutation({
    mutationFn: (p: string) => addRoot(p),
    onSuccess: () => {
      setError(null);
      setBrowsing(false);
      setDir(undefined);
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Which folder is being removed, while the keep-or-delete choice is open.
  const [removing, setRemoving] = useState<{ id: number; path: string } | null>(
    null,
  );

  const remove = useMutation({
    mutationFn: ({ id, deleteData }: { id: number; deleteData: boolean }) =>
      removeRoot(id, deleteData),
    onSuccess: () => {
      setRemoving(null);
      refresh();
      // The cleanup panel counts what removal leaves behind, so it is wrong
      // the moment this finishes either way.
      void queryClient.invalidateQueries({ queryKey: cleanupQueryKey });
    },
  });

  return (
    <SettingsSection
      title="Folders to scan"
      description="Which folders the scanner looks in. You can browse your home folder and any connected drive."
    >

      <ul className="space-y-1.5">
        {rootsData?.roots.map((root) => (
          <li
            key={root.id}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{root.path}</span>
            {root.reachable ? (
              <span className="shrink-0 text-xs text-muted-foreground">{root.files} files</span>
            ) : (
              <span
                title="Left over from a previous media directory — the server can't see this path"
                className="flex shrink-0 items-center gap-1 text-xs text-yellow-500"
              >
                <AlertTriangle className="size-3.5" />
                unreachable
              </span>
            )}
            <button
              type="button"
              onClick={() => setRemoving({ id: root.id, path: root.path })}
              disabled={remove.isPending}
              aria-label={`Stop scanning ${root.path}`}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
        {removing && (
          <li className="space-y-3 rounded-md border border-border bg-secondary/40 px-3 py-3">
            <div>
              <p className="text-sm font-medium">Stop scanning this folder?</p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {removing.path}
              </p>
            </div>
            {/* Asked rather than assumed: keeping the data makes re-adding the
                folder instant, and deleting it is the only way the names stop
                turning up in your lists. Only you know which this is. */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  remove.mutate({ id: removing.id, deleteData: false })
                }
                disabled={remove.isPending}
                className="rounded-md bg-secondary px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
              >
                Keep its data
              </button>
              <button
                type="button"
                onClick={() =>
                  remove.mutate({ id: removing.id, deleteData: true })
                }
                disabled={remove.isPending}
                className="flex items-center gap-1.5 rounded-md bg-destructive/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-destructive disabled:opacity-50"
              >
                {remove.isPending && <Loader2 className="size-3.5 animate-spin" />}
                Delete its data too
              </button>
              <button
                type="button"
                onClick={() => setRemoving(null)}
                disabled={remove.isPending}
                className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              Keeping it means adding the folder back restores every title,
              favourite and piece of artwork. Either way your files are left
              alone.
            </p>
          </li>
        )}

        {rootsData?.roots.length === 0 && (
          <li className="text-xs text-muted-foreground">
            No folders configured — nothing will be found on the next scan.
          </li>
        )}
      </ul>

      {browsing ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setDir(undefined)}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                dir === undefined
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Home className="size-3" />
              Locations
            </button>
            {listing?.path && (
              <>
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {listing.path}
                </span>
              </>
            )}
            {(listing?.parent || (listing?.path && !listing?.parent)) && (
              <button
                type="button"
                onClick={() =>
                  listing?.parent ? setDir(listing.parent) : setDir(undefined)
                }
                className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <CornerLeftUp className="size-3" />
                Up
              </button>
            )}
          </div>

          {listing && listing.directories.length > 0 ? (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto">
              {listing.directories.map((entry) => (
                <li key={entry.path} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDir(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded p-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    onClick={() => add.mutate(entry.path)}
                    disabled={add.isPending}
                    className="shrink-0 rounded bg-secondary px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          ) : listing?.path ? (
            <p className="text-xs text-muted-foreground">No subfolders here.</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Pick a location to browse.
            </p>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            {listing?.path && (
              <button
                type="button"
                onClick={() => add.mutate(listing.path!)}
                disabled={add.isPending}
                className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
              >
                Add this folder
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setBrowsing(false);
                setDir(undefined);
                setError(null);
              }}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        >
          <Plus className="size-4" />
          Add a folder
        </button>
      )}

      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <RescanButton />
          <span className="text-[11px] text-muted-foreground/70">
            Picks up new files and rebuilds missing artwork.
          </span>
        </div>

        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Check automatically</span>
          <select
            value={settings?.scan.intervalMinutes ?? 15}
            onChange={(e) => setInterval_.mutate(Number(e.target.value))}
            disabled={setInterval_.isPending}
            className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-sm outline-none focus:border-ring/60 disabled:opacity-50"
          >
            {(settings?.scanIntervals ?? [0, 5, 15, 30, 60, 180]).map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0
                  ? "Never"
                  : minutes < 60
                    ? `Every ${minutes} minutes`
                    : `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </label>

        <p className="text-[11px] text-muted-foreground/70">
          A scan isn’t free — it checks every known file — so pick an interval that suits how
          often you add things rather than the shortest one.
        </p>
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        Removing a folder doesn’t delete anything. Its videos are marked missing on the next
        scan, and come back if you add it again.
      </p>
    </SettingsSection>
  );
}
