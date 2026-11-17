// Markdown to a syntax tree (markdown.tsx), with GitHub's additions (tables, task lists,
// strikethrough, autolinks, footnotes). Never HTML: raw HTML in the source stays a text node,
// drawn as text. Pinned as the product resolves them: mdast-util-from-markdown 2.0.3,
// micromark-extension-gfm 3.0.0, mdast-util-gfm 3.1.0.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import type { Root } from "./types";

/** The tree of `source`. */
export const parse = (source: string): Root =>
  fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

/** Only these lead anywhere: a link to another scheme (javascript:, data:, a relative path) is text. */
export const safeHref = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
};

/**
 * A link's scheme as a browser reads it, in lower case, for a host's allow-list: what leads the
 * address once the spaces and control characters round it, and any tab or line break in it, are
 * dropped (so `JaVa\tScript:` is `javascript`). Empty for an address with no scheme (a relative
 * path, `#…`).
 */
export const schemeOf = (url: string): string => {
  // A browser drops the spaces and control characters (code 32 and under) round an address.
  let start = 0;
  let end = url.length;
  while (start < end && (url.codePointAt(start) ?? 0) <= 32) {
    start += 1;
  }
  while (end > start && (url.codePointAt(end - 1) ?? 0) <= 32) {
    end -= 1;
  }
  const cleaned = url.slice(start, end).replaceAll(/[\t\n\r]/gu, "");
  const scheme = /^(?<scheme>[a-z][a-z\d+.-]*):/iu.exec(cleaned)?.groups
    ?.scheme;
  return scheme === undefined ? "" : scheme.toLowerCase();
};
