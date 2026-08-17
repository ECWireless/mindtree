"use client";

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
  type WheelEvent,
} from "react";

import {
  buildConstellationGraph,
  constellationCollisionRadiusForDepth,
  constellationFocusRingRadius,
  constellationInteractionRadiusForScale,
  constellationWheelScaleFactor,
  CONSTELLATION_COMFORTABLE_INTERACTION_SCALE,
  CONSTELLATION_INTERACTION_RADIUS,
  CONSTELLATION_MAX_SCALE,
  CONSTELLATION_MIN_SCALE,
  CONSTELLATION_ROOT_RADIUS,
  constellationRadiusForDepth,
  constellationSynthesisLabel,
  nearestConstellationNodeAtPoint,
  staticConstellationPosition,
  zoomConstellationTransform,
  type ConstellationViewTransform,
} from "@/lib/nodes/constellation";
import { assembleNodeTree, type TreeNode } from "@/lib/nodes/tree";
import type { PublicConstellationNode } from "@/lib/sharing/contracts";

type LayoutNode = SimulationNodeDatum & {
  id: string;
  node: TreeNode;
};

type LayoutLink = SimulationLinkDatum<LayoutNode> & {
  source: string | LayoutNode;
  target: string | LayoutNode;
};

type DragState =
  | {
      kind: "canvas";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
    }
  | {
      kind: "node";
      nodeId: string;
      pointerId: number;
    };

type ActivePointer = {
  clientX: number;
  clientY: number;
};

type PinchState = {
  pointerIds: [number, number];
  startDistance: number;
  startScale: number;
  worldX: number;
  worldY: number;
};

type NodeConstellationBaseProps = {
  selectedNodeId?: string;
};

type OwnerNodeConstellationProps = NodeConstellationBaseProps & {
  variant: "owner";
  nodes: readonly TreeNode[];
  showArchived: boolean;
  onCreateRoot: () => void;
  onOpenNode: (nodeId: string) => void;
  onShowArchived: () => void;
};

type PublicNodeConstellationProps = NodeConstellationBaseProps & {
  variant: "public";
  nodes: readonly PublicConstellationNode[];
  onSelectNode: (nodeId: string) => void;
};

type NodeConstellationProps =
  | OwnerNodeConstellationProps
  | PublicNodeConstellationProps;

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

function MinusIcon() {
  return <Icon><path d="M5 12h14" /></Icon>;
}

function PlusIcon() {
  return <Icon><path d="M12 5v14M5 12h14" /></Icon>;
}

function ResetIcon() {
  return (
    <Icon>
      <path d="M4 7v5h5" />
      <path d="M5.6 16.5A8 8 0 1 0 6 7L4 9" />
    </Icon>
  );
}

function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Some mobile browsers do not support pointer capture on SVG groups.
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function labelForNode(node: TreeNode) {
  const maximum = 10;
  return node.title.length <= maximum
    ? node.title
    : `${node.title.slice(0, maximum - 1)}…`;
}

function labelFontSize(radius: number) {
  return radius * 0.18;
}

function nodeVisualStyle(radius: number) {
  return {
    "--constellation-node-stroke": `${radius * 0.04}px`,
    "--constellation-node-active-stroke": `${radius * 0.065}px`,
    "--constellation-node-dash": `${radius * 0.12}px`,
    "--constellation-node-dash-gap": `${radius * 0.08}px`,
  } as CSSProperties;
}

function breadcrumbForNode(node: TreeNode) {
  return node.breadcrumb.map(({ title }) => title).join(" / ");
}

