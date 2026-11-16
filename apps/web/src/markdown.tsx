import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Markdown that someone or something else wrote, such as the agent's
// answers, rendered so that nothing in it runs or loads: raw HTML is
// dropped (`skipHtml`), a link keeps its address only for a safe protocol
// (http, https, mailto and a few more; react-markdown's
// `defaultUrlTransform` empties any other, such as `javascript:`), and
// opens in a tab of its own without this page as its opener. Images show
// their alt text: loading one would tell its host who read the text, and
// when.

/**
 * A link that leaves the page: in a tab of its own, without this page as
 * its opener. An address the transform emptied was unsafe: the text stays,
 * as text.
 */
const OutsideLink = ({
  href,
  children,
}: {
  href?: string | undefined;
  children?: ReactNode;
}) =>
  href === undefined || href === "" ? (
    <span>{children}</span>
  ) : (
    <a
      className="underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );

const components: Components = {
  h1: ({ children }) => (
    <h1 className="font-serif text-2xl font-light tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children }) => <h2 className="text-xl font-medium">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-medium">{children}</h3>,
  h4: ({ children }) => <h4 className="font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="font-medium">{children}</h6>,
  ul: ({ children }) => <ul className="list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground border-l-2 pl-4">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="font-mono text-sm">{children}</code>,
  table: ({ children }) => <Table>{children}</Table>,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
  a: ({ href, children }) => <OutsideLink href={href}>{children}</OutsideLink>,
  img: ({ alt }) =>
    alt === undefined || alt === "" ? null : <span>{alt}</span>,
};

/** How a link that leaves the page is drawn: `OutsideLink`, unless one that asks first. */
export type LeavingLink = (props: {
  href: string | undefined;
  children: ReactNode;
}) => ReactNode;

/**
 * The components for text such as the agent's answers, every link drawn
 * by `Leaving`: `OutsideLink`, unless one that asks first.
 */
export const plainComponents = (
  Leaving: LeavingLink = OutsideLink
): Components => ({
  ...components,
  a: ({ href, children }) => <Leaving href={href}>{children}</Leaving>,
});

/**
 * Markdown such as the agent's answers, safely: no raw HTML, safe links
 * only (react-markdown's `defaultUrlTransform`), no images.
 */
export const PlainMarkdown = ({ text }: { text: string }) => (
  <div className="flex flex-col gap-3">
    <Markdown
      components={plainComponents()}
      remarkPlugins={[remarkGfm]}
      skipHtml
    >
      {text}
    </Markdown>
  </div>
);
