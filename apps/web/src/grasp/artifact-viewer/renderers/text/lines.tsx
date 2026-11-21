// Lines of text or code, each a row of the virtual viewport, with their numbers in a gutter. Code
// is highlighted in the Worker; until it is, its lines show plain, the same size, so nothing moves.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { grasp } from "../../../tokens/tokens.stylex";
import { markPiece, rowMatches, useMatches } from "../../find";
import type { RendererProps } from "../../types";
import { VirtualRows } from "../../virtual";
import { canRun, runTask } from "../../worker/client";
import type { CodeTokens } from "../../worker/tasks";

const styles = stylex.create({
  page: {
    boxSizing: "border-box",
    minWidth: "100%",
    width: "max-content",
    paddingBlock: grasp.space3,
    fontFamily: grasp.fontMono,
    color: grasp.text,
    backgroundColor: grasp.raised,
    // The page's numbers and words stay put in right-to-left text: code reads left to right.
    direction: "ltr",
  },
  line: (zoom: number) => ({
    display: "flex",
    fontSize: `calc(${grasp.textSm} * ${zoom})`,
    lineHeight: `calc(${grasp.viewerLine} * ${zoom})`,
  }),
  gutter: (digits: number) => ({
    flexShrink: 0,
    boxSizing: "content-box",
    width: `${digits}ch`,
    paddingInline: `${grasp.space4} ${grasp.space3}`,
    textAlign: "end",
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
  }),
  code: {
    whiteSpace: "pre",
    paddingInlineEnd: grasp.space6,
  },
  wrap: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    minWidth: 0,
    flexGrow: 1,
  },
  pageWrap: { width: "100%" },
  // Unwrapped, the page is as wide as its longest line: the rows are placed by the viewport and give
  // it no width of their own, so without this a long line ran past the page into the frame. The
  // width is in ch at the lines' own size: the gutter, the line and the room after it.
  pageWide: (characters: number, zoom: number) => ({
    fontSize: `calc(${grasp.textSm} * ${zoom})`,
    width: `calc(${characters}ch + ${grasp.space4} + ${grasp.space3} + ${grasp.space6})`,
  }),
});

// The few colours a page of code uses, as the docs' code.
const colours = stylex.create({
  keyword: { color: grasp.codeKeyword },
  constant: { color: grasp.codeConstant },
  string: { color: grasp.codeString },
  comment: { color: grasp.codeComment, fontStyle: "italic" },
  function: { color: grasp.codeFunction },
  punctuation: { color: grasp.codePunctuation },
  inserted: { color: grasp.codeInserted },
  deleted: { color: grasp.codeDeleted },
});

// Prism's token kinds, to the few colours a page of code uses.
const KIND: Record<string, keyof typeof colours> = {
  keyword: "keyword",
  important: "keyword",
  atrule: "keyword",
  selector: "keyword",
  tag: "keyword",
  boolean: "constant",
  number: "constant",
  constant: "constant",
  builtin: "constant",
  "class-name": "constant",
  symbol: "constant",
  property: "constant",
  "attr-name": "constant",
  string: "string",
  char: "string",
  "attr-value": "string",
  regex: "string",
  "template-string": "string",
  url: "string",
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "comment",
  function: "function",
  "function-variable": "function",
  punctuation: "punctuation",
  operator: "punctuation",
  inserted: "inserted",
  deleted: "deleted",
};

const ZOOM_DEFAULT = 100;

// The source's lines.
const linesOf = (source: string) => {
  const split = source.split(/\r?\n/u);
  if (split.length > 1 && split.at(-1) === "") {
    split.pop();
  }
  return split;
};

// Where each line starts in the source.
const startsOf = (lines: readonly string[], source: string) => {
  const at = new Uint32Array(lines.length);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    at[index] = offset;
    offset += line.length + (source[offset + line.length] === "\r" ? 2 : 1);
  }
  return at;
};

