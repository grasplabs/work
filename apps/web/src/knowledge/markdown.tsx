import {
  linkPath,
  splitFrontmatterBlock,
  wikiLinkPattern,
} from "@grasp-os/shared/knowledge";
import { Trans } from "@lingui/react/macro";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";

import { CitedNote, citedNoteLink } from "../chat/cited-note.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { Link } from "../grasp/link/index.ts";
import { Markdown } from "../grasp/markdown/index.ts";
import type { MarkdownDrawn, MarkdownLink } from "../grasp/markdown/index.ts";
import { Text } from "../grasp/text/index.ts";
import { documentHref } from "./wiki-links.ts";
import type { ResolveLink } from "./wiki-links.ts";

// A Knowledge document, rendered, by Grasp UI's Markdown. Its text is
// whatever anyone who may change the collection wrote, or whatever an
// uploaded file held, so nothing in it runs or loads: raw HTML is dropped
// before it is drawn, a link keeps its address only for a safe protocol
// (http, https, mailto and a few more; react-markdown's
// `defaultUrlTransform` empties any other, such as `javascript:`), and
// opens in a tab of its own without this page as its opener. Images show
// their alt text: loading one would tell its host who read the document,
// and when (Markdown never loads one). A `[[link]]` to a document of the
// collection opens it here. The agent's answers render the same way
// (`PlainMarkdown`): they may repeat whatever the agent read.

/**
 * A document's Markdown without its frontmatter, found as core finds it.
 * Text that opens a block it never closes (core never saves one) shows
 * whole.
 */
export const bodyOf = (text: string): string =>
  splitFrontmatterBlock(text)?.body ?? text;

/** `body` without a first `# heading` that only repeats `title`. */
const withoutTitle = (body: string, title: string | undefined): string => {
  const [first = "", ...rest] = body.split("\n");
  return title !== undefined && first.trim() === `# ${title}`
    ? rest.join("\n").trim()
    : body;
};

/** The part of a Markdown syntax tree read here. */
interface Node {
  type: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** A span of the source and what replaces it. */
interface Edit {
  from: number;
  to: number;
  text: string;
}

/**
 * The `[[links]]` in the source of one text node that `resolve` knows,
 * each as a Markdown link to that document (`documentHref`), labelled
 * with its label or its target. One the page can't resolve stays as it
 * was written.
 */
const wikiLinkEdits = (
  source: string,
  from: number,
  resolve: ResolveLink
): Edit[] =>
  [...source.matchAll(wikiLinkPattern)].flatMap((match) => {
    const [target = "", ...rest] = (match.groups?.inner ?? "").split("|");
    const path = linkPath(target);
    const documentId = path === undefined ? undefined : resolve(path);
    if (documentId === undefined) {
      return [];
    }
    const label = rest.join("|").trim();
    const words = label === "" ? target.trim() : label;
    const start = from + match.index;
    return [
      {
        from: start,
        to: start + match[0].length,
        text: `[${words}](<${documentHref(documentId)}>)`,
      },
    ];
  });

/**
 * The changes `source` takes before it is drawn: raw HTML dropped, and,
 * with `resolve`, each `[[link]]` it knows made a link. Read from the
 * syntax tree, so code holds no links and an existing link isn't touched.
 */
const editsOf = (
  node: Node,
  source: string,
  resolve: ResolveLink | undefined
): Edit[] => {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) {
    return [];
  }
  if (node.type === "html") {
    return [{ from, to, text: "" }];
  }
  if (node.type === "text") {
    return resolve === undefined
      ? []
      : wikiLinkEdits(source.slice(from, to), from, resolve);
  }
  if (node.type === "link" || node.type === "linkReference") {
    return [];
  }
  return (node.children ?? []).flatMap((child) =>
    editsOf(child, source, resolve)
  );
};

/** `source` as it is drawn: see `editsOf`. */
const prepared = (source: string, resolve?: ResolveLink): string => {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return editsOf(tree, source, resolve)
    .toSorted((a, b) => b.from - a.from)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.from) + edit.text + text.slice(edit.to),
      source
    );
};

/** A resolved `[[link]]`'s address (`documentHref`), or one written so. */
const documentLink = /^\?doc=[^&#]+$/u;

/**
 * The document a link on this page opens, if it is one. Read with
 * `URLSearchParams`, which never throws on a malformed escape, as
 * `decodeURIComponent` would, in the middle of rendering.
 */
const documentOf = (href: string): string | undefined =>
  documentLink.test(href)
    ? (new URLSearchParams(href.slice(1)).get("doc") ?? undefined)
    : undefined;

/**
 * A link that leaves the page: in a tab of its own, without this page as
 * its opener. An address the transform empties is unsafe: the words stay,
 * as words. A picture is its alt words, never loaded.
 */
const leaving = ({ href, kind, children }: MarkdownLink): MarkdownDrawn => {
  const safe = defaultUrlTransform(href);
  if (kind === "image" || safe === "") {
    return <span>{children}</span>;
  }
  return (
    <Link external href={safe}>
      {children}
    </Link>
  );
};

/** A document's link: to another of the collection, here; any other, away. */
const documentLinkOf = (link: MarkdownLink): MarkdownDrawn => {
  const documentId = link.kind === "link" ? documentOf(link.href) : undefined;
  if (documentId === undefined) {
    // Any other, a `#heading` too, opens apart from this page.
    return leaving(link);
  }
  return (
    <RouterLink from="/knowledge/$collection" search={{ doc: documentId }}>
      {link.children}
    </RouterLink>
  );
};

/** No note cited. */
const noneCited: readonly string[] = [];

/**
 * An answer's link: a note `cited` names opens it here (`CitedNote`); a
 * note link to any other shows as its words, whatever the answer says;
 * every other link leaves the page.
 */
const plainLink = (
  link: MarkdownLink,
  cited: readonly string[]
): MarkdownDrawn => {
  const documentId = citedNoteLink.exec(link.href)?.groups?.id;
  if (documentId === undefined) {
    return leaving(link);
  }
  return cited.includes(documentId) ? (
    <CitedNote documentId={documentId}>{link.children}</CitedNote>
  ) : (
    <span>{link.children}</span>
  );
};

/**
 * Markdown that isn't a Knowledge document, such as the agent's answers,
 * as safely as a document: no raw HTML, safe links only, no images. Its
 * links to the notes `cited` names open them; no other note link does.
 */
export const PlainMarkdown = ({
  text,
  cited = noneCited,
}: {
  text: string;
  cited?: readonly string[];
}) => (
  <Markdown
    renderLink={(link) => plainLink(link, cited)}
    source={prepared(text)}
  />
);

/**
 * A document's text, frontmatter left out, as safe rendered Markdown, its
 * `[[links]]` resolved by `resolve`.
 */
export const DocumentMarkdown = ({
  text,
  resolve,
  title,
}: {
  text: string;
  resolve: ResolveLink;
  /** The title the page already shows: a first heading saying it again is left out. */
  title?: string;
}): ReactNode => {
  const body = withoutTitle(bodyOf(text).trim(), title);
  if (body === "") {
    return (
      <Text size="sm" tone="muted">
        <Trans>This document is empty.</Trans>
      </Text>
    );
  }
  return (
    <article>
      <Markdown renderLink={documentLinkOf} source={prepared(body, resolve)} />
    </article>
  );
};
