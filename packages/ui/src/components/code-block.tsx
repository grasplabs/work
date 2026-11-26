// CodeBlock: code in an answer or a page, in StyleX on our
// CopyButton. Highlighted with Prism, which reads the code whole in a worker, off the page
// (code-block-prism.ts), its title and the language's name in a header over it, a copy button that
// copies the code exactly and a download button that saves it as a file, line numbers and wrapping as options, highlighted, added and removed
// lines, and long code folded under Show more. While it is still being written, the header says
// so, quietly, and the code grows in place, read again at most once a frame.
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
import type { ReactNode, RefObject } from "react";

import { markScrollEdges, useScrollEdges } from "../hooks/use-scroll-edges";
import { useI18n } from "../lib/i18n";
import { DownloadIcon, Icon } from "../lib/icons";
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
import { listOf, nothing, ownValue, saveFile } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, ringInsetMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import { colouredLines, colouredOf, languages } from "./code-block-prism";
import type { Coloured, Line, Runs } from "./code-block-prism";
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

/**
 * How long Prism may read a block in the worker, from when the worker says it has started: a tenth
 * of a second, and 2 milliseconds more for each 1,000 characters, at most a second. Ordinary code
 * takes at most half a millisecond for each 1,000 characters (the slowest grammar, Markdown, on a
 * laptop), so this leaves a slow phone room; code that takes longer is hostile to Prism, and is
 * stopped soon, so the blocks after it wait little. Past it the worker is stopped, and the block
 * stays plain.
 */
const LEAST_TIME = 100;
const MOST_TIME = 1000;
const CHARACTERS_A_MILLISECOND = 500;
const timeFor = (code: string) =>
  Math.min(MOST_TIME, LEAST_TIME + code.length / CHARACTERS_A_MILLISECOND);
/** How long the worker's word that it has started may take: an idle worker in WebKit can take a second to hear. */
const WAIT_TIME = 5000;
/** How long the worker is kept once no block is on the page. */
const IDLE_TIME = 1000;

/**
 * The worker once it is ready, the port it reads through, and what hears its answer to the read
 * under way (one at a time).
 */
interface Reader {
  worker: Worker;
  port: MessagePort;
  hear: (data: unknown) => void;
}

let reader: Promise<Reader | null> | undefined;
// Set when the browser refuses the worker: then every block stays plain, and it is not tried again.
let refused = false;

/**
 * Starts the worker. Where it cannot start (no workers, a page whose policy refuses them, a file
 * that does not load) every block stays plain; one not started within WAIT_TIME leaves the blocks
 * waiting for it plain, and the next read starts another.
 */
const startReader = async () =>
  // oxlint-disable-next-line promise/avoid-new -- a worker says it is ready, or failed, by an event
  await new Promise<Reader | null>((resolve) => {
    try {
      const worker = new Worker(
        // Written as bundlers find a worker: Vite, webpack and Turbopack each build it as a file.
        // oxlint-disable-next-line unicorn/relative-url-style -- without `./` webpack reads it as a package
        new URL("./code-block-worker.ts", import.meta.url),
        { type: "module" }
      );
      const late = setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, WAIT_TIME);
      worker.addEventListener(
        "message",
        ({ ports: [port] }) => {
          if (port === undefined) {
            resolve(null);
            return;
          }
          const ready: Reader = { worker, port, hear: nothing };
          port.addEventListener(
            "message",
            ({ data }: MessageEvent<unknown>) => {
              ready.hear(data);
            }
          );
          port.start();
          clearTimeout(late);
          resolve(ready);
        },
        { once: true }
      );
      worker.addEventListener(
        "error",
        () => {
          clearTimeout(late);
          refused = true;
          resolve(null);
        },
        { once: true }
      );
    } catch {
      refused = true;
      resolve(null);
    }
  });

