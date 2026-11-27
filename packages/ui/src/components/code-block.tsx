// CodeBlock: code in an answer or a page, in StyleX on our
// CopyButton. Highlighted by @pierre/highlights' lexers in WebAssembly, loaded when a block is
// first drawn (code-block-highlight.ts), its title and the language's name in a header over it, a
// copy button that copies the code exactly and a download button that saves it as a file, line
// numbers and wrapping as options, highlighted, added and removed lines, and long code folded under
// Show more. While it is still being written, the header says so, quietly, and the code grows in
// place, drawn at most once a frame, each line coloured once a newline ends it.
//
//   <CodeBlock language="ts">
//     <CodeBlockHeader>
//       <CodeBlockTitle>src/report.ts</CodeBlockTitle>
//       <CodeBlockActions>
//         <CodeBlockDownloadButton value={source} />
//         <CodeBlockCopyButton value={source} />
//       </CodeBlockActions>
//     </CodeBlockHeader>
//     <CodeBlockContent lineNumbers>{source}</CodeBlockContent>
//   </CodeBlock>
//
// CodeBlockContent highlights its code given as text, in the block's language. To mark lines, give
// it CodeBlockLines instead: `useHighlightedCode` gives the highlighted lines to map over. The
// block is a region named by its title, or by its language without one. The code is drawn as
// text from the lexers' runs, never as HTML. Every value is a token. A caller sets layout only
// (`style`).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { markScrollEdges, useScrollEdges } from "../hooks/use-scroll-edges";
import { useI18n } from "../lib/i18n";
import { DownloadIcon, Icon } from "../lib/icons";
import {
  codeStyles,
  focusCarrier,
  scrollbarHidden,
  syntaxStyles,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { listOf, nothing, ownValue, saveFile } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, ringInsetMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import {
  colouredRuns,
  currentEngine,
  doneLines,
  languages,
  MOST_RUNS,
  newReading,
  noEngine,
  plainLines,
  watchEngine,
  writtenLines,
} from "./code-block-highlight";
import type { Line, Run } from "./code-block-highlight";
import { codeBlockVars } from "./code-block.stylex";
import { CopyButton } from "./copy-button";
import { Spinner } from "./spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Every prop a CodeBlock takes. */
export interface CodeBlockProps {
  /** Its CodeBlockHeader, CodeBlockContent and CodeBlockFooter; or CodeBlockActions alone, over the code. */
  children: ReactNode;
  /**
   * `destructive` for an error's output: the edge and the header in the destructive colour.
   * @default "default"
   */
  variant?: "default" | "destructive";
  /**
   * `sm` sets the code a step smaller, for a block inside a card or a step.
   * @default "default"
   */
  size?: "default" | "sm";
  /**
   * Its language, by its name or the usual short one: `tsx`, `ts`, `js`, `json`, `bash`,
   * `python`, `css`, `html`, `markdown`, `yaml`, `sql`, `diff`, `go`, `rust`, or any other the
   * lexers know. Another shows as plain text. It colours CodeBlockContent's code and is named in
   * CodeBlockTitle.
   * @default "text"
   */
  language?: string;
  /** The language's name in the header, where the usual one would not do. */
  languageName?: string;
  /**
   * It is still being written: the header says so in words, copying waits, nothing folds, and
   * the code grows in place, drawn at most once a frame.
   * @default false
   */
  streaming?: boolean;
  /**
   * A Spinner beside the header's words while it is written. Off by default: the words say it.
   * @default false
   */
  showStreamingIndicator?: boolean;
  /** Its name, when it has no CodeBlockTitle to name it ("Install command"). */
  "aria-label"?: string;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a CodeBlockHeader takes. */
export interface CodeBlockHeaderProps {
  /** Its CodeBlockTitle and CodeBlockActions. */
  children: ReactNode;
}

/** Every prop a CodeBlockTitle takes. */
export interface CodeBlockTitleProps {
  /**
   * A title, such as a file name (`src/report.ts`), with the language's name beside it. Without
   * one, the language's name is the title.
   */
  children?: ReactNode;
}

/** Every prop a CodeBlockActions takes. */
export interface CodeBlockActionsProps {
  /**
   * Ghost icon Buttons of the copy button's size (`size="icon-sm"`), such as Download, and the
   * CodeBlockCopyButton last. In a CodeBlockHeader they stand at its end, and stay on a phone
   * while the title gives way; straight in a CodeBlock they stand over the code's corner, shown
   * under a pointer or focus.
   */
  children: ReactNode;
}

/** Every prop a CodeBlockCopyButton takes. */
export interface CodeBlockCopyButtonProps {
  /** The code it copies, exactly. */
  value: string;
  /**
   * Out of use. It is, too, while the block is `streaming`.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a CodeBlockDownloadButton takes. */
export interface CodeBlockDownloadButtonProps {
  /** The code it saves, exactly. */
  value: string;
  /**
   * The file's name.
   * @default "file" and the language's extension (`file.ts`), `file.txt` for one it does not know
   */
  filename?: string;
  /**
   * Out of use. It is, too, while the block is `streaming`.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a CodeBlockContent takes. */
export interface CodeBlockContentProps {
  /**
   * The code, as text, highlighted in the block's language; while the block is `streaming`, pass
   * it as it grows. Or its lines, as CodeBlockLines.
   */
  children: ReactNode;
  /**
   * Long lines wrap rather than scroll sideways.
   * @default false
   */
  wrap?: boolean;
  /**
   * Line numbers in a quiet gutter at the start. They are never selected or copied.
   * @default false
   */
  lineNumbers?: boolean;
  /**
   * The first line's number.
   * @default 1
   */
  startLine?: number;
  /**
   * Past this many lines it is folded under Show more. `false` never folds and draws every line,
   * however many: only for code a product knows is bounded and must be read whole (what an action
   * will send), never for a model's output (Markdown keeps the 2,000-line cap).
   * @default 18
   */
  maxLines?: number | false;
}

/** Every prop a CodeBlockLine takes. */
export interface CodeBlockLineProps {
  /** The line's code: text, or the runs `useHighlightedCode` gives. */
  children?: ReactNode;
  /**
   * `highlighted` for a line the answer is about, `added` and `removed` for a change: a wash and
   * a bar at its start, so colour is never the only mark.
   * @default "default"
   */
  variant?: "default" | "added" | "removed" | "highlighted";
}

/** Every prop a CodeBlockFooter takes. */
export interface CodeBlockFooterProps {
  /** What stands under the code, in the middle, such as a Button. */
  children: ReactNode;
}

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;
const HOVER = media.hover;
// With no script, nothing is folded: there would be no Show more to open it.
const NO_SCRIPT = media.noScript;

const breathe = stylex.keyframes({
  from: { opacity: size.spinnerFaint },
  to: { opacity: 1 },
});

const styles = stylex.create({
  box: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    width: "100%",
    // Clipped, never a box that scrolls. On a touch screen the floating copy button, a step in from
    // the corner, keeps its 44px target whole past the edge.
    overflow: "clip",
    overflowClipMargin: {
      default: null,
      [COARSE]: `max(0px, calc((${size.tapTarget} - ${size.controlSm}) / 2 - ${space["1"]}))`,
    },
  },
  // The header: the title or the language at the start, the copy button at the end, a hairline
  // under it, clear of the code. On a touch screen it is a finger tall and the button stands a
  // little further in, so the copy button's 44px press area fits inside the box, which clips.
  header: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minHeight: { default: size.codeBlockHead, [COARSE]: size.tapTarget },
    // The label starts where the code does: past the room every line keeps for a highlighted
    // line's bar.
    paddingInlineStart: `calc(${space["3"]} + ${size.codeBlockBarWidth})`,
    paddingInlineEnd: {
      default: space["1"],
      [COARSE]: `calc((${size.tapTarget} - ${size.controlSm}) / 2)`,
    },
    boxShadow: `inset 0 calc(-1 * ${size.hairline}) 0 ${colors.border}`,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  // One line, cut with an ellipsis when it is too long: the full name is its title.
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    color: colors.bodyForeground,
    fontFamily: font.mono,
  },
  language: {
    flexShrink: 0,
  },
  // An error's output: the edge and the header's words in the destructive colour.
  destructive: {
    boxShadow: `0 0 0 ${size.hairline} ${colors.destructiveBorder}`,
  },
  destructiveHeader: {
    color: colors.destructive,
  },
  // A step smaller, on the same lines.
  small: {
    fontSize: font.textXs,
  },
  // The actions at the header's end, or over the code's corner when there is no header: there,
  // under a pointer or focus on the block, and always on a touch screen.
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["2"]} / 2)`,
    flexShrink: 0,
  },
  floating: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "absolute",
    zIndex: 1,
    top: space["1"],
    insetInlineEnd: space["1"],
    opacity: {
      default: 1,
      [HOVER]: {
        default: 0,
        [stylex.when.ancestor(":hover")]: 1,
        [stylex.when.ancestor(":focus-within")]: 1,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // While the code is still coming in: the word for it breathes, quietly.
  streaming: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    flexShrink: 0,
    animationName: { default: breathe, [REDUCED]: "none" },
    animationDuration: size.skeletonPulse,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
    animationDirection: "alternate",
  },

  // The code. Lines too wide scroll sideways in here, never the page; it takes keyboard focus for
  // that when they do. Code reads left to right in every language: in a right-to-left page it
  // still starts at the left edge, its punctuation where it was written.
  content: {
    position: "relative",
    direction: "ltr",
    textAlign: "left",
    minWidth: 0,
    overflowX: "auto",
    overflowY: "hidden",
    paddingBlock: space["3"],
    fontFamily: font.mono,
    fontSize: font.textSm,
    lineHeight: font.codeBlockLine,
    tabSize: 2,
    // The edge with more beyond it fades (marked by useScrolls), and the foot while it is folded.
    // Both at once: the two masks intersect.
    [codeBlockVars.start]: {
      default: "0px",
      ":is([data-under-start])": space["6"],
    },
    [codeBlockVars.end]: {
      default: "0px",
      ":is([data-under-end])": space["6"],
    },
    maskImage: `linear-gradient(to right, transparent, black ${codeBlockVars.start}, black calc(100% - ${codeBlockVars.end}), transparent), linear-gradient(to bottom, black calc(100% - ${codeBlockVars.foot}), transparent)`,
    maskComposite: "intersect",
    // A layer of its own: WebKit otherwise paints each run of coloured code through the box's
    // rounded clip, and a screen of them takes a tenth of a second; on its layer, a few ms.
    willChange: "transform",
  },
  // Cut at `maxLines`, with a fade, until Show more.
  folded: {
    maxHeight: { default: codeBlockVars.height, [NO_SCRIPT]: "none" },
    [codeBlockVars.foot]: {
      default: size.codeBlockFade,
      [NO_SCRIPT]: "0px",
    },
  },
  // The ring of the code that scrolls, while it has the keyboard's focus: a part of its own laid
  // round the whole block, header and code, in the block's own corners and just inside its edge.
  // Not on the scroller: its mask would fade it, and its top would lie square on the header's line.
  ring: {
    position: "absolute",
    inset: 0,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    pointerEvents: "none",
    outlineWidth: {
      default: size.ringWidth,
      [FORCED]: `calc(2 * ${size.lineStrong})`,
    },
    outlineColor: { default: colors.ring, [FORCED]: "Highlight" },
    outlineStyle: { default: "none", ":is(:focus-visible + *)": "solid" },
    outlineOffset: {
      default: `calc(-1 * ${size.ringWidth})`,
      [FORCED]: `calc(-2 * ${size.lineStrong})`,
    },
  },
  code: {
    display: "block",
    width: "max-content",
    minWidth: "100%",
    margin: 0,
    fontFamily: "inherit",
  },
  wrapped: {
    width: "auto",
  },
  // Every line has room for the bar at its start, so a highlighted one does not move.
  line: {
    display: "flex",
    borderInlineStartWidth: size.codeBlockBarWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: "transparent",
    minHeight: font.codeBlockLine,
    paddingInlineEnd: space["3"],
    whiteSpace: "pre",
  },
  lineWrapped: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // A highlighted line: a wash and a bar at its start, so colour is never the only mark; an added
  // or removed one, the diff's wash and the bar in its colour.
  highlighted: {
    backgroundColor: colors.codeBlockMarked,
    borderInlineStartColor: colors.codeBlockMarkedBar,
  },
  added: {
    backgroundColor: colors.diffViewerAddedBg,
    borderInlineStartColor: colors.syntaxInserted,
  },
  removed: {
    backgroundColor: colors.diffViewerRemovedBg,
    borderInlineStartColor: colors.syntaxDeleted,
  },
  // The line numbers: quiet, never selected or copied.
  number: {
    flexShrink: 0,
    boxSizing: "content-box",
    paddingInlineStart: space["3"],
    paddingInlineEnd: space["4"],
    textAlign: "end",
    color: colors.codeBlockGutter,
    userSelect: "none",
    fontVariantNumeric: "tabular-nums",
    minWidth: codeBlockVars.digits,
    counterIncrement: "code-block-line",
    "::before": {
      content: "counter(code-block-line)",
    },
  },
  // Without numbers, the code keeps its room at the start.
  bare: {
    paddingInlineStart: space["3"],
  },
  text: {
    minWidth: 0,
  },
  // How many lines are not drawn, under the last that is: quiet, in the words' face.
  more: {
    margin: 0,
    paddingBlockStart: space["2"],
    paddingInline: space["3"],
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },

  // What stands at the foot, in the middle: Show more and Show less.
  foot: {
    display: "flex",
    justifyContent: "center",
    paddingBlockEnd: space["3"],
  },
  // With no script there is no Show more: nothing is folded.
  scripted: {
    display: { default: "flex", [NO_SCRIPT]: "none" },
  },
});

const dynamic = stylex.create({
  foldAt: (lines: number) => ({
    [codeBlockVars.height]: `calc(${lines} * ${font.codeBlockLine} + ${space["3"]})`,
  }),
  // The numbers' column as wide as the widest, and the count they start from.
  numbering: (digits: number, before: number) => ({
    [codeBlockVars.digits]: `${digits}ch`,
    counterReset: `code-block-line ${before}`,
  }),
});

/**
 * At most this many lines are drawn while the block is open (and before the page is live, or with
 * no script): past them, a line says how many more there are. Copy still takes all of the code.
 */
const MOST_DRAWN = 2000;

/** Where the line after `count` lines of `code` starts. */
const afterLines = (code: string, count: number) => {
  let at = 0;
  for (let line = 0; line < count && at !== -1; line += 1) {
    at = code.indexOf("\n", at);
    at = at === -1 ? code.length : at + 1;
  }
  return at;
};

/**
 * `code`'s first `most` lines, coloured, the rest of them text: all of it text until the lexers
 * have loaded, where they cannot, in a language they do not know, and when the lines are more than
 * MOST_RUNS coloured runs (never the 18 lines a folded block shows: see MOST_LINE). While it is
 * written, the lines a newline has ended are coloured, each once, as they come, and the last is
 * text until its newline comes: never coloured in one frame and plain in the next.
 */
const useLinesOf = (
  code: string,
  language: string,
  streaming: boolean,
  most: number
): (Line | string)[] => {
  const engine = useSyncExternalStore(watchEngine, currentEngine, noEngine);
  // oxlint-disable-next-line react/hook-use-state -- made once, never replaced
  const [reading] = useState(newReading);
  if (engine === null || code === "") {
    return plainLines(code, most);
  }
  if (streaming) {
    const lines = writtenLines(reading, engine, code, language, most);
    return lines === null
      ? plainLines(code, most)
      : [
          ...lines,
          ...plainLines(
            code.slice(afterLines(code, lines.length)),
            most - lines.length
          ),
        ];
  }
  const lines = doneLines(reading, engine, code, language, most);
  return lines === null || colouredRuns(lines) > MOST_RUNS
    ? plainLines(code, most)
    : lines;
};

/**
 * `code` as it is, or while it streams, as it was at the last frame: a fence that grows by many
 * chunks a frame is read and drawn once a frame, not once a chunk.
 */
const useOncePerFrame = (code: string, streaming: boolean): string => {
  const [shown, setShown] = useState(code);
  // When writing starts again, the code it starts from shows at once: never the code of the last
  // frame drawn while it was written before.
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    if (streaming) {
      setShown(code);
    }
  }
  const latest = useRef(code);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    latest.current = code;
    if (!streaming || frame.current !== null) {
      return;
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setShown(latest.current);
    });
  }, [code, streaming]);
  useEffect(
    () => () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
      }
    },
    []
  );
  return streaming ? shown : code;
};

/**
 * Whether Show more has been pressed. Code that was shown as it was written stays open once it is
 * done, so the page never jumps up; Show less folds it.
 */
const useOpen = (streaming: boolean) => {
  const [open, setOpen] = useState(false);
  // Opened in the render the writing ends in, never a frame later: no frame draws it folded, and
  // its lines are read once, for the open block.
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    if (wasStreaming) {
      setOpen(true);
    }
  }
  return [open, setOpen] as const;
};

/**
 * The scroller, and whether its lines are wider than it: then it takes focus, so the keys can scroll
 * it. Which of its edges has more beyond it is marked as an attribute its style reads (the fade
 * there), never a render per scroll.
 */
const useScrolls = () => {
  const [scrolls, setScrolls] = useState(false);
  // Measured by the observer only: it reports each box once when it starts watching, after the
  // page is laid out, so a block that mounts while an answer streams forces no layout of its own.
  // The lines' own box too: it changes with the code, and when wrapping is turned on or off.
  const scroller = useScrollEdges({
    onChange: (edges, element) => {
      setScrolls(edges.overflows);
      markScrollEdges(edges, element);
    },
  });
  return { scroller, scrolls };
};

interface Block {
  /** The id of what names the block: its title, or its language's name. */
  nameId: string;
  /** Its name, when given in words. */
  label: string | undefined;
  language: string;
  languageName: string | undefined;
  streaming: boolean;
  showStreamingIndicator: boolean;
  variant: "default" | "destructive";
  small: boolean;
}

const BlockContext = createContext<Block | null>(null);
// Whether CodeBlockActions stand in a header, or over the code.
const InHeader = createContext(false);
// How the content draws its lines.
const LinesContext = createContext<{ lineNumbers: boolean; wrap: boolean }>({
  lineNumbers: false,
  wrap: false,
});

const useBlock = (part: string): Block => {
  const block = use(BlockContext);
  if (block === null) {
    throw new Error(`${part} must be inside a CodeBlock.`);
  }
  return block;
};

/**
 * A line's runs, each in its colour. A component of its own, so the compiler keeps what it drew for
 * as long as the line is the same object (code-block-highlight.ts keeps it one while the code is
 * written and once it is done): a line already coloured is never drawn again while later lines
 * are coloured or more code comes in. DiffViewer draws its runs the same way (its colouredText).
 */
const LineRuns = ({ line }: { line: Line }) => (
  <>
    {line.map((run, at) =>
      // A run with no colour is its text alone: a long file draws thousands fewer elements.
      run.tone === null ? (
        run.text
      ) : (
        // A run has no id; its place in the line is its key, and runs never reorder.
        <span key={at} {...stylex.props(syntaxStyles[run.tone])}>
          {run.text}
        </span>
      )
    )}
  </>
);

/**
 * `code` highlighted in `language`, as lines of coloured runs to give CodeBlockLines: plain until
 * the lexers have loaded, and where they cannot; plain, all of it, past MOST_RUNS coloured runs.
 * While `streaming`, the code shown is drawn at most once a frame, each line coloured once its
 * newline comes.
 */
export const useHighlightedCode = (
  code: string,
  language: string,
  streaming = false
): ReactNode[] =>
  useLinesOf(
    useOncePerFrame(code, streaming),
    language,
    streaming,
    Number.POSITIVE_INFINITY
  ).map((line, index) =>
    typeof line === "string" ? (
      line
    ) : (
      // Lines have no id; a line's place is its key.
      <LineRuns key={index} line={line} />
    )
  );

/** One run of highlighted code: its text, and the syntax colour it takes (a key of lib's `syntaxStyles`), none for the code's own. */
export type HighlightedToken = Run;

// A part given no language never loads the lexers.
const unwatched = () => () => {
  // Nothing was watched; nothing to stop.
};

/**
 * `code` read in `language` by CodeBlock's lexers, whole, for a part that draws code its own way
 * (DiffViewer's lines): its lines, each a list of runs in their syntax colours. null with no
 * language, until the lexers have loaded (the first call loads them), where they cannot, and for a
 * language they do not know. The code is read again only when it changes.
 */
export const useHighlightedTokens = (
  code: string,
  language: string | undefined
): readonly (readonly HighlightedToken[])[] | null => {
  const engine = useSyncExternalStore(
    language === undefined ? unwatched : watchEngine,
    currentEngine,
    noEngine
  );
  // oxlint-disable-next-line react/hook-use-state -- made once, never replaced
  const [reading] = useState(newReading);
  if (engine === null || language === undefined) {
    return null;
  }
  return doneLines(reading, engine, code, language, Number.POSITIVE_INFINITY);
};

/** Code, highlighted, with its title and language over it, a copy button, and Show more when it is long. */
export const CodeBlock = ({
  children,
  variant = "default",
  size: sized = "default",
  language = "text",
  languageName,
  streaming = false,
  showStreamingIndicator = false,
  "aria-label": label,
  style,
}: CodeBlockProps) => {
  const nameId = useId();
  return (
    <section
      aria-label={label}
      aria-labelledby={label === undefined ? nameId : undefined}
      data-slot="code-block"
      data-variant={variant}
      data-size={sized}
      data-streaming={streaming || undefined}
      {...stylex.props(
        codeStyles.surface,
        styles.box,
        variant === "destructive" && styles.destructive,
        stylex.defaultMarker(),
        ringInsetMarker,
        style
      )}
    >
      <BlockContext
        // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
        value={{
          nameId,
          label,
          language,
          languageName,
          streaming,
          showStreamingIndicator,
          variant,
          small: sized === "sm",
        }}
      >
        {children}
      </BlockContext>
    </section>
  );
};

/** The header over the code: its title at the start, its actions at the end, a hairline under it. */
export const CodeBlockHeader = ({ children }: CodeBlockHeaderProps) => {
  const { variant } = useBlock("CodeBlockHeader");
  return (
    <div
      data-slot="code-block-header"
      {...stylex.props(
        styles.header,
        variant === "destructive" && styles.destructiveHeader
      )}
    >
      <InHeader value>{children}</InHeader>
    </div>
  );
};

/**
 * The title, cut with an ellipsis when it is too long (the full one is its tooltip), and the
 * language's name beside it; and, while the code is written, the words that say so.
 */
export const CodeBlockTitle = ({ children }: CodeBlockTitleProps) => {
  const words = useI18n().codeBlock;
  const { nameId, language, languageName, streaming, showStreamingIndicator } =
    useBlock("CodeBlockTitle");
  const titled = children !== undefined && children !== null && children !== "";
  const key = language.toLowerCase();
  const name =
    languageName ??
    (key === "text" ? words.plainText : ownValue(languages, key)?.name) ??
    language;
  return (
    <>
      {titled ? (
        <span
          id={nameId}
          data-slot="code-block-title"
          title={typeof children === "string" ? children : undefined}
          {...stylex.props(styles.name)}
        >
          {children}
        </span>
      ) : null}
      <span
        id={titled ? undefined : nameId}
        data-slot={titled ? undefined : "code-block-title"}
        {...stylex.props(styles.language, !titled && styles.name)}
      >
        {name}
      </span>
      {/* Always in the page, so a screen reader hears it start; empty once the code is written. */}
      <output {...stylex.props(streaming ? styles.streaming : visuallyHidden)}>
        {streaming && showStreamingIndicator && <Spinner />}
        {streaming ? words.streaming : ""}
      </output>
    </>
  );
};

/** The block's actions: at the header's end, or over the code's corner. */
export const CodeBlockActions = ({ children }: CodeBlockActionsProps) => (
  <span
    data-slot="code-block-actions"
    {...stylex.props(styles.actions, !use(InHeader) && styles.floating)}
  >
    {children}
  </span>
);

/** Copies the code exactly, and says so once. It waits while the code is written. */
export const CodeBlockCopyButton = ({
  value,
  disabled = false,
}: CodeBlockCopyButtonProps) => {
  const { streaming } = useBlock("CodeBlockCopyButton");
  return <CopyButton value={value} disabled={disabled || streaming} />;
};

/** Saves the code as a file, in the block's language. It waits while the code is written. */
export const CodeBlockDownloadButton = ({
  value,
  filename,
  disabled = false,
}: CodeBlockDownloadButtonProps) => {
  const words = useI18n().codeBlock;
  const { language, streaming } = useBlock("CodeBlockDownloadButton");
  const extension =
    ownValue(languages, language.toLowerCase())?.extension ?? "txt";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={words.download}
          disabled={disabled || streaming}
          onClick={() => {
            saveFile(value, filename ?? `file.${extension}`, "text/plain");
          }}
        >
          <Icon icon={DownloadIcon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{words.download}</TooltipContent>
    </Tooltip>
  );
};

/** Whether a line has no code in it: nothing given, no text, or no runs. */
const isBlank = (line: ReactNode) =>
  Array.isArray(line) ? line.length === 0 : (line ?? "") === "";

/**
 * One line of code, its number before it when the content numbers its lines. A blank line is drawn
 * as its line break: with nothing in it, a selection copied across it would lose the line.
 */
export const CodeBlockLine = ({
  children,
  variant = "default",
}: CodeBlockLineProps) => {
  const { lineNumbers, wrap } = use(LinesContext);
  return (
    <span
      data-slot="code-block-line"
      data-variant={variant}
      {...stylex.props(
        styles.line,
        wrap && styles.lineWrapped,
        variant === "highlighted" && styles.highlighted,
        variant === "added" && styles.added,
        variant === "removed" && styles.removed
      )}
    >
      <span
        aria-hidden="true"
        {...stylex.props(lineNumbers ? styles.number : styles.bare)}
      />
      <span {...stylex.props(styles.text)}>
        {isBlank(children) ? "\n" : children}
      </span>
    </span>
  );
};

/** Show more and Show less, at the foot: gone with no script, where nothing folds. */
const ShowMore = ({
  open,
  controls,
  onToggle,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
}) => {
  const words = useI18n().codeBlock;
  return (
    <div {...stylex.props(styles.foot, styles.scripted)}>
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        {open ? words.collapse : words.expand}
      </Button>
    </div>
  );
};

/** How many lines code has, as linesOf reads it: a last newline ends a line, not starts one. */
const countLines = (code: string) => {
  let count = 1;
  for (
    let at = code.indexOf("\n");
    at !== -1 && at < code.length - 1;
    at = code.indexOf("\n", at + 1)
  ) {
    count += 1;
  }
  return count;
};

const noWatch = () => nothing;
const live = () => true;
const notLive = () => false;

/**
 * A line CodeBlockContent draws from its code: kept by the compiler while the line is the same, so
 * it is not drawn again when the lines after it change.
 */
const HighlightedLine = ({ line }: { line: Line | string }) => (
  <CodeBlockLine>
    {typeof line === "string" ? line : <LineRuns line={line} />}
  </CodeBlockLine>
);

/**
 * The content's lines: how many there are, and those drawn, at most `drawn` of `fold`: its code
 * highlighted, a CodeBlockLine each; or the CodeBlockLines given. Only the lines drawn are made.
 */
const useLines = (
  children: ReactNode,
  language: string,
  streaming: boolean,
  fold: (count: number) => { drawn: number }
) => {
  const given = typeof children === "string";
  const parts = given ? [] : listOf(children);
  const count = given ? countLines(children) : parts.length;
  const { drawn } = fold(count);
  const shown = useOncePerFrame(given ? children : "", streaming);
  const highlighted = useLinesOf(shown, language, streaming, drawn);
  return {
    count,
    lines: given
      ? highlighted.map((line, index) => (
          // Lines have no id; a line's place is its key.
          <HighlightedLine key={index} line={line} />
        ))
      : parts.slice(0, drawn),
  };
};

/**
 * Whether Show more has opened it, and for a count of lines: whether it folds, where (null when
 * every line shows), how many lines are drawn and how many are not. Folded, once the page is live,
 * only the lines that show are drawn; else at most MOST_DRAWN (every line when it never folds),
 * and a line says how many more. With no script nothing folds, so until the page is live it draws
 * as an open block does.
 */
const useFold = (maxLines: number | false, streaming: boolean) => {
  const [open, setOpen] = useOpen(streaming);
  const isLive = useSyncExternalStore(noWatch, live, notLive);
  // Never folded while it is still being written: new lines would arrive under the fade.
  const limit = streaming || maxLines === false ? null : maxLines;
  const linesFor = (count: number) => {
    const folds = limit !== null && count > limit;
    const foldAt = folds && !open ? limit : null;
    const cut = foldAt !== null && isLive;
    // Never folded, it is read whole: every line is drawn.
    const most = maxLines === false ? count : MOST_DRAWN;
    return {
      folds,
      foldAt,
      drawn: cut ? foldAt : most,
      more: cut ? 0 : Math.max(0, count - most),
    };
  };
  return { open, setOpen, linesFor };
};

/**
 * The code, highlighted, in lines that scroll sideways inside it (or wrap), folded under Show more
 * when it is long.
 */
export const CodeBlockContent = ({
  children,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  maxLines = 18,
}: CodeBlockContentProps) => {
  const { nameId, label, language, streaming, small } =
    useBlock("CodeBlockContent");
  const words = useI18n().codeBlock;
  const { open, setOpen, linesFor } = useFold(maxLines, streaming);
  const { count, lines } = useLines(children, language, streaming, linesFor);
  const { folds, foldAt, more } = linesFor(count);
  const { scroller, scrolls } = useScrolls();
  const contentId = useId();
  const digits = String(startLine + count - 1).length;
  return (
    <>
      <div
        ref={scroller}
        id={contentId}
        data-slot="code-block-content"
        data-wrap={wrap || undefined}
        data-numbered={lineNumbers || undefined}
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-label={scrolls ? label : undefined}
        aria-labelledby={scrolls && label === undefined ? nameId : undefined}
        {...stylex.props(
          styles.content,
          small && styles.small,
          scrollbarHidden,
          foldAt !== null && styles.folded,
          foldAt !== null && dynamic.foldAt(foldAt),
          focusCarrier
        )}
      >
        {/* A div, not a pre: the lines carry their own whitespace, and a page's prose rules for
            `pre span` never reach the highlighting. */}
        <div
          {...stylex.props(
            styles.code,
            wrap && styles.wrapped,
            dynamic.numbering(digits, startLine - 1)
          )}
        >
          <code data-language={language}>
            {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
            <LinesContext value={{ lineNumbers, wrap }}>{lines}</LinesContext>
          </code>
        </div>
        {more > 0 && (
          <p {...stylex.props(styles.more)}>{words.moreLines(more)}</p>
        )}
      </div>
      {/* The scroller's ring, round the whole block: shown while the scroller before it has focus. */}
      <span
        aria-hidden="true"
        data-slot="code-block-focus-ring"
        {...stylex.props(styles.ring)}
      />
      {folds && (
        <ShowMore
          open={open}
          controls={contentId}
          onToggle={() => {
            setOpen((now) => !now);
          }}
        />
      )}
    </>
  );
};

/** What stands under the code, in the middle. */
export const CodeBlockFooter = ({ children }: CodeBlockFooterProps) => (
  <div data-slot="code-block-footer" {...stylex.props(styles.foot)}>
    {children}
  </div>
);
