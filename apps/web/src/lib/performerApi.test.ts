import { describe, expect, it } from "vitest";
import {
  circleFraming,
  circleStyle,
  performerImageUrl,
  performerPortraitUrl,
  portraitStyle,
  studioNodeId,
  togetherLabel,
  unit,
  withStudioCircles,
  type NetworkNode,
  type PerformerNetwork,
} from "./performerApi.js";

const base = { id: 3, hasImage: false, hasBanner: false, representativeItemId: null };

describe("performerPortraitUrl", () => {
  it("prefers an uploaded photo", () => {
    expect(performerPortraitUrl({ ...base, hasImage: true })).toBe(
      "/api/performers/3/image?kind=avatar"
    );
  });

  it("falls back to a frame from one of their videos", () => {
    expect(performerPortraitUrl({ ...base, representativeItemId: 42 })).toBe(
      "/api/media-items/42/thumbnail"
    );
  });

  it("returns null when there is nothing to show", () => {
    // The caller renders an initial instead of a broken image.
    expect(performerPortraitUrl(base)).toBeNull();
  });
});

describe("performerImageUrl", () => {
  it("returns null for a kind that was never uploaded", () => {
    expect(performerImageUrl(base, "banner")).toBeNull();
    expect(performerImageUrl({ ...base, hasBanner: true }, "banner")).toContain("kind=banner");
  });
});

describe("portraitStyle", () => {
  it("defaults to top-aligned, where faces usually are", () => {
    expect(portraitStyle({}).objectPosition).toBe("50% 0%");
  });

  it("omits the transform entirely at zoom 100", () => {
    expect(portraitStyle({}).transform).toBeUndefined();
  });

  it("emits a scale once zoomed", () => {
    expect(portraitStyle({ imageScale: 150 }).transform).toBe("scale(1.5)");
  });

  it("anchors the zoom to the chosen position", () => {
    const style = portraitStyle({ imagePositionX: 20, imagePositionY: 80, imageScale: 120 });
    expect(style.objectPosition).toBe("20% 80%");
    expect(style.transformOrigin).toBe("20% 80%");
  });
});

describe("circleFraming", () => {
  const tile = { imagePositionX: 10, imagePositionY: 20, imageScale: 130 };

  it("falls back to the tile framing when no circle framing is set", () => {
    expect(circleFraming(tile)).toEqual(tile);
    expect(circleFraming({ ...tile, avatarPositionX: 40, avatarPositionY: null })).toMatchObject(tile);
  });

  it("uses the circle's own framing once both coordinates are set", () => {
    expect(circleFraming({ ...tile, avatarPositionX: 60, avatarPositionY: 70, avatarScale: 200 })).toEqual({
      imagePositionX: 60,
      imagePositionY: 70,
      imageScale: 200,
    });
  });

  it("treats a missing circle zoom as no zoom", () => {
    expect(circleFraming({ ...tile, avatarPositionX: 60, avatarPositionY: 70 }).imageScale).toBe(100);
  });

  it("feeds circleStyle, so round crops render the circle framing", () => {
    expect(circleStyle({ ...tile, avatarPositionX: 60, avatarPositionY: 70 }).objectPosition).toBe("60% 70%");
  });
});

describe("withStudioCircles", () => {
  const performer: NetworkNode = {
    id: 1,
    name: "Ann",
    hasImage: false,
    hasBanner: false,
    isFavorite: false,
    videoCount: 3,
    representativeItemId: null,
    imagePositionX: 50,
    imagePositionY: 0,
    imageScale: 100,
    topStudio: "Harbor",
  } as NetworkNode;
  const network: PerformerNetwork = {
    by: "studios",
    nodes: [performer],
    edges: [{ source: 1, target: 2, together: 1 }],
    studios: [{ id: 7, name: "Harbor", videoCount: 5 }],
    memberships: [{ performerId: 1, studioId: 7, videos: 3 }],
  };

  it("adds each studio as a circle under a negated id", () => {
    const result = withStudioCircles(network);
    const studio = result.nodes.find((node) => node.kind === "studio");
    expect(studio).toMatchObject({ id: studioNodeId(7), studioId: 7, name: "Harbor", topStudio: "Harbor", videoCount: 5 });
    expect(studioNodeId(7)).toBe(-7);
    expect(result.nodes).toContain(performer);
  });

  it("replaces performer-to-performer lines with performer-to-studio ones", () => {
    expect(withStudioCircles(network).edges).toEqual([{ source: 1, target: -7, together: 3 }]);
  });

  it("copes with a network that has no studios", () => {
    const bare = withStudioCircles({ by: "videos", nodes: [performer], edges: [] });
    expect(bare.nodes).toEqual([performer]);
    expect(bare.edges).toEqual([]);
  });
});

describe("network labels", () => {
  it("pluralises by count", () => {
    expect(unit("videos", 1)).toBe("1 video");
    expect(unit("videos", 3)).toBe("3 videos");
    expect(unit("studios", 1)).toBe("1 studio");
  });

  it("describes what links a pair in each mode", () => {
    expect(togetherLabel("videos", 2)).toBe("2 videos together");
    expect(togetherLabel("studios", 1)).toBe("1 studio in common");
  });
});
