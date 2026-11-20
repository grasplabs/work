// The core viewer's own work, as plain functions: searching a long text, a web page's words, and
// finding comments' words again. The Worker runs them off the page's thread; without a Worker the
// page runs them itself (client.ts). A renderer item (Markdown, CSV, code) brings its own tasks and
// its own Worker, so the core needs no package of theirs. Every result is plain data.
import { resolveText } from "../anchor";
import type { Quote, TextPosition } from "../anchor";

/**
 * Highlighted code, compact: where each piece ends in the source and its kind, as typed arrays the
 * Worker hands over without a copy. Made by the code item's Worker; read by the core's lines.
 */
export interface CodeTokens {
  /** Where each piece ends, in the source, in order. */
  ends: Uint32Array;
  /** Each piece's kind: an index into `kinds`, or 0 for none. */
  kind: Uint8Array;
  /** The kinds' names; the first is "" (none). */
  kinds: string[];
}

/** The core's tasks. */
export type CoreTask =
  | { kind: "search"; text: string; query: string; limit?: number }
  | { kind: "htmlText"; source: string }
  | {
      kind: "resolve";
      text: string;
      anchors: { quote: Quote; position: TextPosition }[];
    };

/**
 * Where a word or phrase stands in a text, case aside, up to `limit` places, and whether there are
 * more. It matches the text as it is (lower-casing first would shift the offsets of letters whose
 * lower case is longer, like İ), so every offset is the text's own.
 */
export const search = (
  text: string,
  query: string,
  limit = 10_000
): { at: number[]; more: boolean } => {
  const needle = query.trim();
  if (!needle) {
    return { at: [], more: false };
  }
  const pattern = new RegExp(
    needle.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    "giu"
  );
  const at: number[] = [];
  for (const found of text.matchAll(pattern)) {
    if (at.length === limit) {
      return { at, more: true };
    }
    at.push(found.index);
  }
  return { at, more: false };
};

// The named character references a page's words most often hold: Latin-1's and the common
// typographic ones, as name and code point (hex). Others stay as written: the words are for find,
// and an odd reference only costs that one word. A table of its own, so the core needs no package.
const NAMED_TABLE =
  "AElig:c6 AMP:26 Aacute:c1 Acirc:c2 Agrave:c0 Aring:c5 Atilde:c3 Auml:c4 COPY:a9 Ccedil:c7 " +
  "Cedilla:b8 CenterDot:b7 DiacriticalAcute:b4 DiacriticalGrave:60 Dot:a8 DoubleDot:a8 ETH:d0 " +
  "Eacute:c9 Ecirc:ca Egrave:c8 Euml:cb GT:3e Hat:5e Iacute:cd Icirc:ce Igrave:cc Iuml:cf LT:3c " +
  "NonBreakingSpace:a0 Ntilde:d1 Oacute:d3 Ocirc:d4 Ograve:d2 Oslash:d8 Otilde:d5 Ouml:d6 " +
  "PlusMinus:b1 QUOT:22 REG:ae THORN:de Uacute:da Ucirc:db Ugrave:d9 UnderBar:5f Uuml:dc " +
  "VerticalLine:7c Yacute:dd aacute:e1 acirc:e2 acute:b4 aelig:e6 agrave:e0 amp:26 angst:c5 apos:27 " +
  "aring:e5 ast:2a atilde:e3 auml:e4 brvbar:a6 bsol:5c ccedil:e7 cedil:b8 cent:a2 centerdot:b7 " +
  "circledR:ae colon:3a comma:2c commat:40 copy:a9 curren:a4 deg:b0 die:a8 div:f7 divide:f7 " +
  "dollar:24 eacute:e9 ecirc:ea egrave:e8 equals:3d eth:f0 euml:eb excl:21 frac12:bd frac14:bc " +
  "frac34:be grave:60 gt:3e half:bd iacute:ed icirc:ee iexcl:a1 igrave:ec iquest:bf iuml:ef " +
  "laquo:ab lbrace:7b lbrack:5b lcub:7b lowbar:5f lpar:28 lsqb:5b lt:3c macr:af micro:b5 midast:2a " +
  "middot:b7 nbsp:a0 not:ac ntilde:f1 num:23 oacute:f3 ocirc:f4 ograve:f2 ordf:aa ordm:ba oslash:f8 " +
  "otilde:f5 ouml:f6 para:b6 percnt:25 period:2e plus:2b plusmn:b1 pm:b1 pound:a3 quest:3f quot:22 " +
  "raquo:bb rbrace:7d rbrack:5d rcub:7d reg:ae rpar:29 rsqb:5d sect:a7 semi:3b shy:ad sol:2f " +
  "strns:af sup1:b9 sup2:b2 sup3:b3 szlig:df thorn:fe times:d7 uacute:fa ucirc:fb ugrave:f9 uml:a8 " +
  "uuml:fc verbar:7c vert:7c yacute:fd yen:a5 yuml:ff hellip:2026 mdash:2014 ndash:2013 lsquo:2018 " +
  "rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e bull:2022 euro:20ac trade:2122 " +
  "dagger:2020 Dagger:2021 permil:2030 lsaquo:2039 rsaquo:203a minus:2212 larr:2190 rarr:2192 " +
  "uarr:2191 darr:2193 harr:2194 ne:2260 le:2264 ge:2265 infin:221e asymp:2248 thinsp:2009 " +
  "ensp:2002 emsp:2003 zwnj:200c zwj:200d lrm:200e rlm:200f OElig:152 oelig:153 Scaron:160 " +
  "scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc prime:2032 Prime:2033 check:2713 star:2606 " +
  "hearts:2665 ";

