import { describe, expect, it } from "vitest";

import {
  buildConstellationGraph,
  constellationCollisionRadiusForDepth,
  constellationFocusRingRadius,
  constellationInteractionRadiusForScale,
  constellationWheelScaleFactor,
  CONSTELLATION_COMFORTABLE_INTERACTION_SCALE,
  CONSTELLATION_DEPTH_SCALE,
  CONSTELLATION_INTERACTION_RADIUS,
  CONSTELLATION_MAX_SCALE,
  CONSTELLATION_MIN_FOCUS_SCREEN_RADIUS,
  CONSTELLATION_MIN_SCALE,
  CONSTELLATION_MIN_VISUAL_RADIUS,
  CONSTELLATION_ROOT_RADIUS,
  constellationRadiusForDepth,
  constellationSynthesisLabel,
  constellationSynthesisState,
  nearestConstellationNodeAtPoint,
  staticConstellationPosition,
  zoomConstellationTransform,
} from "../../src/lib/nodes/constellation";
import { assembleNodeTree, type FlatNode } from "../../src/lib/nodes/tree";

function node(
  id: string,
  parentId: string | null,
  position: number,
  overrides: Partial<FlatNode> = {},
): FlatNode {
  return {
    id,
    parentId,
    position,
    title: id,
    archivedAt: null,
    publishedSynthesisVersionId: null,
    synthesisStaleAt: null,
    ...overrides,
  };
}

