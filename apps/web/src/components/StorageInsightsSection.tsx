import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy as CopyIcon, Film, Loader2, Sparkles, Star, Timer } from "lucide-react";
import { openDetails } from "@/lib/appEvents";
import { CHART_COLORS, REST_COLOR, foldSlices } from "@/lib/donut";
import { framingStyle, thumbnailUrl } from "@/lib/mediaItemApi";
import { performerPortraitUrl, portraitStyle } from "@/lib/performerApi";
import { formatBytes } from "@/lib/statsApi";
import { cn, formatDuration } from "@/lib/utils";
import { DonutChart } from "./DonutChart";
import { SettingsSection } from "./SettingsSection";
import { StorageTreemap } from "./StorageTreemap";

type Representative = { id: number; thumbnailFile: string | null } | null;

type Group = {
  id: number | null;
  name: string;
  bytes: number;
  items: number;
  videos: number;
  photos: number;
  representative?: Representative;
};

type PerformerGroup = Group & {
  hasImage?: boolean;
  hasBanner?: boolean;
  imagePositionX?: number;
  imagePositionY?: number;
  imageScale?: number;
};

type Insights = {
  totals: {
    videos: { items: number; bytes: number; seconds: number };
    photos: { items: number; bytes: number; seconds: number };
    bytes: number;
  };
  byStudio: Group[];
  byPerformer: PerformerGroup[];
  byResolution: (Group & { key: string })[];
  byYear: { years: { year: number; items: number; bytes: number }[]; undated: { items: number; bytes: number } };
  largest: {
    id: number;
    title: string;
    bytes: number;
    height: number | null;
    durationSeconds: number | null;
    studio: string | null;
    bitrateMbps: number | null;
    thumbnailFile: string | null;
    thumbnailPositionX: number;
    thumbnailPositionY: number;
    thumbnailScale: number;
  }[];
  lowerQualityCopies: {
    studio: string;
    releaseDate: string;
    reclaimableBytes: number;
    items: { id: number; title: string; height: number | null; bytes: number; thumbnailFile: string | null }[];
  }[];
};

type CacheUsage = { derivedBytes: number; uploadBytes: number };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function heightLabel(height: number | null): string {
  if (!height) return "—";
  if (height >= 1800) return "4K";
  return `${height}p`;
}