/** Stops the worker, if it is running; the next read starts another. */
const stopReader = async (which = reader) => {
  if (reader === which) {
    reader = undefined;
  }
  const ready = await which;
  ready?.worker.terminate();
};

const isRuns = (value: unknown): value is Runs =>
  typeof value === "object" &&
  value !== null &&
  "ends" in value &&
  value.ends instanceof Uint32Array &&
  "kinds" in value &&
  value.kinds instanceof Uint32Array &&
  "names" in value &&
  Array.isArray(value.names);

/**
 * Prism's runs for `code` in `grammar`, from the worker; null when it cannot, and when it takes
 * longer than its time: the worker is then stopped, and the next read starts another. `leave`
 * hears a function that cuts its time to LEAST_TIME, for a block that has gone: an ordinary read
 * still ends (and is not used), and a slow one is stopped at once.
 *
 * Its time is one timer, never a chain: a hidden tab slows timers, a chained one most of all, and
 * this one then fires late but fires. When it fires, the page has one more turn before the worker
 * is stopped, so an answer that came while the page was busy is heard first.
 */
const readOnce = async (
  code: string,
  grammar: string,
  leave: (cut: () => void) => void
) => {
  reader ??= startReader();
  const mine = reader;
  const ready = await mine;
  if (ready === null) {
    // Refused, it is not tried again; late to start, the next read starts another.
    if (reader === mine) {
      reader = undefined;
    }
    return null;
  }
  // oxlint-disable-next-line promise/avoid-new -- the worker answers by an event, or not in time
  return await new Promise<Runs | null>((resolve) => {
    let time = timeFor(code);
    let started: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      void stopReader(mine);
      resolve(null);
    };
    const arm = (wait: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = setTimeout(stop, 0);
      }, wait);
    };
    const armFromStart = () => {
      if (started !== undefined) {
        arm(Math.max(0, started + time - performance.now()));
      }
    };
    arm(WAIT_TIME);
    leave(() => {
      time = LEAST_TIME;
      armFromStart();
    });
    // First that it has started, then the runs.
    ready.hear = (data) => {
      if (data === "reading") {
        started = performance.now();
        armFromStart();
        return;
      }
      clearTimeout(timer);
      resolve(isRuns(data) ? data : null);
    };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a port has no origin to name
    ready.port.postMessage({ code, grammar });
  });
};

/** Prism's grammar for a block's language, by any name people write; none for plain text. */
const grammarOf = (language: string) =>
  ownValue(languages, language.toLowerCase())?.grammar;

/** A block waiting for its code to be read. */
interface Ask {
  /** Whether the block is on the screen: those that are, are read first. */
  place: { shown: boolean };
  /** Its code and language now: read when its turn comes, not when it asked. */
  now: () => { code: string; language: string };
  /** Hears what the worker gave for that code: its runs, or null when it is to stay plain. */
  answer: (code: string, language: string, runs: Runs | null) => void;
}

// The blocks waiting, in the order they asked, and the one being read.
const waiting = new Set<Ask>();
let current: { ask: Ask; cut: () => void; gone: boolean } | null = null;

/**
 * The block to read next: of those on the screen, the one with the least code, else the first that
 * asked. Least first, as a block's time grows with its code: an ordinary block on the screen waits
 * only for the read under way and for shorter ones, which Prism reads, or is stopped on, sooner.
 */
const nextAsk = () => {
  let first: Ask | undefined;
  let least: { ask: Ask; length: number } | undefined;
  for (const each of waiting) {
    first ??= each;
    const { length } = each.now().code;
    if (each.place.shown && (least === undefined || length < least.length)) {
      least = { ask: each, length };
    }
  }
  return least?.ask ?? first;
};

