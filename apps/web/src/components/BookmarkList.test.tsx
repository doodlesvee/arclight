import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookmarkList } from "./BookmarkList";

vi.mock("@/lib/useMediaQuery", () => ({ useMediaQuery: () => false }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("bookmark annotations", () => {
  it("saves a note on its timestamped bookmark", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 7,
        mediaItemId: 3,
        positionSeconds: 83,
        label: "Favorite shot",
        note: "Look at the background",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    render(
      <QueryClientProvider client={client}>
        <BookmarkList
          itemId={3}
          bookmarks={[{
            id: 7,
            mediaItemId: 3,
            positionSeconds: 83,
            label: "Favorite shot",
            note: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          }]}
          onJump={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add note at 1:23" }));
    await user.type(screen.getByPlaceholderText("Add a note about this moment…"), "Look at the background");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookmarks/7",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ note: "Look at the background" }),
      }),
    ));
    expect(screen.queryByPlaceholderText("Add a note about this moment…")).not.toBeInTheDocument();
    client.clear();
  });
});