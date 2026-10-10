import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/PerformerEditor", () => ({ PerformerEditor: () => <input aria-label="Add performer" /> }));
vi.mock("@/components/TagEditor", () => ({ TagEditor: () => <input aria-label="Add tag" /> }));
vi.mock("@/components/StarRating", () => ({ StarRating: () => <div aria-label="Rating" /> }));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function item(id: number, title: string) {
  return { id, title, thumbnailFile: null, thumbnailPositionX: 50, thumbnailPositionY: 50,
    thumbnailScale: 100, durationSeconds: 120, releaseDate: "2026-10-10", itemType: "video",
    studioId: null, studioName: null, rating: null, isFavorite: false, performers: [], tags: [] };
}

function renderInbox({ hasMore = false, failTriage = false } = {}) {
  let items = [item(1, "First video"), item(2, "Second video")];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/inbox/triage") {
      if (failTriage) return new Response("", { status: 500 });
      const { ids } = JSON.parse(options?.body as string) as { ids: number[] };
      items = items.filter((entry) => !ids.includes(entry.id));
      return Response.json({ ok: true });
    }
    if (url === "/api/inbox/count") return Response.json({ count: items.length });
    if (url === "/api/inbox?page=2") return Response.json({ items: [item(3, "Third video")], page: 2, pageSize: 50, hasMore: false });
    return Response.json({ items, page: 1, pageSize: 50, hasMore });
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><InboxPage /></QueryClientProvider>);
  return fetchMock;
}

describe("inbox review workspace", () => {
  it("shows generated thumbnails without an uploaded override", async () => {
    renderInbox();
    expect(await screen.findByRole("img", { name: "First video" })).toHaveAttribute("src", expect.stringContaining("/api/media-items/1/thumbnail?v=auto"));
    expect(screen.getByRole("complementary", { name: "Review queue" })).toBeInTheDocument();
  });

  it("skips to the next item without marking anything done", async () => {
    const fetchMock = renderInbox();
    await screen.findByRole("heading", { name: "First video" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByRole("heading", { name: "Second video" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/inbox/triage")).toBe(false);
  });

  it("removes a reviewed item and selects the next item", async () => {
    const fetchMock = renderInbox();
    await screen.findByRole("heading", { name: "First video" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Mark done" }));
    await screen.findByRole("heading", { name: "Second video" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inbox/triage", expect.objectContaining({ body: JSON.stringify({ ids: [1] }) }));
    expect(within(screen.getByRole("complementary", { name: "Review queue" })).queryByText("First video")).not.toBeInTheDocument();
  });

  it("keeps the current item and shows an error when triage fails", async () => {
    renderInbox({ failTriage: true });
    await screen.findByRole("heading", { name: "First video" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Mark done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to triage");
    expect(screen.getByRole("heading", { name: "First video" })).toBeInTheDocument();
  });

  it("does not triage when Enter is used inside an editor", async () => {
    const fetchMock = renderInbox();
    await screen.findByRole("heading", { name: "First video" });
    await userEvent.setup().type(screen.getByRole("textbox", { name: "Add tag" }), "Travel{Enter}");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/inbox/triage")).toBe(false);
  });

  it("loads the next queue page", async () => {
    const fetchMock = renderInbox({ hasMore: true });
    await screen.findByRole("heading", { name: "First video" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Next queue page" }));
    await screen.findByRole("heading", { name: "Third video" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inbox?page=2");
  });

  it("does not mark all done when confirmation is cancelled", async () => {
    const fetchMock = renderInbox();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await screen.findByRole("heading", { name: "First video" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Mark all done" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/inbox/triage-all")).toBe(false));
  });
});