/** "8 videos", "2,612 photos", or both — never a single count that mixes the two. */
function countLabel(row: { videos: number; photos: number }): string {
  const parts = [];
  if (row.videos > 0 || row.photos === 0)
    parts.push(`${row.videos.toLocaleString()} video${row.videos === 1 ? "" : "s"}`);
  if (row.photos > 0) parts.push(`${row.photos.toLocaleString()} photo${row.photos === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Videos only, for performers. Their galleries are counted in the size but
 * not named: "52 videos, 2,813 photos" under a portrait crowds the card, and
 * the scenes are what a performer is browsed by.
 */
function videoCountLabel(videos: number): string {
  return `${videos.toLocaleString()} video${videos === 1 ? "" : "s"}`;
}

function hoursLabel(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 10 ? `${Math.round(hours)} hours` : `${hours.toFixed(1)} hours`;
}

/**
 * Where the library's disk space goes.
 *
 * Built out of the library's own pictures — studio artwork, performer
 * portraits, posters — rather than rows of names and bars, because this is a
 * catalogue and its contents are recognised by sight far faster than by
 * title. Every studio, performer and video links through, so a number that
 * surprises you is one click from the thing it is about.
 *
 * Read-only, like duplicates: the app never deletes an original, so this
 * points at what is worth removing and leaves the removing to you.
 */
export function StorageInsightsSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["storage-insights"],
    queryFn: () => fetchJson<Insights>("/api/storage/insights"),
  });
  const { data: cache } = useQuery({
    // Same key as the cache settings, so clearing the cache there updates this.
    queryKey: ["cache-usage"],
    queryFn: () => fetchJson<CacheUsage>("/api/library/cache"),
  });

  if (isLoading) {
    return (
      <SettingsSection title="Storage">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Adding it up…
        </div>
      </SettingsSection>
    );
  }
  if (error || !data) {
    return (
      <SettingsSection title="Storage">
        <p className="text-sm text-destructive">{error?.message ?? "Could not load storage insights."}</p>
      </SettingsSection>
    );
  }

  return (
    <>
      <Overview data={data} appDataBytes={cache ? cache.derivedBytes + cache.uploadBytes : null} />

      <SettingsSection
        title="Space map"
        description="Every block is a folder, sized by what it takes on disk. Click one to look inside."
      >
        <StorageTreemap />
      </SettingsSection>

      <SettingsSection title="Studios" description="Share of the library by studio. Pick one to open it.">
        <DonutChart
          slices={foldSlices(
            data.byStudio.map((row) => ({
              id: row.id,
              name: row.name,
              value: row.bytes,
              detail: countLabel(row),
            })),
          )}
          format={formatBytes}
          totalLabel="Library"
          isRest={(slice) => slice.name === "Everything else" || slice.name === "No studio"}
          renderName={(slice) =>
            slice.id != null ? (
              <Link to="/studio/$studioId" params={{ studioId: String(slice.id) }} className="hover:underline">
                {slice.name}
              </Link>
            ) : (
              slice.name
            )
          }
        />
      </SettingsSection>

      <PerformerRow rows={data.byPerformer} />
      <LargestVideos rows={data.largest} />
      <ByYear data={data.byYear} />
      <Quality rows={data.byResolution} copies={data.lowerQualityCopies} />
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The headline: one big number, what it is made of, and a few facts that
 * say more than the total does.
 *
 * The composition bar includes the app's own previews and posters, because
 * they are on the same disk and "why is my drive fuller than my library?" is
 * a question this should answer before it is asked.
 */
function Overview({ data, appDataBytes }: { data: Insights; appDataBytes: number | null }) {
  const parts = [
    { key: "videos", label: "Videos", bytes: data.totals.videos.bytes, color: CHART_COLORS[0] },
    { key: "photos", label: "Photos", bytes: data.totals.photos.bytes, color: CHART_COLORS[1] },
    ...(appDataBytes
      ? [{ key: "app", label: "Previews & posters", bytes: appDataBytes, color: CHART_COLORS[2] }]
      : []),
  ];
  const whole = parts.reduce((sum, part) => sum + part.bytes, 0) || 1;
  const videoCount = data.totals.videos.items;
  const videoSeconds = data.totals.videos.seconds;
  const topStudio = data.byStudio.filter((row) => row.id !== null).sort((a, b) => b.bytes - a.bytes)[0];
  const commonest = [...data.byResolution].sort((a, b) => b.items - a.items)[0];

  return (
    <SettingsSection
      title="Storage"
      description="Where the space goes across your scanned folders. Nothing here changes any file."
    >
      <div className="space-y-6">
        <div className="space-y-4">
          <div>
            <p className="text-5xl font-semibold tabular-nums tracking-tight">{formatBytes(data.totals.bytes)}</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {videoCount.toLocaleString()} videos · {data.totals.photos.items.toLocaleString()} photos
              {videoSeconds > 0 && ` · ${hoursLabel(videoSeconds)} of video`}
            </p>
          </div>

          {/* One stacked bar with 2px surface gaps, so neighbours never touch. */}
          <div
            role="img"
            aria-label={parts.map((part) => `${part.label} ${formatBytes(part.bytes)}`).join(", ")}
            className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
          >
            {parts.map((part) => (
              <div
                key={part.key}
                title={`${part.label}: ${formatBytes(part.bytes)}`}
                style={{
                  width: `${(part.bytes / whole) * 100}%`,
                  background: part.color,
                  minWidth: part.bytes > 0 ? 4 : 0,
                }}
                className="h-full"
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
            {parts.map((part) => (
              <li key={part.key} className="flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-sm" style={{ background: part.color }} />
                <span className="text-muted-foreground">{part.label}</span>
                <span className="tabular-nums text-foreground">{formatBytes(part.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* A row under the headline rather than a column beside it: beside
            it, the settings page's width left each tile too narrow for its
            own label. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact
            icon={Film}
            label="Average video"
            value={videoCount ? formatBytes(data.totals.videos.bytes / videoCount) : "—"}
          />
          <Fact
            icon={Timer}
            label="Per hour of video"
            value={videoSeconds ? formatBytes(data.totals.videos.bytes / (videoSeconds / 3600)) : "—"}
          />
          <Fact
            icon={Star}
            label="Biggest studio"
            value={topStudio ? topStudio.name : "—"}
            detail={
              topStudio && data.totals.bytes
                ? `${Math.round((topStudio.bytes / data.totals.bytes) * 100)}% of the library`
                : undefined
            }
          />
          <Fact
            icon={Sparkles}
            label="Most common quality"
            value={commonest && commonest.items > 0 ? commonest.name : "—"}
            detail={
              commonest && videoCount ? `${Math.round((commonest.items / videoCount) * 100)}% of videos` : undefined
            }
          />
        </div>
      </div>
    </SettingsSection>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Film;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="sensitive mt-1.5 truncate text-lg font-semibold tabular-nums tracking-tight">{value}</p>
      {detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Performers as portrait cards, largest first.
 *
 * Cards rather than a pie: a scene with two people in it counts towards both,
 * so these can add up to more than the library and a pie would misstate the
 * proportions. The caption carries the numbers instead.
 */
function PerformerRow({ rows }: { rows: PerformerGroup[] }) {
  const people = rows.filter((row) => row.id !== null);
  const rest = rows.find((row) => row.id === null);
  if (people.length === 0) return null;
  return (
    <SettingsSection
      title="Performers"
      description="The space each performer's scenes take. A scene with two performers counts towards both."
    >
      {/* Bleeds to the card's edges so it reads as scrollable, like the
          library's own rows. */}
      <div className="scrollbar-hide -mx-5 flex gap-3 overflow-x-auto px-5 pb-1">
        {people.map((row, index) => {
          const portrait = performerPortraitUrl({
            id: row.id as number,
            hasImage: row.hasImage ?? false,
            hasBanner: row.hasBanner ?? false,
            representativeItemId: row.representative?.id ?? null,
          });
          return (
            <Link
              key={row.id}
              to="/performer/$performerId"
              params={{ performerId: String(row.id) }}
              className="group w-28 shrink-0 sm:w-32"
            >
              <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-secondary ring-1 ring-border transition-transform duration-200 group-hover:-translate-y-0.5">
                {portrait && (
                  <img
                    src={portrait}
                    alt=""
                    loading="lazy"
                    style={portraitStyle(row)}
                    className="h-full w-full object-cover"
                  />
                )}
                <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                  #{index + 1}
                </span>
              </div>
              <p className="sensitive mt-1.5 truncate text-xs font-medium group-hover:underline">{row.name}</p>
              <p className="text-[11px] font-medium tabular-nums text-foreground/90">{formatBytes(row.bytes)}</p>
              <p className="truncate text-[11px] tabular-nums text-muted-foreground">{videoCountLabel(row.videos)}</p>
            </Link>
          );
        })}
      </div>
      {rest && (
        <p className="text-xs text-muted-foreground">
          Everyone else: {formatBytes(rest.bytes)} across {videoCountLabel(rest.videos)}.
        </p>
      )}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ */

/** Rows shown before "Show more". Enough to see the pattern, few enough to scan. */
const LARGEST_SHOWN = 8;
/** How far a file's bitrate must sit above the list's median to be called out. */
const HIGH_BITRATE_FACTOR = 1.25;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The biggest files, as a ranked list.
 *
 * A list rather than a grid of posters: twelve full-size pictures each
 * carrying a badge made the section the loudest thing on the page, and the
 * thing being compared here is size, which a bar shows better than a picture.
 *
 * Quality and bitrate are only printed where they differ from the rest. When
 * every file is 1080p at the same bitrate, saying so on each row is twelve
 * copies of one fact; saying it once underneath is the actual finding.
 */
function LargestVideos({ rows: all }: { rows: Insights["largest"] }) {
  const [expanded, setExpanded] = useState(false);
  if (all.length === 0) return null;
  const rows = expanded ? all : all.slice(0, LARGEST_SHOWN);
  const max = all[0].bytes || 1;

  const bitrates = all.flatMap((row) => (row.bitrateMbps !== null ? [row.bitrateMbps] : []));
  const typicalBitrate = median(bitrates);
  const uniformBitrate =
    typicalBitrate !== null &&
    bitrates.length === all.length &&
    bitrates.every((rate) => Math.abs(rate - typicalBitrate) / typicalBitrate < 0.05);
  const heights = all.map((row) => heightLabel(row.height));
  const typicalHeight = heights.sort(
    (a, b) => heights.filter((h) => h === b).length - heights.filter((h) => h === a).length,
  )[0];

  return (
    <SettingsSection title="Largest videos" description="The files taking the most room.">
      <ol className="space-y-1">
        {rows.map((row, index) => {
          const quality = heightLabel(row.height);
          const highBitrate =
            !uniformBitrate &&
            typicalBitrate !== null &&
            row.bitrateMbps !== null &&
            row.bitrateMbps > typicalBitrate * HIGH_BITRATE_FACTOR;
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => openDetails(row.id)}
                className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent sm:gap-3 sm:px-2"
              >
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:w-5">
                  {index + 1}
                </span>
                <span className="aspect-video w-14 shrink-0 overflow-hidden rounded bg-secondary sm:w-20">
                  <img
                    src={thumbnailUrl(row)}
                    alt=""
                    loading="lazy"
                    style={framingStyle(row)}
                    className="h-full w-full object-cover"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="sensitive block truncate text-sm group-hover:underline">{row.title}</span>
                  <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <span className="sensitive truncate">
                      {[row.studio, formatDuration(row.durationSeconds)].filter(Boolean).join(" · ")}
                    </span>
                    {quality !== typicalHeight && (
                      <span className="shrink-0 rounded border border-border px-1 text-[10px]">{quality}</span>
                    )}
                    {highBitrate && (
                      <span className="shrink-0 rounded border border-border px-1 text-[10px]">
                        {row.bitrateMbps} Mb/s
                      </span>
                    )}
                  </span>
                </span>
                <span className="w-16 shrink-0 space-y-1 text-right sm:w-32">
                  <span className="block text-sm font-medium tabular-nums">{formatBytes(row.bytes)}</span>
                  <span className="block h-1 rounded-full bg-secondary">
                    <span
                      className="ml-auto block h-full rounded-full bg-foreground/50"
                      style={{ width: `${(row.bytes / max) * 100}%` }}
                    />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {uniformBitrate && typicalBitrate !== null
            ? `All ${typicalHeight} at about ${typicalBitrate} Mb/s, so size here simply follows length.`
            : typicalBitrate !== null
              ? `Typical bitrate ${typicalBitrate} Mb/s — anything flagged is encoded well above that, and is where re-encoding would save the most.`
              : null}
        </p>
        {all.length > LARGEST_SHOWN && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="rounded-md px-2 py-1 font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            {expanded ? "Show fewer" : `Show all ${all.length}`}
          </button>
        )}
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Space by release year, as columns.
 *
 * Every year between the first and the last gets a column, empty or not, so
 * a gap reads as a gap rather than the axis quietly skipping it. Hovering a
 * column puts its figures in the line above; year labels thin out when there
 * are too many to fit.
 */
function ByYear({ data }: { data: Insights["byYear"] }) {
  const [active, setActive] = useState<number | null>(null);
  if (data.years.length === 0) return null;

  const first = data.years[0].year;
  const last = data.years[data.years.length - 1].year;
  const byYear = new Map(data.years.map((row) => [row.year, row]));
  const columns = Array.from({ length: last - first + 1 }, (_, i) => {
    const year = first + i;
    return byYear.get(year) ?? { year, items: 0, bytes: 0 };
  });
  const max = Math.max(...columns.map((column) => column.bytes), 1);
  const labelEvery = columns.length > 16 ? 5 : columns.length > 8 ? 2 : 1;
  const peak = columns.reduce((best, column) => (column.bytes > best.bytes ? column : best), columns[0]);
  const shown = active !== null ? columns.find((column) => column.year === active) : null;

  return (
    <SettingsSection title="Through the years" description="Space by the year each scene was released.">
      <p className="h-4 text-xs tabular-nums text-muted-foreground">
        {shown ? (
          <>
            <span className="font-medium text-foreground">{shown.year}</span> · {formatBytes(shown.bytes)} ·{" "}
            {shown.items} video{shown.items === 1 ? "" : "s"}
          </>
        ) : (
          <>
            Peak: <span className="font-medium text-foreground">{peak.year}</span>, {formatBytes(peak.bytes)} across{" "}
            {peak.items} video{peak.items === 1 ? "" : "s"}
          </>
        )}
      </p>
      <div>
        <div className="flex h-40 items-end gap-1" onMouseLeave={() => setActive(null)}>
          {columns.map((column) => (
            <div
              key={column.year}
              onMouseEnter={() => setActive(column.year)}
              // The hit area is the column's full height, not only the bar,
              // so a quiet year is as easy to point at as a busy one.
              className="flex h-full min-w-0 flex-1 cursor-default items-end"
            >
              <div
                className="w-full rounded-t-[4px] transition-opacity duration-150"
                style={{
                  height: column.bytes > 0 ? `max(3px, ${(column.bytes / max) * 100}%)` : 0,
                  background: CHART_COLORS[0],
                  opacity: active === null || active === column.year ? 1 : 0.4,
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex gap-1 border-t border-border pt-1.5">
          {columns.map((column, index) => (
            <span
              key={column.year}
              className="min-w-0 flex-1 text-center text-[10px] tabular-nums text-muted-foreground"
            >
              {index % labelEvery === 0 || index === columns.length - 1 ? `'${String(column.year).slice(2)}` : ""}
            </span>
          ))}
        </div>
      </div>
      {data.undated.items > 0 && (
        <p className="text-xs text-muted-foreground">
          Not shown: {data.undated.items} video{data.undated.items === 1 ? "" : "s"} with no release date (
          {formatBytes(data.undated.bytes)}).
        </p>
      )}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------ */

