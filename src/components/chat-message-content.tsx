import ReactMarkdown from "react-markdown";

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

export function SynthesisDocumentContent({ content }: { content: string }) {
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
