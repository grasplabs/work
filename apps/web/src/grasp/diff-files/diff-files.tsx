// DiffFiles: what changes across several files, as a publish or an agent's edit makes it. One block
// per file: a head with its path (the folder quiet, the file's name strong, cut from the start so
// the name stays), its kind of change in a quiet mark and its counts (the one pair in colour), then its lines on Diff's own engine, unified,
// with hunk heads as git writes them and long lines kept whole, scrolling sideways inside the file.
// A press on the head folds the file; a big one opens folded. A line on top counts it all.
//
// Learned from GitHub's and GitLab's file lists in a pull request (the head per file, the counts,
// a big file folded), and drawn the product's way before it (`@pierre/diffs`: unified, +/- marks,
// `@@` heads, words marked within a line, sideways scroll).
//
//   <DiffFiles files={[{ path: "apps/web/src/routes/index.tsx", change: "modified", before, after }]} />
//
// Every value is a token (src/tokens). Words through GraspWords and `words`.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { Badge } from "../badge";
import { compare } from "../diff/compute";
import { DiffLines } from "../diff/diff";
import type { DiffWords } from "../diff/diff";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, Icon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { diffFilesWords } from "./words";

/** One file's change, whole texts and no patch: the part works out the lines and the counts. */
export type FileDiff =
  | { path: string; change: "added"; after: string }
  | { path: string; change: "deleted"; before: string }
  | { path: string; change: "modified"; before: string; after: string };

/** What a caller may style: where the list sits and how wide it is. Never its look. */
export type DiffFilesLayoutStyle = LayoutStyle;

/** Every word a DiffFiles shows or says, so a product can translate them. */
export interface DiffFilesWords {
  /** A file's mark when it is new. */
  added: string;
  /** A file's mark when it is gone. */
  deleted: string;
  /** A file's mark when it changed. */
  modified: string;
  /** The line on top: "3 files changed". */
  filesChanged: (files: number) => string;
  /** A count, said: "7 lines added, 5 removed". */
  counts: (added: number, removed: number) => string;
  /** Shown when there are no files. */
  nothing: string;
}

/** Every prop a DiffFiles takes. */
export interface DiffFilesProps {
  /** The files that change, in the order they are shown. */
  files: readonly FileDiff[];
  /**
   * The line on top: how many files changed, and the lines added and removed in all. Leave it on
   * unless the page already says them.
   * @default true
   */
  total?: boolean;
  /**
   * A file with more changed lines than this opens folded, so a big file does not bury the rest.
   * Its head still opens it.
   * @default 400
   */
  foldFrom?: number;
  /**
   * Unchanged lines kept round each change before the rest fold away.
   * @default 3
   */
  context?: number;
  /**
   * A hunk's head, `@@ -12,7 +12,8 @@` as git writes it, before each run of a file's lines.
   * @default true
   */
  hunks?: boolean;
  /**
   * Long lines wrap under their own start. False keeps each line whole, the lines scrolling sideways
   * inside the file under its pinned numbers.
   * @default false
   */
  wrap?: boolean;
  /** Its name for a screen reader. @default "What changes" */
  "aria-label"?: string;
  /** This instance's own words, over the catalogue's (GraspWords), key by key. The files' lines take Diff's own. */
  words?: Partial<DiffFilesWords>;
  /** Diff's words for the files' lines ("Show 24 unchanged lines"), over the catalogue's. */
  diffWords?: Partial<DiffWords>;
  /** Layout only: margins, alignment and width. */
  layout?: DiffFilesLayoutStyle;
}