export const Lines = ({
  artifact,
  scroller,
  zoom,
  find,
  match,
  initialRow,
  onSections,
  onRows,
  onRow,
  onMatches,
  onRowOf,
  control,
  highlight,
  wrap,
}: RendererProps & { highlight: boolean; wrap: boolean }) => {
  const source = artifact.text ?? "";
  // A file that ends with a line break has no empty line after it.
  const lines = linesOf(source);
  // Where each line starts in the source, to find its highlighted pieces.
  const starts = startsOf(lines, source);
  const { language } = artifact;
  // The highlighted pieces, with the source and language they were made for: read only for those.
  const [painted, setPainted] = useState<{
    source: string;
    language: string;
    tokens: CodeTokens;
  } | null>(null);
  const coloured =
    highlight &&
    painted !== null &&
    painted.source === source &&
    painted.language === language
      ? painted.tokens
      : null;

  // The line a place in the source is on: for bringing a comment into view.
  useEffect(() => {
    onRowOf?.((_, offset) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high + 1) / 2);
        if ((starts[middle] ?? 0) <= offset) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      return low;
    });
  }, [starts, onRowOf]);
  const scale = (zoom === "fit" ? ZOOM_DEFAULT : zoom) / 100;
  const lineHeight = 20 * scale;

  useEffect(() => {
    onRows(lines.length);
    onSections([]);
  }, [lines, onRows, onSections]);

  useEffect(() => {
    let live = true;
    const paint = async (named: string) => {
      const tokens = await runTask({ kind: "code", source, language: named });
      if (live) {
        setPainted({ source, language: named, tokens });
      }
    };
    // Colours only when the code item is installed: without it the lines stay plain.
    if (
      highlight &&
      canRun("code") &&
      language !== undefined &&
      language !== ""
    ) {
      void paint(language);
    }
    return () => {
      live = false;
    };
  }, [highlight, source, language]);

  const matches = useMatches(lines, find, onMatches);
  useEffect(() => {
    const active = matches[match];
    if (active) {
      control.current?.scrollToRow(Math.max(0, active.row - 3));
    }
  }, [matches, match, control]);

  const digits = String(lines.length).length;
  const findLength = find.trim().length;
  // The longest line, in characters, a tab as the eight it is drawn as.
  let longest = 0;
  for (const line of lines) {
    longest = Math.max(
      longest,
      line.includes("\t")
        ? line.length + (line.split("\t").length - 1) * 7
        : line.length
    );
  }

  const renderRow = (index: number) => {
    const text = lines[index] ?? "";
    const { inRow, current } = rowMatches(matches, index, match);
    let content;
    if (coloured) {
      const lineStart = starts[index] ?? 0;
      const lineEnd = lineStart + text.length;
      // The first piece that ends after the line starts.
      let low = 0;
      let high = coloured.ends.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((coloured.ends[middle] ?? 0) <= lineStart) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      const parts = [];
      let from = lineStart;
      for (
        let piece = low;
        piece < coloured.ends.length && from < lineEnd;
        piece += 1
      ) {
        const pieceEnd = coloured.ends[piece] ?? lineEnd;
        const end = Math.min(pieceEnd, lineEnd);
        const words = source.slice(from, end);
        const name = coloured.kinds[coloured.kind[piece] ?? 0] ?? "";
        const style = name ? KIND[name] : undefined;
        parts.push(
          <span key={piece} {...stylex.props(style && colours[style])}>
            {markPiece(words, from - lineStart, findLength, inRow, current)}
          </span>
        );
        from = pieceEnd;
      }
      content = parts;
    } else {
      content = markPiece(text, 0, findLength, inRow, current);
    }
    return (
      <div {...stylex.props(styles.line(scale))}>
        <span aria-hidden="true" {...stylex.props(styles.gutter(digits))}>
          {index + 1}
        </span>
        {/* Its words, and where they start in the source: what a selection and a comment map to. */}
        <span
          data-offset={starts[index]}
          {...stylex.props(wrap ? styles.wrap : styles.code)}
        >
          {content}
        </span>
      </div>
    );
  };

  return (
    <div
      {...stylex.props(
        styles.page,
        wrap ? styles.pageWrap : styles.pageWide(digits + longest, scale)
      )}
    >
      <VirtualRows
        scroller={scroller}
        count={lines.length}
        estimate={() => lineHeight}
        fixed={!wrap}
        findable={(index) => lines[index] ?? ""}
        version={scale}
        initialRow={initialRow}
        onRow={onRow}
        control={control}
        renderRow={renderRow}
      />
    </div>
  );
};
