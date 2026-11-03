import type { LinksReference } from "@grasp-os/sdk";
import { useClient } from "@grasp-os/sdk/react";
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
// URL through one of the App's links resources (`client.links.open`). So
// given the resource (`links`), a link is a button that opens its address
// through it; without one, the link's words show with their address
// beside them, to read.

/** The links resource a link's address opens through, if the screen gave one. */
const Links = createContext<LinksReference | undefined>(undefined);

/** A link that opens its address through the screen's links resource. */
const OpeningLink = ({
  links,
  href,
  children,
}: {
  links: LinksReference;
  href: string;
  children?: ReactNode;
}): ReactNode => {
  const client = useClient();
  return (
    <Button
      onClick={() => {
        const open = async (): Promise<void> => {
          try {
            await client.links.open(links, { url: href });
          } catch {
            // The host says why it didn't open (an address the resource
            // doesn't allow, the person declining) in its own UI.
          }
        };
        void open();
      }}
      size="inline"
      type="button"
      variant="link"
    >
      {children}
    </Button>
  );
};

const RichLink = ({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}): ReactNode => {
  const links = use(Links);
  // An address the transform dropped (`javascript:`): its words alone.
  if (href === undefined || href === "") {
    return <span>{children}</span>;
  }
  if (links !== undefined) {
    return (
      <OpeningLink href={href} links={links}>
        {children}
      </OpeningLink>
    );
  }
  return children === href ? (
    <span>{href}</span>
  ) : (
    <span>
      {children} ({href})
    </span>
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
  // A list that starts elsewhere (`3. …`) keeps its numbering.
  ol: ({ children, start }) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5" start={start}>
      {children}
    </ol>
  ),
  a: ({ href, children }) => <RichLink href={href}>{children}</RichLink>,
  img: ({ alt }) => <span>{alt}</span>,
};

function RichText({
  value,
  links,
  className,
}: {
  /** The Markdown, as a rich text field saved it. */
  value: string;
  /**
   * The App's links resource its links open through (`resources.site`):
   * a link is then a button that opens its address there. Without it,
   * links show their address as text.
   */
  links?: LinksReference;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2 text-sm", className)}
      data-slot="rich-text"
    >
      <Links value={links}>
        <Markdown components={components} skipHtml>
          {value}
        </Markdown>
      </Links>
    </div>
  );
}

export { RichText };
