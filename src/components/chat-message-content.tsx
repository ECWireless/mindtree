import ReactMarkdown from "react-markdown";

export function ChatMessageContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      allowedElements={["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "em", "strong", "a"]}
      skipHtml
      components={{
        a: ({ children }) => <>{children}</>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