describe("node constellation", () => {
  it("dramatically scales visual bubbles while retaining a separate touch target", () => {
    expect(constellationRadiusForDepth(0)).toBe(CONSTELLATION_ROOT_RADIUS);
    expect(CONSTELLATION_DEPTH_SCALE).toBe(0.75);
    expect(constellationRadiusForDepth(1)).toBe(30);
    expect(constellationRadiusForDepth(2)).toBe(23);
    expect(constellationRadiusForDepth(3)).toBe(17);
    expect(constellationRadiusForDepth(4)).toBe(13);
    expect(constellationRadiusForDepth(5)).toBe(9);
    expect(constellationRadiusForDepth(6)).toBe(7);
    expect(constellationRadiusForDepth(7)).toBe(CONSTELLATION_MIN_VISUAL_RADIUS);
    expect(constellationRadiusForDepth(100)).toBe(CONSTELLATION_MIN_VISUAL_RADIUS);
    expect(CONSTELLATION_INTERACTION_RADIUS * 2).toBe(44);
    expect(CONSTELLATION_MIN_SCALE).toBe(0.15);
    expect(CONSTELLATION_MAX_SCALE).toBe(12);
    expect(
      constellationInteractionRadiusForScale(CONSTELLATION_MIN_SCALE) *
        CONSTELLATION_MIN_SCALE *
        2,
    ).toBeCloseTo(44);
    expect(constellationInteractionRadiusForScale(2) * 2 * 2).toBe(44);
    expect(
      constellationCollisionRadiusForDepth(100) *
        CONSTELLATION_COMFORTABLE_INTERACTION_SCALE *
        2,
    ).toBe(44);
  });

  it("provides an immediate deterministic reduced-motion layout", () => {
    expect(staticConstellationPosition(0, 800, 600)).toEqual({ x: 400, y: 300 });
    expect(staticConstellationPosition(4, 800, 600)).toEqual(
      staticConstellationPosition(4, 800, 600),
    );
    expect(staticConstellationPosition(4, 800, 600)).not.toEqual(
      staticConstellationPosition(5, 800, 600),
    );
  });

  it("keeps cursor-anchored camera zoom stable across the full range", () => {
    const zoomed = zoomConstellationTransform(
      { x: 10, y: 20, scale: 1 },
      2,
      110,
      120,
    );
    expect(zoomed).toEqual({ x: -90, y: -80, scale: 2 });
    expect(100 * zoomed.scale + zoomed.x).toBe(110);
    expect(100 * zoomed.scale + zoomed.y).toBe(120);
    expect(
      zoomConstellationTransform(zoomed, 1_000, 110, 120).scale,
    ).toBe(CONSTELLATION_MAX_SCALE);
    expect(
      zoomConstellationTransform(zoomed, 0.000_01, 110, 120).scale,
    ).toBe(CONSTELLATION_MIN_SCALE);
  });

  it("normalizes wheel modes and resolves overlapping overview targets by distance", () => {
    const pixelFactor = constellationWheelScaleFactor(48, 0, 800);
    expect(constellationWheelScaleFactor(3, 1, 800)).toBeCloseTo(pixelFactor);
    expect(constellationWheelScaleFactor(1, 2, 48)).toBeCloseTo(pixelFactor);

    const nodes = [
      { id: "farther", x: 0, y: 0 },
      { id: "nearest", x: 10, y: 0 },
    ];
    expect(
      nearestConstellationNodeAtPoint(
        nodes,
        { x: 0, y: 0, scale: CONSTELLATION_MIN_SCALE },
        { x: 1.4, y: 0 },
        CONSTELLATION_INTERACTION_RADIUS,
      )?.id,
    ).toBe("nearest");
    expect(
      nearestConstellationNodeAtPoint(
        nodes,
        { x: 0, y: 0, scale: 1 },
        { x: 100, y: 100 },
        CONSTELLATION_INTERACTION_RADIUS,
      ),
    ).toBeNull();
  });

  it("keeps the focus locator visible while node art remains world-scaled", () => {
    expect(
      constellationFocusRingRadius(
        CONSTELLATION_MIN_VISUAL_RADIUS,
        CONSTELLATION_MIN_SCALE,
      ) * CONSTELLATION_MIN_SCALE,
    ).toBe(CONSTELLATION_MIN_FOCUS_SCREEN_RADIUS);
    expect(
      constellationFocusRingRadius(CONSTELLATION_ROOT_RADIUS, 1),
    ).toBeCloseTo(CONSTELLATION_ROOT_RADIUS * 1.16);
  });

  it("matches tree archive visibility and retains only visible parent links", () => {
    const tree = assembleNodeTree([
      node("root", null, 0),
      node("active", "root", 0),
      node("archived", "root", 1, {
        archivedAt: "2026-08-16T00:00:00.000Z",
      }),
      node("archived-child", "archived", 0, {
        archivedAt: "2026-08-16T00:00:00.000Z",
      }),
    ]);

    const activeGraph = buildConstellationGraph(tree.ordered, false);
    expect(activeGraph.nodes.map(({ id }) => id)).toEqual(["root", "active"]);
    expect(activeGraph.links).toEqual([{ sourceId: "root", targetId: "active" }]);

    const completeGraph = buildConstellationGraph(tree.ordered, true);
    expect(completeGraph.nodes.map(({ id }) => id)).toEqual([
      "root",
      "active",
      "archived",
      "archived-child",
    ]);
    expect(completeGraph.links).toEqual([
      { sourceId: "root", targetId: "active" },
      { sourceId: "root", targetId: "archived" },
      { sourceId: "archived", targetId: "archived-child" },
    ]);
  });

  it("keeps synthesis state as quiet inspection text rather than graph styling", () => {
    const unpublished = node("unpublished", null, 0);
    const current = node("current", null, 0, {
      publishedSynthesisVersionId: "11111111-1111-4111-8111-111111111111",
    });
    const reviewSuggested = node("review", null, 0, {
      publishedSynthesisVersionId: "22222222-2222-4222-8222-222222222222",
      synthesisStaleAt: "2026-08-16T00:00:00.000Z",
    });

    expect(constellationSynthesisState(unpublished)).toBe("none");
    expect(constellationSynthesisLabel(unpublished)).toBe("No published Summary");
    expect(constellationSynthesisState(current)).toBe("current");
    expect(constellationSynthesisLabel(current)).toBe("Summary published");
    expect(constellationSynthesisState(reviewSuggested)).toBe("review-suggested");
    expect(constellationSynthesisLabel(reviewSuggested)).toBe(
      "Summary published · review suggested",
    );
  });
});
