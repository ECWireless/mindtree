import type { TreeNode } from "./tree";

export const CONSTELLATION_ROOT_RADIUS = 40;
export const CONSTELLATION_MIN_VISUAL_RADIUS = 6;
export const CONSTELLATION_DEPTH_SCALE = 0.75;
export const CONSTELLATION_INTERACTION_RADIUS = 22;
export const CONSTELLATION_MIN_SCALE = 0.15;
export const CONSTELLATION_MAX_SCALE = 12;
export const CONSTELLATION_COMFORTABLE_INTERACTION_SCALE = 0.5;
export const CONSTELLATION_MIN_FOCUS_SCREEN_RADIUS = 12;

export type ConstellationViewTransform = {
  x: number;
  y: number;
  scale: number;
};

export function constellationRadiusForDepth(depth: number) {
  return Math.max(
    CONSTELLATION_MIN_VISUAL_RADIUS,
    Math.round(CONSTELLATION_ROOT_RADIUS * CONSTELLATION_DEPTH_SCALE ** Math.max(0, depth)),
  );
}

export function constellationInteractionRadiusForScale(scale: number) {
  return CONSTELLATION_INTERACTION_RADIUS / Math.max(scale, CONSTELLATION_MIN_SCALE);
}

export function constellationCollisionRadiusForDepth(depth: number) {
  return Math.max(
    CONSTELLATION_INTERACTION_RADIUS / CONSTELLATION_COMFORTABLE_INTERACTION_SCALE,
    constellationRadiusForDepth(depth) + 12,
  );
}

export function constellationFocusRingRadius(radius: number, scale: number) {
  return Math.max(radius * 1.16, CONSTELLATION_MIN_FOCUS_SCREEN_RADIUS / scale);
}

export function constellationWheelScaleFactor(
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
) {
  const deltaInPixels =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  const clampedDelta = Math.min(Math.max(deltaInPixels, -120), 120);
  return Math.exp(-clampedDelta * 0.002);
}

export function zoomConstellationTransform(
  current: ConstellationViewTransform,
  factor: number,
  anchorX: number,
  anchorY: number,
): ConstellationViewTransform {
  const scale = Math.min(
    Math.max(current.scale * factor, CONSTELLATION_MIN_SCALE),
    CONSTELLATION_MAX_SCALE,
  );
  const worldX = (anchorX - current.x) / current.scale;
  const worldY = (anchorY - current.y) / current.scale;
  return {
    x: anchorX - worldX * scale,
    y: anchorY - worldY * scale,
    scale,
  };
}

export function nearestConstellationNodeAtPoint<
  Node extends { x?: number; y?: number },
>(
  nodes: readonly Node[],
  transform: ConstellationViewTransform,
  point: { x: number; y: number },
  maximumDistance: number,
) {
  let nearest: Node | null = null;
  let nearestDistanceSquared = maximumDistance ** 2;
  for (const node of nodes) {
    const x = (node.x ?? 0) * transform.scale + transform.x;
    const y = (node.y ?? 0) * transform.scale + transform.y;
    const distanceSquared = (x - point.x) ** 2 + (y - point.y) ** 2;
    if (distanceSquared <= nearestDistanceSquared) {
      nearest = node;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
}

export type ConstellationLink = {
  sourceId: string;
  targetId: string;
};

export type ConstellationGraph = {
  links: ConstellationLink[];
  nodes: TreeNode[];
};

export type ConstellationSynthesisState = "none" | "current" | "review-suggested";

export function constellationSynthesisState(
  node: Pick<TreeNode, "publishedSynthesisVersionId" | "synthesisStaleAt">,
): ConstellationSynthesisState {
  if (node.publishedSynthesisVersionId === null) {
    return "none";
  }
  return node.synthesisStaleAt === null ? "current" : "review-suggested";
}

export function constellationSynthesisLabel(
  node: Pick<TreeNode, "publishedSynthesisVersionId" | "synthesisStaleAt">,
) {
  switch (constellationSynthesisState(node)) {
    case "current":
      return "Summary published";
    case "review-suggested":
      return "Summary published · review suggested";
    case "none":
      return "No published Summary";
  }
}

export function staticConstellationPosition(
  index: number,
  width: number,
  height: number,
  radius = CONSTELLATION_ROOT_RADIUS,
) {
  if (index === 0) {
    return { x: width / 2, y: height / 2 };
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spacing = radius * 2 + 28;
  const orbit = spacing * Math.sqrt(index);
  return {
    x: width / 2 + Math.cos(index * goldenAngle) * orbit,
    y: height / 2 + Math.sin(index * goldenAngle) * orbit,
  };
}

export function buildConstellationGraph(
  orderedNodes: readonly TreeNode[],
  includeArchived: boolean,
): ConstellationGraph {
  const nodes = includeArchived
    ? [...orderedNodes]
    : orderedNodes.filter((node) => node.archivedAt === null);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const links = nodes.flatMap((node) =>
    node.parentId !== null && visibleIds.has(node.parentId)
      ? [{ sourceId: node.parentId, targetId: node.id }]
      : [],
  );

  return { links, nodes };
}
