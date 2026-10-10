export const LIBRARY_MAP_KINDS = [
  "performer",
  "studio",
  "tag",
  "album",
  "series",
] as const;

export type LibraryMapKind = (typeof LIBRARY_MAP_KINDS)[number];

export type LibraryMapAssociation = {
  mediaItemId: number;
  kind: LibraryMapKind;
  entityId: number;
  name: string;
};

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

const MAX_PER_KIND = 14;
const MAX_VISIBLE_NODES = 70;
const MAX_SEARCH_MATCHES = 24;
const MAX_NEIGHBORS_PER_MATCH = 6;

function entityKey(kind: LibraryMapKind, id: number): string {
  return `${kind}:${id}`;
}

function compareNodes(a: LibraryMapNode, b: LibraryMapNode): number {
  return b.itemCount - a.itemCount || a.name.localeCompare(b.name);
}

/**
 * Builds entity-to-entity links from the media items they share.
 *
 * One item contributes at most one count to an entity or edge, even if a
 * future query returns duplicate associations. The default graph stays small
 * enough for the browser force layout; searching a less-connected entity
 * brings it and its strongest neighbors into view.
 */
export function buildLibraryMap(
  associations: LibraryMapAssociation[],
  query = "",
): LibraryMap {
  const entities = new Map<
    string,
    LibraryMapNode & { mediaItemIds: Set<number> }
  >();
  const itemEntities = new Map<number, Set<string>>();

  for (const association of associations) {
    const key = entityKey(association.kind, association.entityId);
    const entity = entities.get(key) ?? {
      key,
      kind: association.kind,
      id: association.entityId,
      name: association.name,
      itemCount: 0,
      mediaItemIds: new Set<number>(),
    };
    entity.mediaItemIds.add(association.mediaItemId);
    entities.set(key, entity);

    const item = itemEntities.get(association.mediaItemId) ?? new Set<string>();
    item.add(key);
    itemEntities.set(association.mediaItemId, item);
  }

  for (const entity of entities.values()) {
    entity.itemCount = entity.mediaItemIds.size;
  }

  const allNodes = [...entities.values()].map(({ mediaItemIds: _, ...node }) => node);
  const edgeCounts = new Map<string, LibraryMapEdge>();
  for (const keys of itemEntities.values()) {
    const ordered = [...keys].sort();
    for (let left = 0; left < ordered.length; left++) {
      for (let right = left + 1; right < ordered.length; right++) {
        const source = ordered[left];
        const target = ordered[right];
        const edgeKey = `${source}\0${target}`;
        const edge = edgeCounts.get(edgeKey) ?? { source, target, sharedItems: 0 };
        edge.sharedItems += 1;
        edgeCounts.set(edgeKey, edge);
      }
    }
  }
  const allEdges = [...edgeCounts.values()];

  const normalizedQuery = query.trim().toLocaleLowerCase();
  let selectedKeys: Set<string>;
  if (normalizedQuery) {
    const matches = allNodes
      .filter((node) => node.name.toLocaleLowerCase().includes(normalizedQuery))
      .sort(compareNodes)
      .slice(0, MAX_SEARCH_MATCHES);
    selectedKeys = new Set(matches.map((node) => node.key));

    for (const match of matches) {
      allEdges
        .filter((edge) => edge.source === match.key || edge.target === match.key)
        .sort((a, b) => b.sharedItems - a.sharedItems)
        .slice(0, MAX_NEIGHBORS_PER_MATCH)
        .forEach((edge) => {
          selectedKeys.add(edge.source);
          selectedKeys.add(edge.target);
        });
    }
  } else {
    selectedKeys = new Set(
      LIBRARY_MAP_KINDS.flatMap((kind) =>
        allNodes
          .filter((node) => node.kind === kind)
          .sort(compareNodes)
          .slice(0, MAX_PER_KIND),
      )
        .sort(compareNodes)
        .slice(0, MAX_VISIBLE_NODES)
        .map((node) => node.key),
    );
  }

  const nodes = allNodes.filter((node) => selectedKeys.has(node.key)).sort(compareNodes);
  const edges = allEdges
    .filter((edge) => selectedKeys.has(edge.source) && selectedKeys.has(edge.target))
    .sort((a, b) => b.sharedItems - a.sharedItems);

  return {
    nodes,
    edges,
    totalNodes: allNodes.length,
    truncated: nodes.length < allNodes.length,
  };
}