/** Fixed per band, not per rank, so Full HD is the same colour whatever else is present. */
const BAND_COLORS: Record<string, string> = {
  "4k": CHART_COLORS[0],
  fullhd: CHART_COLORS[1],
  hd: CHART_COLORS[2],
  sd: CHART_COLORS[3],
  unknown: REST_COLOR,
};

function Quality({
  rows,
  copies,
}: {
  rows: Insights["byResolution"];
  copies: Insights["lowerQualityCopies"];
}) {
  const present = rows.filter((row) => row.items > 0);
  const total = present.reduce((sum, row) => sum + row.items, 0) || 1;
  const reclaimable = copies.reduce((sum, group) => sum + group.reclaimableBytes, 0);

  return (
    <SettingsSection title="Quality" description="Videos by resolution, and scenes you may be keeping twice.">
      {present.length > 0 && (
        <div className="space-y-3">
          <div className="flex h-9 w-full gap-0.5 overflow-hidden rounded-lg">
            {present.map((row) => {
              const share = (row.items / total) * 100;
              return (
                <div
                  key={row.key}
                  title={`${row.name}: ${row.items} videos, ${formatBytes(row.bytes)}`}
                  style={{ width: `${share}%`, background: BAND_COLORS[row.key], minWidth: 6 }}
                  className="flex items-center justify-center overflow-hidden whitespace-nowrap px-2 text-[11px] font-semibold text-white"
                >
                  {share >= 10 && `${row.name} · ${Math.round(share)}%`}
                </div>
              );
            })}
          </div>
          <ul className="flex flex-wrap gap-2">
            {rows.map((row) => (
              <li
                key={row.key}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs",
                  row.items === 0 && "opacity-45",
                )}
              >
                <span aria-hidden className="size-2 rounded-full" style={{ background: BAND_COLORS[row.key] }} />
                <span>{row.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {row.items} · {formatBytes(row.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2.5 border-t border-border pt-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CopyIcon className="size-4 text-muted-foreground" /> Possible lower-quality copies
        </h3>
        <p className="text-xs text-muted-foreground">
          {copies.length === 0
            ? "None found — no studio has the same release date at two resolutions. Nothing to clean up here."
            : `Same studio, same release date, different resolution — probably one scene kept twice. Removing the lesser copies would free about ${formatBytes(reclaimable)}. Check before deleting: two scenes can share a date.`}
        </p>
        {copies.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {copies.map((group) => (
              <li key={`${group.studio}-${group.releaseDate}`} className="rounded-lg border border-border p-3">
                <p className="sensitive text-xs text-muted-foreground">
                  {group.studio} ·{" "}
                  {new Date(group.releaseDate).toLocaleDateString(undefined, { timeZone: "UTC" })} ·{" "}
                  <span className="text-foreground">{formatBytes(group.reclaimableBytes)}</span> to reclaim
                </p>
                <ul className="mt-2 flex gap-2">
                  {group.items.map((item, index) => (
                    <li key={item.id} className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => openDetails(item.id)}
                        className="group block w-full text-left"
                      >
                        <div className="relative aspect-video overflow-hidden rounded bg-secondary">
                          <img src={thumbnailUrl(item)} alt="" loading="lazy" className="h-full w-full object-cover" />
                          <span
                            className={cn(
                              "absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                              index === 0 ? "bg-white text-black" : "bg-black/75 text-white",
                            )}
                          >
                            {index === 0 ? `Keep · ${heightLabel(item.height)}` : heightLabel(item.height)}
                          </span>
                        </div>
                        <p className="sensitive mt-1 truncate text-[11px] group-hover:underline">{item.title}</p>
                        <p className="text-[11px] tabular-nums text-muted-foreground">{formatBytes(item.bytes)}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
