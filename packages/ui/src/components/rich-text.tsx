import { cn } from "@grasp-os/ui/lib/utils";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";

// Formatted text as the rich text field keeps it (Markdown), shown safely:
// raw HTML in it is dropped (`skipHtml`), a link keeps only a safe address
// (react-markdown's default URL transform: http, https, mailto and the
// like, never `javascript:`), and an image shows as its words. What the
// field writes (bold, italic, lists and links) reads as it was meant.

const components: Components = {
  p: ({ node: _node, ...props }) => <p {...props} />,
  ul: ({ node: _node, ...props }) => (
    <ul className="flex list-disc flex-col gap-1 pl-5" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5" {...props} />
  ),
  a: ({ node: _node, children, ...props }) => (
    <a
      className="text-primary underline underline-offset-4"
      rel="noopener noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span>{alt}</span>,
};

function RichText({
  value,
  className,
}: {
  /** The Markdown, as a rich text field saved it. */
  value: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2 text-sm", className)}
      data-slot="rich-text"
    >
      <Markdown components={components} skipHtml>
        {value}
      </Markdown>
    </div>
  );
}

export { RichText };
