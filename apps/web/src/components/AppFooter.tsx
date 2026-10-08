import { Clapperboard } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { formatBytes, useLibraryStats } from "@/lib/statsApi";

export function AppFooter() {
  // Shares one cache entry with the sidebar, notification centre and settings
  // panel, so this is served from cache rather than a second request.
  const { data: stats } = useLibraryStats();

  // Built as a list rather than written out with separators between them.
  // Interleaved "·" spans wrap like any other word, so on a narrow screen one
  // would land at the end of a line with nothing after it — the footer read
  // as though it had been cut off. Spacing does the separating instead.
  const figures = stats
    ? [
        { key: "videos", text: `${stats.videos} videos`, strong: true },
        stats.photos > 0 ? { key: "photos", text: `${stats.photos} photos` } : null,
        { key: "folders", text: `${stats.folders} folders` },
        { key: "tags", text: `${stats.tags} tags` },
        { key: "collections", text: `${stats.collections} collections` },
        stats.totalBytes > 0
          ? { key: "size", text: formatBytes(stats.totalBytes), strong: true }
          : null,
      ].filter((f) => f !== null)
    : [];

  return (
    <footer className="mt-auto border-t border-border px-4 py-5 text-xs text-muted-foreground md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 font-medium text-foreground/80">
            <Clapperboard className="size-3.5" />
            ArcLight
          </span>
          {/* Two shortcuts have no button anywhere — this is how you'd find
              out they exist at all. Padded out to a usable tap target, and
              pulled back in by the same amount so the row keeps its height. */}
          <Link
            to="/help"
            className="-my-1.5 py-1.5 transition-colors hover:text-foreground"
          >
            Shortcuts
          </Link>
          <a
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
            className="-my-1.5 py-1.5 transition-colors hover:text-foreground"
          >
            API docs
          </a>
        </div>

        {/* Lives here rather than in the sidebar so collapsing the rail never
            hides it. */}
        {figures.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {figures.map((figure) => (
              <span
                key={figure.key}
                className={figure.strong ? "text-foreground/80" : undefined}
              >
                {figure.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}