/** Reads the next block, unless one is being read. */
const readNext = () => {
  if (current !== null) {
    return;
  }
  const ask = nextAsk();
  if (ask === undefined) {
    return;
  }
  waiting.delete(ask);
  const reading = { ask, cut: nothing, gone: false };
  current = reading;
  const { code, language } = ask.now();
  const grammar = grammarOf(language);
  const done = async () => {
    const runs =
      grammar === undefined || refused
        ? null
        : await readOnce(code, grammar, (cut) => {
            reading.cut = cut;
            if (reading.gone) {
              cut();
            }
          });
    current = null;
    if (!reading.gone) {
      ask.answer(code, language, runs);
    }
    readNext();
  };
  void done();
};

/**
 * Asks for a block's code to be read; gives back what takes the ask back, for a block that has
 * gone: off the queue, or, while it is read, its answer unheard and its time cut.
 */
const askToRead = (ask: Ask) => {
  waiting.add(ask);
  readNext();
  return () => {
    waiting.delete(ask);
    if (current?.ask === ask) {
      current.gone = true;
      current.cut();
    }
  };
};

// How many blocks are on the page, and the timer that stops the worker once none are.
let blocks = 0;
let idle: ReturnType<typeof setTimeout> | undefined;

/** Counts a block as on the page; gives back what counts it gone. */
const holdReader = () => {
  blocks += 1;
  clearTimeout(idle);
  return () => {
    blocks -= 1;
    // Only a worker that started has anything to stop.
    if (blocks === 0 && reader !== undefined && !refused) {
      idle = setTimeout(() => {
        void stopReader();
      }, IDLE_TIME);
    }
  };
};

/** While code is written, how long after one read the next starts, in milliseconds. */
const WRITING_PAUSE = 200;

/**
 * At most this many lines are drawn while the block is open (and before the page is live, or with
 * no script): past them, a line says how many more there are. Copy still takes all of the code.
 */
const MOST_DRAWN = 2000;

/** What the worker gave for a block's code: its coloured lines, or null when it is to stay plain. */
interface Read {
  code: string;
  language: string;
  coloured: Coloured | null;
}

/**
 * `code` read by Prism in the worker, for its first `most` lines: text until the worker answers,
 * and kept as text when it cannot. While the code is written, it is read again at most every
 * WRITING_PAUSE, never per frame; the lines the last read ended keep its colours, and the newest
 * are text until the next. Code that took too long while written is read once more when it is
 * done, whole. A block on the screen (`place`) is read before those that are not.
 */
