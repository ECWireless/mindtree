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

const citationMarkerPrefix = "#mindtree-citation-";

export function addInternalCitationMarkers(
  content: string,
  citations: readonly InternalCitationView[],
) {
  let marked = content;
  for (const citation of [...citations].sort((left, right) =>
    right.endUtf16 - left.endUtf16 || right.ordinal - left.ordinal
  )) {
    if (
      citation.startUtf16 < 0 ||
      citation.endUtf16 <= citation.startUtf16 ||
      citation.endUtf16 > content.length
    ) {
      continue;
    }
    marked = `${marked.slice(0, citation.endUtf16)}[${citation.ordinal}](${citationMarkerPrefix}${citation.ordinal})${marked.slice(citation.endUtf16)}`;
  }
  return marked;
}

function citationStateLabel(citation: InternalCitationView) {
  if (citation.target.state === "unavailable") return "Unavailable";
  const states = [
    citation.target.renamed ? `Renamed from ${citation.snapshot.title}` : null,
    citation.target.moved ? "Moved since cited" : null,
    citation.target.archived ? "Archived" : null,
    citation.target.changedRevision ? "Summary changed since cited" : null,
  ].filter((state): state is string => state !== null);
  return states.length > 0 ? states.join(" · ") : "Exact cited revision";
}

export function SynthesisDocumentContent({
  content,
  citations = [],
}: {
  content: string;
  citations?: readonly InternalCitationView[];
}) {
  const byOrdinal = new Map(citations.map((citation) => [citation.ordinal, citation]));
  return (
    <>
      <ReactMarkdown
        allowedElements={allowedElements}
        skipHtml
        components={{
          a: ({ children, href }) => {
            const ordinal = href?.startsWith(citationMarkerPrefix)
              ? Number(href.slice(citationMarkerPrefix.length))
              : Number.NaN;
            const citation = Number.isInteger(ordinal) ? byOrdinal.get(ordinal) : undefined;
            if (!citation) return <>{children}</>;
            const label = citation.target.state === "available"
              ? `Citation ${citation.ordinal}: ${citation.target.title}. ${citationStateLabel(citation)}`
              : `Citation ${citation.ordinal}: unavailable thought, formerly ${citation.snapshot.title}`;
            return citation.target.state === "available" ? (
              <sup className="internal-citation-marker">
                <a
                  aria-label={label}
                  href={`/?node=${encodeURIComponent(citation.target.nodeId)}`}
                >
                  {children}
                </a>
              </sup>
            ) : (
              <sup className="internal-citation-marker internal-citation-marker--unavailable" aria-label={label}>
                {children}
              </sup>
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
        {addInternalCitationMarkers(content, citations)}
      </ReactMarkdown>
      {citations.length > 0 ? (
        <section className="internal-citations" aria-label="Cited thoughts">
          <h4>Cited thoughts</h4>
          <ol>
            {citations.map((citation) => (
              <li key={citation.ordinal} value={citation.ordinal}>
                {citation.target.state === "available" ? (
                  <a href={`/?node=${encodeURIComponent(citation.target.nodeId)}`}>
                    {citation.target.title}
                  </a>
                ) : (
                  <span>Unavailable thought — formerly {citation.snapshot.title}</span>
                )}
                <span>{citationStateLabel(citation)}</span>
                <span>Revision {citation.snapshot.synthesisVersionId.slice(0, 8)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
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