const styles = stylex.create({
  list: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space3,
    width: "100%",
    minWidth: 0,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
  },
  // The line on top: the files changed, then the lines added and removed.
  total: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: grasp.space3,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  // One file: its head and its lines in one box, the box Diff draws on its own.
  file: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    overflow: "hidden",
    borderRadius: `min(${grasp.corner}, ${grasp.space4})`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  // The file's head: the whole row is the button that folds it.
  head: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    width: "100%",
    minWidth: 0,
    minHeight: { default: null, [media.coarse]: grasp.tap },
    margin: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderWidth: 0,
    backgroundColor: "transparent",
    backgroundImage: {
      default: null,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.ghostFillHover}, ${grasp.ghostFillHover})`,
      },
    },
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
    cursor: "pointer",
  },
  // Open, a line under the head parts it from the lines.
  headOpen: {
    borderBlockEndWidth: grasp.separatorWidth,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // The head's ring stands inside the box, so the box's corners do not cut it.
  ring: { outlineOffset: `calc(-2 * ${grasp.ringWidth})` },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
    transitionProperty: "transform",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    transform: "rotate(-0.25turn)",
  },
  chevronOpen: { transform: "none" },
  // The path: the folder quiet and cut from its start, the file's name strong and whole.
  path: {
    display: "flex",
    minWidth: 0,
    flex: "1 1 auto",
    fontFamily: grasp.fontMono,
  },
  // A path reads left to right in every language; laid right to left, its overflow is cut at the
  // start, so the end of the folder (the part beside the name) stays.
  folder: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    direction: "rtl",
    color: grasp.muted,
  },
  name: {
    flexShrink: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: grasp.weightMedium,
  },
  // The mark keeps its word whole: the path gives way, never the mark.
  mark: { display: "inline-flex", flexShrink: 0, whiteSpace: "nowrap" },
  counts: {
    display: "flex",
    flexShrink: 0,
    gap: grasp.space2,
    fontVariantNumeric: "tabular-nums",
  },
  plus: { color: grasp.success, fontWeight: grasp.weightMedium },
  minus: { color: grasp.danger, fontWeight: grasp.weightMedium },
  empty: {
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

/** A file's two texts: an added file was nothing before, a deleted one is nothing after. */
const textsOf = (file: FileDiff) => {
  if (file.change === "added") {
    return { before: "", after: file.after };
  }
  if (file.change === "deleted") {
    return { before: file.before, after: "" };
  }
  return { before: file.before, after: file.after };
};

/** Its lines added and removed, on Diff's own engine. */
const countsOf = (file: FileDiff) => {
  const { before, after } = textsOf(file);
  const { lines } = compare(before, after);
  return {
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
  };
};

/** "apps/web/src/routes/index.tsx" as its folder ("apps/web/src/routes/") and its name ("index.tsx"). */
const partsOf = (path: string) => {
  const cut = path.lastIndexOf("/") + 1;
  return { folder: path.slice(0, cut), name: path.slice(cut) };
};

/** `+7 −5`, a side that is 0 left out ("+15" for a new file), and said in words. */
const Counts = ({
  added,
  removed,
  said,
}: {
  added: number;
  removed: number;
  said: string;
}) => (
  <span {...stylex.props(styles.counts)}>
    {added > 0 ? (
      <span aria-hidden="true" {...stylex.props(styles.plus)}>
        +{added}
      </span>
    ) : null}
    {removed > 0 ? (
      <span aria-hidden="true" {...stylex.props(styles.minus)}>
        −{removed}
      </span>
    ) : null}
    <span {...stylex.props(visuallyHidden)}>{said}</span>
  </span>
);

interface FileProps {
  hunks: boolean;
  wrap: boolean;
  file: FileDiff;
  added: number;
  removed: number;
  foldFrom: number;
  context: number;
  words: DiffFilesWords;
  diffWords: Partial<DiffWords> | undefined;
}

/** One file: its head, which folds it, and its lines. */
const File = ({
  file,
  added,
  removed,
  foldFrom,
  context,
  hunks,
  wrap,
  words,
  diffWords,
}: FileProps) => {
  const [open, setOpen] = useState(added + removed <= foldFrom);
  const id = useId();
  const { folder, name } = partsOf(file.path);
  const { before, after } = textsOf(file);
  return (
    <section
      data-slot="diff-files-file"
      data-change={file.change}
      aria-label={file.path}
      {...stylex.props(styles.file)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        data-slot="diff-files-head"
        onClick={() => {
          setOpen((was) => !was);
        }}
        {...stylex.props(
          styles.head,
          open && styles.headOpen,
          focus.inside,
          styles.ring
        )}
      >
        <span
          aria-hidden="true"
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
        >
          <Icon icon={ChevronDown} />
        </span>
        <span dir="ltr" {...stylex.props(styles.path)}>
          {folder === "" ? null : (
            <span {...stylex.props(styles.folder)}>
              <bdi dir="ltr">{folder}</bdi>
            </span>
          )}
          <span {...stylex.props(styles.name)}>{name}</span>
        </span>
        <span {...stylex.props(styles.mark)}>
          <Badge size="sm">{words[file.change]}</Badge>
        </span>
        <Counts
          added={added}
          removed={removed}
          said={words.counts(added, removed)}
        />
      </button>
      <div id={id} hidden={!open}>
        {open ? (
          <DiffLines
            before={before}
            after={after}
            title={file.path}
            hunks={hunks}
            wrap={wrap}
            context={context}
            words={diffWords}
          />
        ) : null}
      </div>
    </section>
  );
};

/** What changes across several files: a block per file, and a line on top counting it all. */
export const DiffFiles = ({
  files,
  total = true,
  foldFrom = 400,
  context = 3,
  hunks = true,
  wrap = false,
  "aria-label": labelGiven,
  words: wordsGiven,
  diffWords,
  layout,
}: DiffFilesProps) => {
  const { name: label, ...words } = withGiven(
    useWords("diffFiles", diffFilesWords, wordsGiven),
    { name: labelGiven }
  );
  const counted = files.map((file) => ({ file, ...countsOf(file) }));
  const added = counted.reduce((sum, each) => sum + each.added, 0);
  const removed = counted.reduce((sum, each) => sum + each.removed, 0);
  return (
    <section
      aria-label={label}
      data-slot="diff-files"
      {...stylex.props(styles.list, layout)}
    >
      {files.length === 0 ? (
        <p {...stylex.props(styles.empty)}>{words.nothing}</p>
      ) : null}
      {total && files.length > 0 ? (
        <p data-slot="diff-files-total" {...stylex.props(styles.total)}>
          <span>{words.filesChanged(files.length)}</span>
          <Counts
            added={added}
            removed={removed}
            said={words.counts(added, removed)}
          />
        </p>
      ) : null}
      {counted.map(({ file, added: fileAdded, removed: fileRemoved }) => (
        <File
          key={file.path}
          file={file}
          added={fileAdded}
          removed={fileRemoved}
          foldFrom={foldFrom}
          context={context}
          hunks={hunks}
          wrap={wrap}
          words={words}
          diffWords={diffWords}
        />
      ))}
    </section>
  );
};
