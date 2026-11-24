// CodeBlock: code in an answer or a page, in StyleX on our
// CopyButton. Highlighted with Prism (each language loaded the first time it is shown,
// code-block-prism.ts), its title and the language's name in a header over it, a copy button that
// copies the code exactly, line numbers and wrapping as options, highlighted, added and removed
// lines, and long code folded under Show more. While it is still being written, the header says
// so, quietly, and the code grows in place, read again at most once a frame.
//
//   <CodeBlock language="ts">
//     <CodeBlockHeader>
//       <CodeBlockTitle>src/report.ts</CodeBlockTitle>
//       <CodeBlockActions>
//         <CodeBlockCopyButton value={source} />
//       </CodeBlockActions>
//     </CodeBlockHeader>
//     <CodeBlockContent lineNumbers>{source}</CodeBlockContent>
//   </CodeBlock>
//
// CodeBlockContent highlights its code given as text, in the block's language. To mark lines, give
// it CodeBlockLines instead: `useHighlightedCode` gives the highlighted lines to map over. The
// block is a region named by its title, or by its language without one. The code is drawn as
// text from Prism's tokens, never as HTML. Every value is a token. A caller sets layout only
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
import {
  codeStyles,
  focusCarrier,
  scrollbarHidden,
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
import { listOf, nothing, ownValue } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, ringInsetMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import { grammarOrNull, languageNames, linesOf } from "./code-block-prism";
import type { Highlight } from "./code-block-prism";
import { codeBlockVars } from "./code-block.stylex";
import { CopyButton } from "./copy-button";
import { Spinner } from "./spinner";

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
   * Its language, by Prism's name or the usual short one: `tsx`, `ts`, `js`, `json`, `bash`,
   * `python`, `css`, `html`, `markdown`, `yaml`, `sql`, `diff`, `go`, `rust`. Another shows as
   * plain text. It colours CodeBlockContent's code and is named in CodeBlockTitle.
   * @default "text"
   */
  language?: string;
  /** The language's name in the header, where the usual one would not do. */
  languageName?: string;
  /**
   * It is still being written: the header says so in words, copying waits, nothing folds, and
   * the code grows in place, read again at most once a frame.
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
   * Past this many lines it is folded under Show more. `false` never folds.
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
    overflow: "hidden",
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

  // The colours of the highlighting.
  keyword: { color: colors.syntaxKeyword },
  string: { color: colors.syntaxString },
  constant: { color: colors.syntaxConstant },
  comment: { color: colors.syntaxComment, fontStyle: "italic" },
  function: { color: colors.syntaxFunction },
  punctuation: { color: colors.syntaxPunctuation },
  attribute: { color: colors.syntaxAttribute },
  inserted: { color: colors.syntaxInserted },
  deleted: { color: colors.syntaxDeleted },
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

/** Which colour a run of code takes, from Prism's names for it. */
const tones: Record<string, stylex.StyleXStyles> = {
  keyword: styles.keyword,
  important: styles.keyword,
  atrule: styles.keyword,
  rule: styles.keyword,
  builtin: styles.keyword,
  string: styles.string,
  char: styles.string,
  "template-string": styles.string,
  regex: styles.string,
  url: styles.string,
  "attr-value": styles.string,
  number: styles.constant,
  boolean: styles.constant,
  constant: styles.constant,
  symbol: styles.constant,
  entity: styles.constant,
  comment: styles.comment,
  prolog: styles.comment,
  doctype: styles.comment,
  cdata: styles.comment,
  function: styles.function,
  "class-name": styles.function,
  tag: styles.function,
  selector: styles.function,
  title: styles.function,
  punctuation: styles.punctuation,
  operator: styles.punctuation,
  "attr-name": styles.attribute,
  property: styles.attribute,
  key: styles.attribute,
  parameter: styles.attribute,
  inserted: styles.inserted,
  deleted: styles.deleted,
};

/** The colour of a run: the innermost of Prism's names that has one. */
const toneOf = (types: string[]) =>
  types
    .map((type) => ownValue(tones, type))
    .findLast((found) => found !== undefined) ?? null;

/** Prism and the language's grammar once they have loaded, in the browser; null until then. */
const useHighlight = (language: string): Highlight | null => {
  // The grammar is kept with its language, so code in a new language is never coloured as the old.
  const [loaded, setLoaded] = useState<{
    language: string;
    found: Highlight | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const found = await grammarOrNull(language);
      if (live) {
        setLoaded({ language, found });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [language]);
  return loaded?.language === language ? loaded.found : null;
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
  const streamed = useRef(streaming);
  useEffect(() => {
    if (streaming) {
      streamed.current = true;
    } else if (streamed.current) {
      streamed.current = false;
      setOpen(true);
    }
  }, [streaming]);
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
 * `code` highlighted in `language`, as lines of coloured runs to give CodeBlockLines: plain until
 * Prism and the language have loaded. While `streaming`, read again at most once a frame, however
 * fast the code comes.
 */
export const useHighlightedCode = (
  code: string,
  language: string,
  streaming = false
): ReactNode[] => {
  const highlight = useHighlight(language);
  const shown = useOncePerFrame(code, streaming);
  // The compiler keeps the lines until the code or the grammar changes.
  return linesOf(shown, highlight).map((line) =>
    line.map((run, at) => (
      // A run has no id; its place in the line is its key, and runs never reorder.
      <span key={at} {...stylex.props(toneOf(run.types))}>
        {run.text}
      </span>
    ))
  );
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
    (key === "text" ? words.plainText : ownValue(languageNames, key)) ??
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

/**
 * At most this many lines are drawn while the block is open (and before the page is live, or with
 * no script): past them, a line says how many more there are. Copy still takes all of the code.
 */
const MOST_DRAWN = 2000;

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

/** The first `most` lines of code. */
const firstLines = (code: string, most: number) => {
  let at = -1;
  for (let line = 0; line < most; line += 1) {
    at = code.indexOf("\n", at + 1);
    if (at === -1) {
      return code;
    }
  }
  return code.slice(0, at);
};

const noWatch = () => nothing;
const live = () => true;
const notLive = () => false;

/**
 * The content's lines: how many there are, and those drawn, at most `most`: its code highlighted, a
 * CodeBlockLine each; or the CodeBlockLines given. Only the lines drawn are highlighted and made.
 */
const useLines = (
  children: ReactNode,
  language: string,
  streaming: boolean,
  most: (count: number) => number
) => {
  const given = typeof children === "string";
  const parts = given ? [] : listOf(children);
  const count = given ? countLines(children) : parts.length;
  const drawn = most(count);
  const highlighted = useHighlightedCode(
    given ? firstLines(children, drawn) : "",
    language,
    streaming
  );
  return {
    count,
    lines: given
      ? highlighted.map((line, index) => (
          // Lines have no id; a line's place is its key.
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))
      : parts.slice(0, drawn),
  };
};

/**
 * Whether Show more has opened it, and for a count of lines: whether it folds, where (null when
 * every line shows), how many lines are drawn and how many are not. Folded, once the page is live,
 * only the lines that show are drawn; else at most MOST_DRAWN, and a line says how many more. With
 * no script nothing folds, so until the page is live it draws as an open block does.
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
    return {
      folds,
      foldAt,
      drawn: cut ? foldAt : MOST_DRAWN,
      more: cut ? 0 : Math.max(0, count - MOST_DRAWN),
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
  const { count, lines } = useLines(
    children,
    language,
    streaming,
    (all) => linesFor(all).drawn
  );
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
