"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";

import type { InternalCitationView } from "@/lib/citations/contracts";

const allowedElements = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "em", "strong", "a"];

export function ChatMessageContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      allowedElements={allowedElements}
      skipHtml
      components={{
        a: ({ children }) => <>{children}</>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

const internalLinkPrefix = "#mindtree-internal-link-";

type MarkdownAstNode = {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

function createInternalLinkPlugin(
  content: string,
  citations: readonly InternalCitationView[],
) {
  const ordered = [...citations].sort((left, right) =>
    left.startUtf16 - right.startUtf16 || left.ordinal - right.ordinal
  );

  return function internalLinkPlugin() {
    return (tree: unknown) => {
      const visit = (node: MarkdownAstNode) => {
        if (
          node.type === "link" ||
          node.type === "linkReference" ||
          node.type === "image" ||
          node.type === "imageReference" ||
          node.type === "code" ||
          node.type === "inlineCode"
        ) {
          return;
        }
        if (!node.children) return;

        for (let index = 0; index < node.children.length; index += 1) {
          const child = node.children[index]!;
          const start = child.position?.start?.offset;
          const end = child.position?.end?.offset;
          if (
            child.type !== "text" ||
            typeof child.value !== "string" ||
            typeof start !== "number" ||
            typeof end !== "number" ||
            content.slice(start, end) !== child.value
          ) {
            visit(child);
            continue;
          }

          const withinTextNode = ordered.filter((citation) =>
            citation.startUtf16 >= start &&
            citation.endUtf16 <= end &&
            citation.endUtf16 > citation.startUtf16 &&
            content.slice(citation.startUtf16, citation.endUtf16) ===
              child.value!.slice(citation.startUtf16 - start, citation.endUtf16 - start)
          );
          if (withinTextNode.length === 0) continue;

          const replacement: MarkdownAstNode[] = [];
          let cursor = 0;
          for (const citation of withinTextNode) {
            const linkStart = citation.startUtf16 - start;
            const linkEnd = citation.endUtf16 - start;
            if (linkStart < cursor) continue;
            if (linkStart > cursor) {
              replacement.push({ type: "text", value: child.value.slice(cursor, linkStart) });
            }
            replacement.push({
              type: "link",
              url: `${internalLinkPrefix}${citation.ordinal}`,
              children: [{ type: "text", value: child.value.slice(linkStart, linkEnd) }],
            });
            cursor = linkEnd;
          }
          if (cursor < child.value.length) {
            replacement.push({ type: "text", value: child.value.slice(cursor) });
          }
          node.children.splice(index, 1, ...replacement);
          index += replacement.length - 1;
        }
      };

      visit(tree as MarkdownAstNode);
    };
  };
}

function internalLinkStateLabel(citation: InternalCitationView) {
  if (citation.target.state === "unavailable") return "Unavailable";
  const states = [
    citation.target.renamed ? `Renamed from ${citation.snapshot.title}` : null,
    citation.target.moved ? "Moved since linked" : null,
    citation.target.archived ? "Archived" : null,
    citation.target.changedRevision ? "Summary changed since linked" : null,
  ].filter((state): state is string => state !== null);
  return states.length > 0 ? states.join(" · ") : "Exact linked revision";
}

function internalLinkNeedsAttention(citation: InternalCitationView) {
  return citation.target.state === "unavailable" ||
    citation.target.renamed ||
    citation.target.moved ||
    citation.target.archived ||
    citation.target.changedRevision;
}

const tooltipViewportMargin = 16;
const tooltipTargetGap = 7;

type TooltipRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

type ManualPopoverElement = HTMLSpanElement & {
  hidePopover: () => void;
  showPopover: () => void;
};

function supportsManualPopover(element: HTMLSpanElement): element is ManualPopoverElement {
  return typeof element.showPopover === "function" &&
    typeof element.hidePopover === "function";
}

export function calculateInternalTooltipPosition(input: {
  target: TooltipRect;
  tooltip: Pick<TooltipRect, "width" | "height">;
  viewportWidth: number;
  viewportHeight: number;
}) {
  const minimumLeft = tooltipViewportMargin + input.tooltip.width / 2;
  const maximumLeft = input.viewportWidth - tooltipViewportMargin - input.tooltip.width / 2;
  const targetCenter = input.target.left + input.target.width / 2;
  const left = maximumLeft < minimumLeft
    ? input.viewportWidth / 2
    : Math.min(maximumLeft, Math.max(minimumLeft, targetCenter));
  const roomAbove = input.target.top - tooltipViewportMargin;
  const roomBelow = input.viewportHeight - input.target.bottom - tooltipViewportMargin;
  const placeAbove = roomAbove >= input.tooltip.height + tooltipTargetGap || roomAbove >= roomBelow;
  const desiredTop = placeAbove
    ? input.target.top - tooltipTargetGap - input.tooltip.height
    : input.target.bottom + tooltipTargetGap;
  const maximumTop = Math.max(
    tooltipViewportMargin,
    input.viewportHeight - tooltipViewportMargin - input.tooltip.height,
  );
  return {
    left,
    placement: placeAbove ? "above" as const : "below" as const,
    top: Math.min(maximumTop, Math.max(tooltipViewportMargin, desiredTop)),
  };
}

function InternalNodeTooltipTarget({
  children,
  citation,
  description,
  descriptionId,
  linkedPhrase,
}: {
  children: ReactNode;
  citation: InternalCitationView;
  description: string;
  descriptionId: string;
  linkedPhrase: string;
}) {
  const targetRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const dismissedRef = useRef(false);
  const focusedRef = useRef(false);
  const hoveredRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<
    typeof calculateInternalTooltipPosition
  > | null>(null);

  const updatePosition = useCallback(() => {
    const target = targetRef.current;
    const tooltip = tooltipRef.current;
    if (!target || !tooltip) return;
    setPosition(calculateInternalTooltipPosition({
      target: target.getBoundingClientRect(),
      tooltip: tooltip.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, []);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!open || !tooltip) return;
    if (!supportsManualPopover(tooltip)) return;
    try {
      tooltip.showPopover();
    } catch {
      return;
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      try {
        tooltip.hidePopover();
      } catch {
        // The browser may have dismissed the popover before React cleanup.
      }
    };
  }, [open, updatePosition]);

  const interactionProps = {
    onBlur: () => {
      focusedRef.current = false;
      if (!hoveredRef.current) dismissedRef.current = false;
      setOpen(hoveredRef.current && !dismissedRef.current);
    },
    onFocus: () => {
      if (!hoveredRef.current) dismissedRef.current = false;
      focusedRef.current = true;
      setPosition(null);
      setOpen(!dismissedRef.current);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      dismissedRef.current = true;
      setOpen(false);
      event.stopPropagation();
    },
    onMouseEnter: () => {
      if (!focusedRef.current) dismissedRef.current = false;
      hoveredRef.current = true;
      setPosition(null);
      setOpen(!dismissedRef.current);
    },
    onMouseLeave: () => {
      hoveredRef.current = false;
      if (!focusedRef.current) dismissedRef.current = false;
      setOpen(focusedRef.current && !dismissedRef.current);
    },
  };
  const tooltip = (
    <span
      aria-hidden="true"
      className="internal-node-tooltip"
      popover="manual"
      ref={tooltipRef}
      style={position ? {
        left: position.left,
        top: position.top,
        transform: "translateX(-50%)",
        visibility: "visible",
      } : undefined}
    >
      {description}
    </span>
  );

  return citation.target.state === "available" ? (
    <>
      <a
        {...interactionProps}
        aria-describedby={descriptionId}
        aria-label={linkedPhrase}
        className={internalLinkNeedsAttention(citation)
          ? "internal-node-link internal-node-link--changed"
          : "internal-node-link"}
        href={`/?node=${encodeURIComponent(citation.target.nodeId)}`}
        ref={(element) => { targetRef.current = element; }}
      >
        {children}
      </a>
      <span className="sr-only" id={descriptionId}>. {description}</span>
      {tooltip}
    </>
  ) : (
    <>
      <span
        {...interactionProps}
        aria-describedby={descriptionId}
        aria-label={`${linkedPhrase} (unavailable)`}
        className="internal-node-link internal-node-link--unavailable"
        ref={(element) => { targetRef.current = element; }}
        role="note"
        tabIndex={0}
      >
        {children}
        <span aria-hidden="true" className="internal-node-link-status"> (unavailable)</span>
        <span className="sr-only" id={descriptionId}>. {description}</span>
      </span>
      {tooltip}
    </>
  );
}

export function SynthesisDocumentContent({
  content,
  citations = [],
}: {
  content: string;
  citations?: readonly InternalCitationView[];
}) {
  const byOrdinal = new Map(citations.map((citation) => [citation.ordinal, citation]));
  const descriptionPrefix = useId();
  return (
    <>
      <ReactMarkdown
        allowedElements={allowedElements}
        remarkPlugins={[createInternalLinkPlugin(content, citations)]}
        skipHtml
        components={{
          a: ({ children, href }) => {
            const ordinal = href?.startsWith(internalLinkPrefix)
              ? Number(href.slice(internalLinkPrefix.length))
              : Number.NaN;
            const citation = Number.isInteger(ordinal) ? byOrdinal.get(ordinal) : undefined;
            if (!citation) return <>{children}</>;
            const description = citation.target.state === "available"
              ? `Linked thought: ${citation.target.title}. ${internalLinkStateLabel(citation)}. Linked revision ${citation.snapshot.synthesisVersionId.slice(0, 8)}`
              : `Unavailable linked thought, formerly ${citation.snapshot.title}`;
            const descriptionId = `${descriptionPrefix}-internal-link-${citation.ordinal}`;
            const linkedPhrase = content.slice(citation.startUtf16, citation.endUtf16);
            return (
              <InternalNodeTooltipTarget
                citation={citation}
                description={description}
                descriptionId={descriptionId}
                linkedPhrase={linkedPhrase}
              >
                {children}
              </InternalNodeTooltipTarget>
            );
          },
          h1: ({ children }) => <h4>{children}</h4>,
          h2: ({ children }) => <h5>{children}</h5>,
          h3: ({ children }) => <h6>{children}</h6>,
          h4: ({ children }) => <h6>{children}</h6>,
          h5: ({ children }) => <h6>{children}</h6>,
          h6: ({ children }) => <h6>{children}</h6>,
        }}
      >
        {content}
      </ReactMarkdown>
    </>
  );
}

export function BranchOutlineDocumentContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      allowedElements={allowedElements}
      skipHtml
      components={{
        a: ({ children }) => <>{children}</>,
        h1: ({ children }) => <h4>{children}</h4>,
        h2: ({ children }) => <h5>{children}</h5>,
        h3: ({ children }) => <h6>{children}</h6>,
        h4: ({ children }) => <h6>{children}</h6>,
        h5: ({ children }) => <h6>{children}</h6>,
        h6: ({ children }) => <h6>{children}</h6>,
        ul: ({ children }) => <ul role="list">{children}</ul>,
        ol: ({ children }) => <ol role="list">{children}</ol>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
