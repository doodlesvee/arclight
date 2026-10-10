export type LibraryMapKind = "performer" | "studio" | "tag" | "album" | "series";

export type LibraryMapNode = {
  key: string;
  kind: LibraryMapKind;
  id: number;
  name: string;
  itemCount: number;
};

export type LibraryMapEdge = {
  source: string;
  target: string;
  sharedItems: number;
};

export type LibraryMap = {
  nodes: LibraryMapNode[];
  edges: LibraryMapEdge[];
  totalNodes: number;
  truncated: boolean;
};

export async function fetchLibraryMap(query: string): Promise<LibraryMap> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const suffix = params.size > 0 ? `?${params}` : "";
  const response = await fetch(`/api/library/map${suffix}`);
  if (!response.ok) throw new Error(`Failed to load library map: ${response.status}`);
  return response.json();
}