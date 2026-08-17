import type { TreeNode } from "@/lib/nodes/tree";

export type NodeDropZone = "before" | "inside" | "after";

export type NodeDropDestination = {
  parentId: string | null;
  position: number;
  targetId: string;
  zone: NodeDropZone;
};

export type NodeDropResolver = (
  target: TreeNode,
  zone: NodeDropZone,
) => NodeDropDestination | null;

export function getNodeDropZone(
  pointerY: number,
  target: { height: number; top: number },
): NodeDropZone | null {
  if (target.height <= 0) {
    return null;
  }

  const relativePosition = (pointerY - target.top) / target.height;
  if (relativePosition < 0.25) {
    return "before";
  }
  if (relativePosition > 0.65) {
    return "after";
  }
  return "inside";
}

function includesTitle(node: TreeNode, normalizedQuery: string) {
  return node.title.toLocaleLowerCase().includes(normalizedQuery);
}

export function formatBreadcrumb(node: TreeNode) {
  return node.breadcrumb.map(({ title }) => title).join(" / ");
}

export function searchNodes(nodes: readonly TreeNode[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  return nodes.filter((node) => includesTitle(node, normalizedQuery));
}

export function getVisibleNodeRoots(
  roots: readonly TreeNode[],
  showArchived: boolean,
) {
  if (showArchived) {
    return roots;
  }

  const visibilityCheck = [...roots];
  let hasArchivedNode = false;
  while (visibilityCheck.length > 0) {
    const node = visibilityCheck.pop();
    if (!node) {
      break;
    }
    if (node.archivedAt !== null) {
      hasArchivedNode = true;
      break;
    }
    visibilityCheck.push(...node.children);
  }
  if (!hasArchivedNode) {
    return roots;
  }

  const visibleRoots: TreeNode[] = [];
  const work: Array<{ node: TreeNode; destination: TreeNode[] }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    work.push({ node: roots[index], destination: visibleRoots });
  }

  while (work.length > 0) {
    const item = work.pop();
    if (!item) {
      break;
    }
    if (item.node.archivedAt !== null) {
      continue;
    }

    const visibleNode: TreeNode = { ...item.node, children: [] };
    item.destination.push(visibleNode);
    for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
      work.push({ node: item.node.children[index], destination: visibleNode.children });
    }
  }

  return visibleRoots;
}

export function getMoveDestinations(
  nodes: readonly TreeNode[],
  source: TreeNode,
  query: string,
) {
  const blockedIds = new Set<string>();
  const work = [source];
  while (work.length > 0) {
    const node = work.pop();
    if (!node) {
      break;
    }
    blockedIds.add(node.id);
    work.push(...node.children);
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const resolveDestination = createNodeDropResolver(nodes, source);
  return nodes.filter((node) => {
    if (
      blockedIds.has(node.id) ||
      (normalizedQuery && !includesTitle(node, normalizedQuery))
    ) {
      return false;
    }
    return (["before", "inside", "after"] as const).some(
      (zone) => resolveDestination(node, zone) !== null,
    );
  });
}

export function createNodeDropResolver(
  nodes: readonly TreeNode[],
  source: TreeNode,
): NodeDropResolver {
  const blockedParentIds = new Set<string>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const archivedPathIds = new Set<string>();
  for (const node of nodes) {
    if (node.archivedAt !== null || (node.parentId !== null && archivedPathIds.has(node.parentId))) {
      archivedPathIds.add(node.id);
    }
  }
  const work = [source];
  while (work.length > 0) {
    const node = work.pop();
    if (!node) {
      break;
    }
    blockedParentIds.add(node.id);
    work.push(...node.children);
  }

  const siblingsByParent = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    if (node.id === source.id) {
      continue;
    }
    const siblings = siblingsByParent.get(node.parentId) ?? [];
    siblings.push(node);
    siblingsByParent.set(node.parentId, siblings);
  }
  const siblingIndexById = new Map<string, number>();
  for (const siblings of siblingsByParent.values()) {
    siblings.sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
    siblings.forEach((node, index) => siblingIndexById.set(node.id, index));
  }

  return (target, zone) => {
    if (source.id === target.id) {
      return null;
    }

    const parentId = zone === "inside" ? target.id : target.parentId;
    if (parentId !== null && blockedParentIds.has(parentId)) {
      return null;
    }
    if (source.archivedAt === null && parentId !== null) {
      if (!nodeById.has(parentId) || archivedPathIds.has(parentId)) {
        return null;
      }
    }

    let position = siblingsByParent.get(parentId)?.length ?? 0;
    if (zone !== "inside") {
      const targetIndex = siblingIndexById.get(target.id);
      if (targetIndex === undefined) {
        return null;
      }
      position = targetIndex + (zone === "after" ? 1 : 0);
    }

    return { parentId, position, targetId: target.id, zone };
  };
}

export function getNodeDropDestination(
  nodes: readonly TreeNode[],
  source: TreeNode,
  target: TreeNode,
  zone: NodeDropZone,
) {
  return createNodeDropResolver(nodes, source)(target, zone);
}

export function getRootEndDestination(nodes: readonly TreeNode[], source: TreeNode) {
  return {
    parentId: null,
    position: nodes.filter((node) => node.parentId === null && node.id !== source.id).length,
  };
}