const NAMED = new Map(
  NAMED_TABLE.trim()
    .split(" ")
    .map((pair) => {
      const [name = "", code = "0"] = pair.split(":");
      return [name, String.fromCodePoint(Number.parseInt(code, 16))] as const;
    })
);

// A character reference: named (`&amp;`), decimal (`&#38;`) or hexadecimal (`&#x26;`). A named one
// may lack its semicolon, as browsers allow for the old Latin-1 names (`&eacute`).
const REFERENCE =
  /&(?:#(?<decimal>\d+);?|#x(?<hex>[\da-f]+);?|(?<name>[a-z][a-z\d]*)(?<semicolon>;?))/giu;

// A tag, read as a browser reads one: a quoted attribute value may hold ">" (`title="a>b"`).
const TAG =
  /<\/?[a-z][^\s/>]*(?:\s*(?:[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\/))*\s*>/giu;

// Elements whose content is not words on the page; an unclosed one runs to the end, as in a browser.
const HIDDEN =
  /<(?<tag>script|style|template|noscript|title|textarea)\b(?:"[^"]*"|'[^']*'|[^>])*>[\s\S]*?(?:<\/\k<tag>\s*>|$)/giu;

// A numbered reference's character, or the reference as written when no character has that number.
const fromCode = (code: number, whole: string) =>
  code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : whole;

const decode = (
  whole: string,
  decimal?: string,
  hex?: string,
  name?: string,
  semicolon?: string
) => {
  if (decimal !== undefined) {
    return fromCode(Math.trunc(Number(decimal)), whole);
  }
  if (hex !== undefined) {
    return fromCode(Number.parseInt(hex, 16), whole);
  }
  const character = name === undefined ? undefined : NAMED.get(name);
  if (character === undefined) {
    return whole;
  }
  // Without its semicolon only an old Latin-1 name is read, as browsers do.
  return semicolon === ";" ||
    (character.length === 1 && (character.codePointAt(0) ?? 256) < 256)
    ? character
    : whole;
};

/**
 * The words a page shows, from its HTML source, for search: scripts, styles, titles, comments and
 * tags go, character references become their characters, and each block starts a new line. Read
 * as text, never parsed into a document, so nothing in it runs or loads. It is close to what the
 * page shows, not exact: CSS can hide words, and a page's scripts can write more.
 */
export const htmlText = (source: string) =>
  source
    .replaceAll(/<!--[\s\S]*?(?:--!?>|$)/gu, " ")
    .replace(HIDDEN, " ")
    .replace(TAG, (tag) =>
      /^<\/?(?:p|div|section|article|header|footer|main|nav|li|tr|h[1-6]|br|table|ul|ol|blockquote|pre|figure|figcaption|dt|dd)\b/iu.test(
        tag
      )
        ? "\n"
        : ""
    )
    .replace(REFERENCE, decode)
    .replaceAll(/[ \t\r\f\v ]+/gu, " ")
    .replaceAll(/ ?\n\s*/gu, "\n")
    .trim();

const perform = (task: CoreTask): unknown => {
  switch (task.kind) {
    case "search": {
      return search(task.text, task.query, task.limit);
    }
    case "htmlText": {
      return htmlText(task.source);
    }
    case "resolve": {
      // Comments whose words moved: found again in one pass, off the page's thread.
      return task.anchors.map((anchor) => resolveText(anchor, task.text));
    }
    default: {
      return undefined;
    }
  }
};

/** Runs one of the core's tasks. */
export const run = async (task: CoreTask): Promise<unknown> =>
  await Promise.resolve(perform(task));
