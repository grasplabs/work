import { Link } from "@grasp-os/ui/components/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useI18n } from "@grasp-os/ui/lib/i18n";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// The Markdown of a printed export's page (export-file.tsx): a Brain page or
// a chat, which someone or something else wrote, rendered so that nothing
// in it runs or loads. Raw HTML is dropped (`skipHtml`), a link keeps its
// address only for a safe protocol (http, https, mailto and a few more;
// react-markdown's `defaultUrlTransform` empties any other, such as
// `javascript:`), and images show their alt text: loading one would tell
// its host who read the text, and when. Not Damsko's Markdown, which draws
// for the screen: a copy button and folds on fenced code, folding
// sections, and raw HTML shown as text.

const styles = stylex.create({
  text: { display: "flex", flexDirection: "column", gap: space["3"] },
  // The first two levels in the serif, as the prototype's printed page
  // (packages/grasp/src/lib/export-file.ts).
  h1: {
    fontFamily: font.serif,
    fontSize: font.headingMd,
    lineHeight: font.headingMdLine,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
  },
  h2: {
    fontFamily: font.serif,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
  },
  h3: {
    fontSize: font.headingXs,
    lineHeight: font.headingXsLine,
    fontWeight: font.weightMedium,
  },
  minor: { fontWeight: font.weightMedium },
  ul: { listStyleType: "disc", paddingInlineStart: space["6"] },
  ol: { listStyleType: "decimal", paddingInlineStart: space["6"] },
  blockquote: {
    color: colors.mutedForeground,
    borderInlineStartWidth: "2px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    paddingInlineStart: space["4"],
  },
  pre: {
    overflowX: "auto",
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    padding: space["3"],
    fontSize: font.textSm,
  },
  code: { fontFamily: font.mono, fontSize: font.textSm },
});

/**
 * A link, as Damsko's Link underlines one in a sentence. Plain, not
 * `external`: on paper an arrow and "opens in a new tab" mean nothing, and
 * the PDF opens the address itself. An address the transform emptied was
 * unsafe: the text stays, as text.
 */
const PrintedLink = ({
  href,
  children,
}: {
  href?: string | undefined;
  children?: ReactNode;
}) =>
  href === undefined || href === "" ? (
    <span>{children}</span>
  ) : (
    <Link href={href}>{children}</Link>
  );

/** A table, named as Damsko's Markdown names one with no heading of its own. */
const MarkdownTable = ({ children }: { children?: ReactNode }) => {
  const words = useI18n().markdown;
  return <Table aria-label={words.table}>{children}</Table>;
};

const components: Components = {
  h1: ({ children }) => <h1 {...stylex.props(styles.h1)}>{children}</h1>,
  h2: ({ children }) => <h2 {...stylex.props(styles.h2)}>{children}</h2>,
  h3: ({ children }) => <h3 {...stylex.props(styles.h3)}>{children}</h3>,
  h4: ({ children }) => <h4 {...stylex.props(styles.minor)}>{children}</h4>,
  h5: ({ children }) => <h5 {...stylex.props(styles.minor)}>{children}</h5>,
  h6: ({ children }) => <h6 {...stylex.props(styles.minor)}>{children}</h6>,
  ul: ({ children }) => <ul {...stylex.props(styles.ul)}>{children}</ul>,
  ol: ({ children }) => <ol {...stylex.props(styles.ol)}>{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote {...stylex.props(styles.blockquote)}>{children}</blockquote>
  ),
  pre: ({ children }) => <pre {...stylex.props(styles.pre)}>{children}</pre>,
  code: ({ children }) => (
    <code {...stylex.props(styles.code)}>{children}</code>
  ),
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
  a: ({ href, children }) => <PrintedLink href={href}>{children}</PrintedLink>,
  img: ({ alt }) =>
    alt === undefined || alt === "" ? null : <span>{alt}</span>,
};

/**
 * A printed export's Markdown, safely: no raw HTML, safe links only
 * (react-markdown's `defaultUrlTransform`), no images.
 */
export const PlainMarkdown = ({ text }: { text: string }) => (
  <div {...stylex.props(styles.text)}>
    <Markdown components={components} remarkPlugins={[remarkGfm]} skipHtml>
      {text}
    </Markdown>
  </div>
);
