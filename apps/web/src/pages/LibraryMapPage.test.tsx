import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryMapPage } from "./LibraryMapPage";

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div><h1>{title}</h1>{children}</div>
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Library Map", () => {
  it("shows shared-item connections and links a selected entity to its page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          {
            key: "performer:1",
            kind: "performer",
            id: 1,
            name: "Aster Vale",
            itemCount: 4,
          },
          { key: "studio:2", kind: "studio", id: 2, name: "Silver Gate", itemCount: 3 },
          { key: "tag:3", kind: "tag", id: 3, name: "Blue hour", itemCount: 1 },
        ],
        edges: [
          { source: "performer:1", target: "studio:2", sharedItems: 2 },
          { source: "performer:1", target: "tag:3", sharedItems: 1 },
          { source: "studio:2", target: "tag:3", sharedItems: 1 },
        ],
        totalNodes: 3,
        truncated: false,
      }),
    }));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    render(
      <QueryClientProvider client={client}>
        <LibraryMapPage />
      </QueryClientProvider>,
    );

    const performer = await screen.findByRole("button", {
      name: "Aster Vale, performer, 4 items",
    });
    fireEvent.click(performer);

    expect(await screen.findByRole("link", { name: "Open performer" })).toHaveAttribute(
      "href",
      "/performer/$performerId",
    );
    expect(screen.getByRole("heading", { name: "Aster Vale" })).toBeInTheDocument();
    expect(screen.getAllByText("Silver Gate")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Constellation" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Network" }));
    expect(screen.getByRole("button", { name: "Network" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Silver Gate")).toHaveLength(2);
    client.clear();
  });
});