import type { FileDiff } from "@grasp-os/shared/apps";
import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { File, MultiFileDiff, Virtualizer } from "@pierre/diffs/react";
import type { FileDiffOptions, FileOptions } from "@pierre/diffs/react";
import {
  FileBracesIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileTypeIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createElement } from "react";
import type { ReactNode } from "react";

// How the Code view (app-code.tsx) shows code: @pierre/diffs draws a file,
// and a file's change, as a code editor does, in a shadow root of its own,
// with line numbers, a gutter, scrolling sideways for long lines, and only
// the lines in sight (its virtualizer), so a file of thousands of lines
// scrolls smoothly. It highlights with its own highlighter, Highlights
// (`preferredHighlighter`), lexers compiled to WebAssembly, rather than
// Shiki: it is quicker and, with Shiki's grammars and the WebAssembly
// regex engine left out, ships less. Its colours are a theme of CSS
// variables ("grasp"), each set to one of the theme's tokens in styles.css,
// so it follows light and dark with the page. The page's CSP lets its
// WebAssembly compile and its inline styles apply (core's
// security-headers.ts).

/** The theme of CSS variables the view is drawn in (styles.css sets them). */
const theme = "grasp";
registerCustomCSSVariableTheme(theme, {});

/** A file, read-only: no header (the view has its own), Highlights. */
const fileOptions: FileOptions<undefined, undefined> = {
  theme,
  preferredHighlighter: "highlights",
  disableFileHeader: true,
  overflow: "scroll",
};

/** How a diff shows its two versions: one column, or side by side. */
export type DiffLayout = "unified" | "split";

/**
 * A file's change, read-only, under a header that stays while it scrolls.
 * Each hunk opens with its `@@ -a,b +c,d @@` line, as git prints it: the
 * library's other separators say "N unmodified lines" in English only.
 */
const diffOptions = (
  layout: DiffLayout
): FileDiffOptions<undefined, undefined> => ({
  theme,
  preferredHighlighter: "highlights",
  diffStyle: layout,
  diffIndicators: "classic",
  hunkSeparators: "metadata",
  lineDiffType: "word-alt",
  stickyHeader: true,
  overflow: "scroll",
});

/**
 * Where code scrolls: the virtualizer draws only the lines of its files
 * and diffs in sight of it.
 */
export const CodeScroller = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <Virtualizer className={className} contentClassName="flex flex-col">
    {children}
  </Virtualizer>
);

const finalNewline = /\n$/u;

/**
 * A file's text, highlighted, numbered line by line. Its last newline ends
 * its last line: the view draws no empty line after it, so its numbers end
 * where the file's lines do.
 */
export const CodeFile = ({ path, text }: { path: string; text: string }) => (
  <File
    file={{ name: path, contents: text.replace(finalNewline, "") }}
    options={fileOptions}
  />
);

/**
 * `text` ending in a newline, unless it is empty: an empty file has no
 * line to end, and a newline would draw one. A diff of such texts never has the
 * library's "No newline at end of file" marker, which it draws in English
 * only; a change of the final newline alone is the page's to say
 * (`onlyFinalNewline`).
 */
const ended = (text: string): string =>
  text === "" || text.endsWith("\n") ? text : `${text}\n`;

/** The lines of `text`; its last newline ends a line, not starts one. */
const lineCount = (text: string): number =>
  text === "" ? 0 : ended(text).split("\n").length - 1;

/** The lines a diff of `diff` compares: its old and new lines together. */
export const comparedLines = (diff: FileDiff): number =>
  (diff.change === "added" ? 0 : lineCount(diff.before)) +
  (diff.change === "deleted" ? 0 : lineCount(diff.after));

/** Whether `diff` changes nothing but whether its file ends in a newline. */
export const onlyFinalNewline = (diff: FileDiff): boolean =>
  diff.change === "modified" && ended(diff.before) === ended(diff.after);

/** How a file changed: an added one all added, a deleted one all removed. */
export const CodeDiff = ({
  diff,
  layout,
}: {
  diff: FileDiff;
  layout: DiffLayout;
}) => {
  const options = diffOptions(layout);
  const { path } = diff;
  if (diff.change === "added") {
    return (
      <MultiFileDiff
        newFile={{ name: path, contents: ended(diff.after) }}
        oldFile={null}
        options={options}
      />
    );
  }
  if (diff.change === "deleted") {
    return (
      <MultiFileDiff
        newFile={null}
        oldFile={{ name: path, contents: ended(diff.before) }}
        options={options}
      />
    );
  }
  return (
    <MultiFileDiff
      newFile={{ name: path, contents: ended(diff.after) }}
      oldFile={{ name: path, contents: ended(diff.before) }}
      options={options}
    />
  );
};

/** The icon of a file's type, by its extension. */
const iconsByExtension: Readonly<Record<string, LucideIcon>> = {
  ts: FileCodeIcon,
  tsx: FileCodeIcon,
  mts: FileCodeIcon,
  js: FileCodeIcon,
  jsx: FileCodeIcon,
  mjs: FileCodeIcon,
  sql: FileCodeIcon,
  html: FileCodeIcon,
  json: FileBracesIcon,
  yaml: FileBracesIcon,
  yml: FileBracesIcon,
  md: FileTextIcon,
  txt: FileTextIcon,
  css: FileTypeIcon,
  svg: FileImageIcon,
};

/** The icon of the file at `path`, a plain file's for a type it doesn't know. */
const fileIconOf = (path: string): LucideIcon => {
  const dot = path.lastIndexOf(".");
  return (
    (dot === -1 ? undefined : iconsByExtension[path.slice(dot + 1)]) ?? FileIcon
  );
};

/** The icon of the file at `path`'s type, for the eye alone. */
export const PathIcon = ({
  path,
  className,
}: {
  path: string;
  className?: string;
}) => createElement(fileIconOf(path), { "aria-hidden": true, className });