const useLinesOf = (
  code: string,
  language: string,
  streaming: boolean,
  most: number,
  place: RefObject<{ shown: boolean }>
): (Line | string)[] => {
  const [last, setLast] = useState<Read | null>(null);
  const latest = useRef({ code, language });
  // Takes back the read asked for, while one is.
  const asking = useRef<(() => void) | null>(null);
  // The last answer, as it is heard: an effect of a render from before it must not ask again.
  const heard = useRef<{ code: string; language: string; plain: boolean }>(
    null
  );
  useEffect(() => {
    latest.current = { code, language };
    const was = heard.current;
    if (
      grammarOf(language) === undefined ||
      code === "" ||
      asking.current !== null ||
      (was?.code === code && was.language === language) ||
      (streaming && was?.language === language && was.plain)
    ) {
      return;
    }
    let takeBack = nothing;
    const pause = setTimeout(
      () => {
        takeBack = askToRead({
          place: place.current,
          now: () => latest.current,
          answer: (read, readLanguage, runs) => {
            heard.current = {
              code: read,
              language: readLanguage,
              plain: runs === null,
            };
            asking.current = null;
            setLast((before) => ({
              code: read,
              language: readLanguage,
              coloured:
                runs === null
                  ? null
                  : colouredOf(read, runs, MOST_DRAWN, before?.coloured?.lines),
            }));
          },
        });
      },
      // Each answer comes with a render: from then on, while it is written, after a pause.
      streaming && last !== null ? WRITING_PAUSE : 0
    );
    asking.current = () => {
      clearTimeout(pause);
      takeBack();
    };
  }, [code, language, streaming, last, place]);
  useEffect(() => {
    const release = holdReader();
    return () => {
      asking.current?.();
      asking.current = null;
      release();
    };
  }, []);
  return colouredLines(
    code,
    last?.language === language ? (last.coloured ?? null) : null,
    most,
    streaming
  );
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
 * A line's runs, each in its colour. A component of its own, so the compiler keeps what it drew for
 * as long as the line is the same object (code-block-prism.ts keeps it one from read to read): a
 * line already coloured is never drawn again while later lines are coloured or more code comes in.
 */
const LineRuns = ({ line }: { line: Line }) => (
  <>
    {line.map((run, at) => {
      const tone = toneOf(run.types);
      // A run with no colour is its text alone: a long file draws thousands fewer elements.
      return tone === null ? (
        run.text
      ) : (
        // A run has no id; its place in the line is its key, and runs never reorder.
        <span key={at} {...stylex.props(tone)}>
          {run.text}
        </span>
      );
    })}
  </>
);

/**
 * `code` highlighted in `language`, as lines of coloured runs to give CodeBlockLines: plain until
 * Prism has read it in its worker, and plain for good when that takes too long; past its first
 * 2,000 lines, plain. While `streaming`, the code shown is read at most once a frame, and
 * highlighted again at most every 200 milliseconds.
 */
export const useHighlightedCode = (
  code: string,
  language: string,
  streaming = false
): ReactNode[] => {
  // No element to watch: it is read as a block on the screen.
  const place = useRef({ shown: true });
  return useLinesOf(
    useOncePerFrame(code, streaming),
    language,
    streaming,
    Number.POSITIVE_INFINITY,
    place
  ).map((line, index) =>
    typeof line === "string" ? (
      line
    ) : (
      // Lines have no id; a line's place is its key.
      <LineRuns key={index} line={line} />
    )
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
 * Whether the content is on the screen, kept in `place` for the reading queue, by a ref for its
 * element.
 */
const useOnScreen =
  (place: RefObject<{ shown: boolean }>) => (element: HTMLElement | null) => {
    if (element === null || typeof IntersectionObserver === "undefined") {
      return nothing;
    }
    const seen = new IntersectionObserver(([entry]) => {
      if (entry !== undefined) {
        place.current.shown = entry.isIntersecting;
      }
    });
    seen.observe(element);
    return () => {
      seen.disconnect();
    };
  };

/**
 * The content's lines: how many there are, and those drawn, at most `most`: its code highlighted, a
 * CodeBlockLine each; or the CodeBlockLines given. Only the lines drawn are made.
 */
const useLines = (
  children: ReactNode,
  language: string,
  streaming: boolean,
  most: (count: number) => number,
  place: RefObject<{ shown: boolean }>
) => {
  const given = typeof children === "string";
  const parts = given ? [] : listOf(children);
  const count = given ? countLines(children) : parts.length;
  const shown = useOncePerFrame(given ? children : "", streaming);
  const highlighted = useLinesOf(
    shown,
    language,
    streaming,
    most(count),
    place
  );
  return {
    count,
    lines: given
      ? highlighted.map((line, index) => (
          // Lines have no id; a line's place is its key.
          <HighlightedLine key={index} line={line} />
        ))
      : parts.slice(0, most(count)),
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
  const place = useRef({ shown: true });
  const { count, lines } = useLines(
    children,
    language,
    streaming,
    (all) => linesFor(all).drawn,
    place
  );
  const { folds, foldAt, more } = linesFor(count);
  const { scroller, scrolls } = useScrolls();
  const onScreen = useOnScreen(place);
  const contentId = useId();
  const digits = String(startLine + count - 1).length;
  return (
    <>
      <div
        ref={(element) => {
          const stops = [scroller(element), onScreen(element)];
          return () => {
            for (const stop of stops) {
              if (typeof stop === "function") {
                stop();
              }
            }
          };
        }}
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
