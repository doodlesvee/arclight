import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeThumbnailCollage } from "./HomeThumbnailCollage";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCollage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <HomeThumbnailCollage />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

function videos(ids: number[]) {
  return { items: ids.map((id) => ({ id, itemType: "video", title: `Video ${id}` })) };
}

describe("HomeThumbnailCollage", () => {
  it("uses equal-height portrait and landscape tiles while preserving framing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: 1, tileShape: "portrait", thumbnailScale: 125, thumbnailPositionX: 40 },
          { id: 2, tileShape: "landscape" },
        ],
      }),
    }));
    const { container, client } = renderCollage();
    await screen.findByRole("region", { name: "Video thumbnail collage" });
    expect(screen.getByRole("heading", { name: "Your collection. Your cinema." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse library" })).toHaveAttribute("href", "/browse");
    expect(screen.getByRole("link", { name: "Open favourites" })).toHaveAttribute("href", "/browse?favorite=true");
    const images = container.querySelectorAll("img");
    expect(images[0].parentElement).toHaveClass("h-full", "aspect-[2/3]");
    expect(images[0]).toHaveStyle({ transform: "scale(1.25)", objectPosition: "40% 50%" });
    expect(images[1].parentElement).toHaveClass("h-full", "aspect-[16/8.1]");
    expect(images[1]).toHaveClass("top-0", "h-[111.111111%]");
    expect(images[0]).toHaveClass("h-full");
    client.clear();
  });

  it("repeats decorative tiles to fill the section and refreshes after library invalidation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => videos([1, 2]) })
      .mockResolvedValueOnce({ ok: true, json: async () => videos([3, 1, 2]) });
    vi.stubGlobal("fetch", fetchMock);
    const { container, client } = renderCollage();
    await screen.findByRole("region", { name: "Video thumbnail collage" });
    expect(container.querySelectorAll("img").length).toBeGreaterThan(48);
    expect(fetchMock).toHaveBeenCalledWith("/api/media-items?type=video");
    expect(container.querySelector("img")?.getAttribute("src")).toContain("/1/thumbnail");
    await client.invalidateQueries({ queryKey: ["media-items"] });
    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toContain("/3/thumbnail");
    });
    expect(container.querySelectorAll("img").length).toBeGreaterThan(48);
    client.clear();
  });

  it("caps unique videos at 48 while repeating tiles to fill the background", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => videos(Array.from({ length: 50 }, (_, index) => index + 1)),
    }));
    const { container, client } = renderCollage();
    await screen.findByRole("region", { name: "Video thumbnail collage" });
    expect(new Set(Array.from(container.querySelectorAll("img"), (image) => image.src)).size).toBe(48);
    expect(container.querySelector('img[src*="/49/thumbnail"]')).toBeNull();
    client.clear();
  });

  it("does not show an empty collage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => videos([]),
    }));
    const { client } = renderCollage();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    client.clear();
  });

  it("reports fetch failures instead of showing an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { client } = renderCollage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load thumbnail collage: 500");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    client.clear();
  });
});
