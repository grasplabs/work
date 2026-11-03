import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { createContext, use } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";

// Formatted text as the rich text field keeps it (Markdown), shown safely:
// raw HTML in it is dropped (`skipHtml`), a link keeps only a safe address
// (react-markdown's default URL transform: http, https, mailto and the
// like, never `javascript:`), and an image shows as its words, never
// loaded from its address. Headings read as bold paragraphs: formatted
// text inside a screen never outranks the screen's own headings.
//
// An App's screen runs in a frame that opens nothing itself: it opens a
// URL through one of the App's links resources (`client.links.open`). So a
// link is a button that hands its address to `onOpenLink`, which the
// screen wires to its links resource; without it, the link's words show
// with their address beside them, to read.

/** How a link's address is opened, if the screen opens links. */
const OpenLink = createContext<((url: string) => void) | undefined>(undefined);

const RichLink = ({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}): ReactNode => {
  const open = use(OpenLink);
  // An address the transform dropped (`javascript:`): its words alone.
  if (href === undefined || href === "") {
    return <span>{children}</span>;
  }
  if (open === undefined) {
    return children === href ? (
      <span>{href}</span>
    ) : (
      <span>
        {children} ({href})
      </span>
    );
  }
  return (
    <Button
      onClick={() => {
        open(href);
      }}
      size="inline"
      type="button"
      variant="link"
    >
      {children}
    </Button>
  );
};

const heading: Components["h1"] = ({ children }) => (
  <p className="font-semibold">{children}</p>
);

const components: Components = {
  p: ({ children }) => <p>{children}</p>,
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  ul: ({ children }) => (
    <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5">{children}</ol>
  ),
  a: ({ href, children }) => <RichLink href={href}>{children}</RichLink>,
  img: ({ alt }) => <span>{alt}</span>,
};

function RichText({
  value,
  onOpenLink,
  className,
}: {
  /** The Markdown, as a rich text field saved it. */
  value: string;
  /**
   * Opens a link's address: the screen's links resource
   * (`(url) => void client.links.open(resources.site, url)`). Without it,
   * links show their address as text.
   */
  onOpenLink?: (url: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2 text-sm", className)}
      data-slot="rich-text"
    >
      <OpenLink value={onOpenLink}>
        <Markdown components={components} skipHtml>
          {value}
        </Markdown>
      </OpenLink>
    </div>
  );
}

export { RichText };