export function NodeConstellation(props: NodeConstellationProps) {
  const { selectedNodeId } = props;
  const publicView = props.variant === "public";
  const showArchived = publicView ? false : props.showArchived;
  const nodes = useMemo<readonly TreeNode[]>(() => {
    if (props.variant === "owner") {
      return props.nodes;
    }
    return assembleNodeTree(props.nodes.map((node) => ({
      ...node,
      archivedAt: null,
      publishedSynthesisVersionId: null,
      synthesisStaleAt: null,
    }))).ordered;
  }, [props.nodes, props.variant]);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<Simulation<LayoutNode, LayoutLink> | null>(null);
  const layoutNodesRef = useRef<LayoutNode[]>([]);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const dragStateRef = useRef<DragState | null>(null);
  const activePointersRef = useRef(new Map<number, ActivePointer>());
  const pinchStateRef = useRef<PinchState | null>(null);
  const focusFirstNodeAfterRevealRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const openNodeControlRef = useRef<HTMLElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 620 });
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(
    selectedNodeId ?? null,
  );
  const [renderNodes, setRenderNodes] = useState<LayoutNode[]>([]);
  const [resetVersion, setResetVersion] = useState(0);
  const [transform, setTransform] = useState<ConstellationViewTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const transformRef = useRef(transform);
  const graph = useMemo(
    () => buildConstellationGraph(nodes, showArchived),
    [nodes, showArchived],
  );
  const inspectedNode =
    (inspectedNodeId
      ? graph.nodes.find(({ id }) => id === inspectedNodeId)
      : undefined) ??
    (selectedNodeId
      ? graph.nodes.find(({ id }) => id === selectedNodeId)
      : undefined) ??
    null;
  const activeInspectedNodeId = inspectedNode?.id ?? null;
  const Heading = publicView ? "h2" : "h1";
  const setOpenNodeControl = useCallback(
    (element: HTMLAnchorElement | HTMLButtonElement | null) => {
      openNodeControlRef.current = element;
    },
    [],
  );

  const finishDrag = useCallback((pointerId?: number) => {
    const dragState = dragStateRef.current;
    if (!dragState || (pointerId !== undefined && dragState.pointerId !== pointerId)) {
      return;
    }
    if (dragState.kind === "node") {
      const layoutNode = layoutNodesRef.current.find(({ id }) => id === dragState.nodeId);
      if (layoutNode) {
        layoutNode.fx = null;
        layoutNode.fy = null;
      }
      simulationRef.current?.alphaTarget(0);
    }
    dragStateRef.current = null;
  }, []);

  const finishPointer = useCallback((pointerId: number) => {
    activePointersRef.current.delete(pointerId);
    const pinchState = pinchStateRef.current;
    if (pinchState?.pointerIds.includes(pointerId)) {
      pinchStateRef.current = null;
    }
    finishDrag(pointerId);
  }, [finishDrag]);

  useEffect(() => {
    const activePointers = activePointersRef.current;
    const handleWindowPointerEnd = (event: globalThis.PointerEvent) => {
      finishPointer(event.pointerId);
    };
    window.addEventListener("pointerup", handleWindowPointerEnd);
    window.addEventListener("pointercancel", handleWindowPointerEnd);
    return () => {
      window.removeEventListener("pointerup", handleWindowPointerEnd);
      window.removeEventListener("pointercancel", handleWindowPointerEnd);
      activePointers.clear();
      pinchStateRef.current = null;
      finishDrag();
    };
  }, [finishDrag, finishPointer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateDimensions = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setDimensions({ width: Math.round(width), height: Math.round(height) });
      }
    };
    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    simulationRef.current?.stop();
    simulationRef.current = null;

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const layoutNodes: LayoutNode[] = graph.nodes.map((node, index) => {
      const orbit = 36 * Math.sqrt(index);
      return {
        id: node.id,
        node,
        x: dimensions.width / 2 + Math.cos(index * goldenAngle) * orbit,
        y: dimensions.height / 2 + Math.sin(index * goldenAngle) * orbit,
      };
    });
    const layoutLinks: LayoutLink[] = graph.links.map(({ sourceId, targetId }) => ({
      source: sourceId,
      target: targetId,
    }));
    const radiusById = new Map(
      layoutNodes.map(({ id, node }) => [id, constellationRadiusForDepth(node.depth)]),
    );
    layoutNodesRef.current = layoutNodes;

    if (layoutNodes.length === 0) {
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        setRenderNodes([]);
      });
      return () => {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      };
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      layoutNodes.forEach((layoutNode, index) => {
        const position = staticConstellationPosition(
          index,
          dimensions.width,
          dimensions.height,
        );
        layoutNode.x = position.x;
        layoutNode.y = position.y;
      });
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        setRenderNodes(layoutNodes.map((layoutNode) => ({ ...layoutNode })));
      });
      return () => {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      };
    }

    const publishLayout = () => {
      if (animationFrameRef.current !== null) {
        return;
      }
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        setRenderNodes(layoutNodes.map((layoutNode) => ({ ...layoutNode })));
      });
    };
    const simulation = forceSimulation<LayoutNode>(layoutNodes)
      .force(
        "link",
        forceLink<LayoutNode, LayoutLink>(layoutLinks)
          .id(({ id }) => id)
          .distance((link) => {
            const sourceId = typeof link.source === "string" ? link.source : link.source.id;
            const targetId = typeof link.target === "string" ? link.target : link.target.id;
            return (
              (radiusById.get(sourceId) ?? CONSTELLATION_ROOT_RADIUS) +
              (radiusById.get(targetId) ?? CONSTELLATION_ROOT_RADIUS) +
              62
            );
          })
          .strength(0.32),
      )
      .force("charge", forceManyBody<LayoutNode>().strength(-300))
      .force(
        "collide",
        forceCollide<LayoutNode>()
          .radius(({ node }) => constellationCollisionRadiusForDepth(node.depth))
          .strength(0.9)
          .iterations(2),
      )
      .force("center", forceCenter(dimensions.width / 2, dimensions.height / 2).strength(0.08))
      .force("x", forceX<LayoutNode>(dimensions.width / 2).strength(0.025))
      .force("y", forceY<LayoutNode>(dimensions.height / 2).strength(0.025))
      .alphaDecay(0.04)
      .velocityDecay(0.24)
      .on("tick", publishLayout)
      .on("end", publishLayout);
    simulationRef.current = simulation;

    return () => {
      simulation.stop();
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [dimensions.height, dimensions.width, graph, resetVersion]);

  const nodeById = useMemo(
    () => new Map(renderNodes.map((layoutNode) => [layoutNode.id, layoutNode])),
    [renderNodes],
  );

  useEffect(() => {
    if (!focusFirstNodeAfterRevealRef.current || graph.nodes.length === 0) {
      return;
    }
    const firstNode = nodeRefs.current.get(graph.nodes[0].id);
    if (!firstNode) {
      return;
    }
    focusFirstNodeAfterRevealRef.current = false;
    const frame = window.requestAnimationFrame(() => firstNode.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [graph.nodes, renderNodes]);

  function scaleBy(factor: number, anchorX?: number, anchorY?: number) {
    setTransform((current) => {
      const x = anchorX ?? dimensions.width / 2;
      const y = anchorY ?? dimensions.height / 2;
      const next = zoomConstellationTransform(current, factor, x, y);
      transformRef.current = next;
      return next;
    });
  }

  function resetLayout() {
    activePointersRef.current.clear();
    pinchStateRef.current = null;
    finishDrag();
    const resetTransform = { x: 0, y: 0, scale: 1 };
    transformRef.current = resetTransform;
    setTransform(resetTransform);
    setResetVersion((current) => current + 1);
  }

  function handleWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    const factor = constellationWheelScaleFactor(
      event.deltaY,
      event.deltaMode,
      dimensions.height,
    );
    scaleBy(factor, event.clientX - bounds.left, event.clientY - bounds.top);
  }

  function beginPinchIfReady() {
    const entries = [...activePointersRef.current.entries()].slice(0, 2);
    const bounds = containerRef.current?.getBoundingClientRect();
    if (entries.length < 2 || !bounds) {
      return false;
    }
    finishDrag();
    const [[firstId, first], [secondId, second]] = entries;
    const firstX = first.clientX - bounds.left;
    const firstY = first.clientY - bounds.top;
    const secondX = second.clientX - bounds.left;
    const secondY = second.clientY - bounds.top;
    const midpointX = (firstX + secondX) / 2;
    const midpointY = (firstY + secondY) / 2;
    const current = transformRef.current;
    pinchStateRef.current = {
      pointerIds: [firstId, secondId],
      startDistance: Math.max(Math.hypot(secondX - firstX, secondY - firstY), 1),
      startScale: current.scale,
      worldX: (midpointX - current.x) / current.scale,
      worldY: (midpointY - current.y) / current.scale,
    };
    return true;
  }

  function registerPointer(event: ReactPointerEvent<SVGSVGElement | SVGGElement>) {
    activePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
    capturePointer(canvasRef.current ?? event.currentTarget, event.pointerId);
    return beginPinchIfReady();
  }

  function beginCanvasDrag(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType === "mouse" && event.button > 0) {
      return;
    }
    if (transformRef.current.scale < CONSTELLATION_COMFORTABLE_INTERACTION_SCALE) {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        const scaleX = dimensions.width / bounds.width;
        const scaleY = dimensions.height / bounds.height;
        const nearestNode = nearestConstellationNodeAtPoint(
          layoutNodesRef.current,
          transformRef.current,
          {
            x: (event.clientX - bounds.left) * scaleX,
            y: (event.clientY - bounds.top) * scaleY,
          },
          CONSTELLATION_INTERACTION_RADIUS * Math.max(scaleX, scaleY),
        );
        if (nearestNode) {
          beginNodeDrag(event, nearestNode, true);
          return;
        }
      }
    }
    if (registerPointer(event)) {
      return;
    }
    const current = transformRef.current;
    dragStateRef.current = {
      kind: "canvas",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: current.x,
      startY: current.y,
    };
  }

  function beginNodeDrag(
    event: ReactPointerEvent<SVGSVGElement | SVGGElement>,
    node: LayoutNode,
    chooseOnStart = false,
  ) {
    if (event.pointerType === "mouse" && event.button > 0) {
      return;
    }
    event.stopPropagation();
    if (registerPointer(event)) {
      return;
    }
    if (chooseOnStart || publicView) {
      chooseNode(node.node, publicView);
    }
    dragStateRef.current = { kind: "node", nodeId: node.id, pointerId: event.pointerId };
    node.fx = node.x;
    node.fy = node.y;
    simulationRef.current?.alphaTarget(0.24).restart();
  }

  function movePointer(event: ReactPointerEvent<SVGSVGElement | SVGGElement>) {
    if (activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }
    const pinchState = pinchStateRef.current;
    if (pinchState?.pointerIds.includes(event.pointerId)) {
      event.stopPropagation();
      const first = activePointersRef.current.get(pinchState.pointerIds[0]);
      const second = activePointersRef.current.get(pinchState.pointerIds[1]);
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!first || !second || !bounds) {
        return;
      }
      const firstX = first.clientX - bounds.left;
      const firstY = first.clientY - bounds.top;
      const secondX = second.clientX - bounds.left;
      const secondY = second.clientY - bounds.top;
      const midpointX = (firstX + secondX) / 2;
      const midpointY = (firstY + secondY) / 2;
      const distance = Math.hypot(secondX - firstX, secondY - firstY);
      const scale = clamp(
        pinchState.startScale * distance / pinchState.startDistance,
        CONSTELLATION_MIN_SCALE,
        CONSTELLATION_MAX_SCALE,
      );
      const next = {
        x: midpointX - pinchState.worldX * scale,
        y: midpointY - pinchState.worldY * scale,
        scale,
      };
      transformRef.current = next;
      setTransform(next);
      return;
    }
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    if (dragState.kind === "canvas") {
      setTransform((current) => {
        const next = {
          ...current,
          x: dragState.startX + event.clientX - dragState.startClientX,
          y: dragState.startY + event.clientY - dragState.startClientY,
        };
        transformRef.current = next;
        return next;
      });
      return;
    }

    event.stopPropagation();
    const layoutNode = layoutNodesRef.current.find(({ id }) => id === dragState.nodeId);
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!layoutNode || !bounds) {
      return;
    }
    const current = transformRef.current;
    layoutNode.fx = (event.clientX - bounds.left - current.x) / current.scale;
    layoutNode.fy = (event.clientY - bounds.top - current.y) / current.scale;
    if (!simulationRef.current) {
      layoutNode.x = layoutNode.fx;
      layoutNode.y = layoutNode.fy;
      setRenderNodes(layoutNodesRef.current.map((candidate) => ({ ...candidate })));
    }
  }

  function endPointer(event: ReactPointerEvent<SVGSVGElement | SVGGElement>) {
    finishPointer(event.pointerId);
  }

  function chooseNode(node: TreeNode, persistPublicSelection = false) {
    setInspectedNodeId(node.id);
    if (publicView && persistPublicSelection) {
      props.onSelectNode(node.id);
    }
  }

  function focusRelativeNode(nodeId: string, offset: number) {
    const currentIndex = graph.nodes.findIndex(({ id }) => id === nodeId);
    if (currentIndex < 0 || graph.nodes.length === 0) {
      return;
    }
    const nextIndex = (currentIndex + offset + graph.nodes.length) % graph.nodes.length;
    nodeRefs.current.get(graph.nodes[nextIndex].id)?.focus();
  }

  function handleNodeKeyDown(event: KeyboardEvent<SVGGElement>, node: TreeNode) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseNode(node, true);
      window.requestAnimationFrame(() => openNodeControlRef.current?.focus());
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusRelativeNode(node.id, 1);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRelativeNode(node.id, -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? graph.nodes[0] : graph.nodes.at(-1);
      if (target) {
        nodeRefs.current.get(target.id)?.focus();
      }
    }
  }

  return (
    <section className="constellation" aria-labelledby="constellation-heading">
      <header className="constellation__header">
        <div>
          {!publicView ? <p className="eyebrow">Read-only view</p> : null}
          <Heading id="constellation-heading">Thought Constellation</Heading>
        </div>
        <div className="constellation__legend" aria-label="Constellation legend">
          <span><i className="constellation__legend-root" />Root thought</span>
          {!publicView && showArchived ? (
            <span><i className="constellation__legend-archived" />Archived</span>
          ) : null}
          <span className="constellation__play-cue">Drag bubbles to reshape the constellation</span>
        </div>
      </header>

      <div className="constellation__stage" ref={containerRef}>
        {graph.nodes.length === 0 ? (
          <div className="constellation__empty">
            <p>{publicView
              ? "No shared thoughts to map."
              : nodes.length === 0
                ? "Create a thought to start your constellation."
                : "No active thoughts to map."}
            </p>
            {!publicView && nodes.length === 0 ? (
              <button className="text-action" type="button" onClick={props.onCreateRoot}>
                Create your first root thought
              </button>
            ) : null}
            {!publicView && nodes.length > 0 ? (
              <button
                className="text-action"
                type="button"
                onClick={() => {
                  focusFirstNodeAfterRevealRef.current = true;
                  props.onShowArchived();
                }}
              >
                Show archived thoughts
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <svg
              ref={canvasRef}
              className="constellation__canvas"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
              role="group"
              aria-label={`${graph.nodes.length} thought node constellation`}
              onPointerDown={beginCanvasDrag}
              onPointerMove={movePointer}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onLostPointerCapture={endPointer}
              onWheel={handleWheel}
            >
              <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
                <g className="constellation__links" aria-hidden="true">
                  {graph.links.map((link) => {
                    const source = nodeById.get(link.sourceId);
                    const target = nodeById.get(link.targetId);
                    if (!source || !target) {
                      return null;
                    }
                    return (
                      <line
                        key={`${link.sourceId}:${link.targetId}`}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                      />
                    );
                  })}
                </g>
                <g className="constellation__nodes">
                  {graph.nodes.map((node) => {
                    const layoutNode = nodeById.get(node.id);
                    if (!layoutNode) {
                      return null;
                    }
                    const classes = [
                      "constellation-node",
                      node.parentId === null ? "constellation-node--root" : "",
                      node.archivedAt !== null ? "constellation-node--archived" : "",
                      activeInspectedNodeId === node.id ? "constellation-node--selected" : "",
                    ].filter(Boolean).join(" ");
                    const archiveLabel = node.archivedAt === null ? "Active" : "Archived";
                    const radius = constellationRadiusForDepth(node.depth);
                    const label = labelForNode(node);

                    return (
                      <g
                        key={node.id}
                        ref={(element) => {
                          if (element) {
                            nodeRefs.current.set(node.id, element);
                          } else {
                            nodeRefs.current.delete(node.id);
                          }
                        }}
                        className={classes}
                        role="button"
                        tabIndex={0}
                        aria-label={publicView
                          ? `${breadcrumbForNode(node)}: Shared thought`
                          : `${breadcrumbForNode(node)}: ${archiveLabel}; ${constellationSynthesisLabel(node)}`
                        }
                        aria-pressed={activeInspectedNodeId === node.id}
                        style={nodeVisualStyle(radius)}
                        transform={`translate(${layoutNode.x ?? 0} ${layoutNode.y ?? 0})`}
                        onClick={() => chooseNode(node, true)}
                        onFocus={() => chooseNode(node, publicView)}
                        onKeyDown={(event) => handleNodeKeyDown(event, node)}
                        onPointerDown={(event) => beginNodeDrag(event, layoutNode)}
                        onPointerMove={movePointer}
                        onPointerUp={endPointer}
                        onPointerCancel={endPointer}
                        onLostPointerCapture={endPointer}
                      >
                        <circle
                          className="constellation-node__hit-target"
                          r={constellationInteractionRadiusForScale(transform.scale)}
                          style={{
                            pointerEvents:
                              transform.scale < CONSTELLATION_COMFORTABLE_INTERACTION_SCALE
                                ? "none"
                                : undefined,
                          }}
                        />
                        <circle
                          className="constellation-node__focus-ring"
                          r={constellationFocusRingRadius(radius, transform.scale)}
                        />
                        <circle
                          className="constellation-node__bubble"
                          r={radius}
                        />
                        <text
                          className="constellation-node__title"
                          dominantBaseline="central"
                          textAnchor="middle"
                          y="0"
                          style={{ fontSize: `${labelFontSize(radius)}px` }}
                        >
                          {label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>

            <div className="constellation__controls" aria-label="Constellation view controls">
              <button
                className="icon-button"
                type="button"
                aria-label="Zoom out"
                data-tooltip="Zoom out"
                disabled={transform.scale <= CONSTELLATION_MIN_SCALE}
                onClick={() => scaleBy(1 / 1.2)}
              >
                <MinusIcon />
              </button>
              <button
                className="icon-button constellation__reset"
                type="button"
                aria-label="Reset constellation"
                data-tooltip="Reset constellation"
                onClick={resetLayout}
              >
                <ResetIcon />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Zoom in"
                data-tooltip="Zoom in"
                disabled={transform.scale >= CONSTELLATION_MAX_SCALE}
                onClick={() => scaleBy(1.2)}
              >
                <PlusIcon />
              </button>
            </div>

            {inspectedNode ? (
              <aside
                className="constellation-card"
                aria-label={`${inspectedNode.title} constellation details`}
              >
                <p className="constellation-card__breadcrumb">
                  {breadcrumbForNode(inspectedNode)}
                </p>
                <div className="constellation-card__title">
                  <h2>{inspectedNode.title}</h2>
                  {!publicView ? (
                    <span
                      className={
                        inspectedNode.archivedAt === null
                          ? "status-pill"
                          : "status-pill status-pill--archived"
                      }
                    >
                      {inspectedNode.archivedAt === null ? "Active" : "Archived"}
                    </span>
                  ) : null}
                </div>
                {!publicView ? (
                  <p className="constellation-card__summary-state">
                    {constellationSynthesisLabel(inspectedNode)}
                  </p>
                ) : null}
                {publicView ? (
                  <a
                    ref={setOpenNodeControl}
                    className="button button--primary button--small constellation-card__action"
                    href={`?node=${encodeURIComponent(inspectedNode.id)}`}
                  >
                    Read thought
                  </a>
                ) : (
                  <button
                    ref={setOpenNodeControl}
                    className="button button--primary button--small"
                    type="button"
                    onClick={() => props.onOpenNode(inspectedNode.id)}
                  >
                    Open in tree
                  </button>
                )}
              </aside>
            ) : (
              <p className="constellation__hint">Choose a bubble, then give it a nudge.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
