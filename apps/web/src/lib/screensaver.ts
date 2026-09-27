/** Fired by Appearance's Preview button to start the screensaver straight away. */
export const PREVIEW_SCREENSAVER = "screensaver:preview";

/** Which posters the screensaver draws from. */
export type ScreensaverSource = "all" | "favourites" | "unwatched" | "topRated";

export const SCREENSAVER_SOURCES: { value: ScreensaverSource; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "favourites", label: "Favourites" },
  { value: "unwatched", label: "Unwatched" },
  { value: "topRated", label: "Top rated" },
];
