// CodeBlock: code in an answer or a page. Highlighted with Prism (each language loaded the first
// time it is shown), the language's name or a file name over it, a copy button that answers
// "Copied" as a Button's done state does, line numbers and wrapping as options, marked lines, and
// long code folded under Show more. While an agent is still writing it, the head says so, quietly,
// and the code grows in place. One family with the docs' own code; after Palermo's code preview.
//
//   <CodeBlock language="tsx" code={source} />
//   <CodeBlock language="bash" code="bun add @grasp/ui" lineNumbers={false} />
//   <CodeBlock language="ts" fileName="src/report.ts" code={source} marked={[4, 5]} streaming />
//
// The code is drawn as text from Prism's tokens, never as HTML. Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";

import { Button } from "../button";
import { CopyButton } from "../button/copy";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Spinner } from "../spinner";
import { grasp } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { foldVars } from "./fold.stylex";
import { grammarOrNull, languageNames, linesOf } from "./prism";
import type { Line } from "./prism";
import { codeStyles as styles, tones } from "./styles";
import { codeBlockWords } from "./words";

/** Every prop a CodeBlock takes. */
export interface CodeBlockProps {
  /** The code, as text. While `streaming`, pass it as it grows. */
  code: string;
  /**
   * Its language, by Prism's name or the usual short one: `tsx`, `ts`, `js`, `json`, `bash`,
   * `python`, `css`, `html`, `markdown`, `yaml`, `sql`, `diff`, `go`, `rust`. Another shows as
   * plain text.
   * @default "text"
   */
  language?: string;
  /** The language's name in the head, where the usual one would not do. */
  languageLabel?: string;
  /** A file name for the head, such as `src/report.ts`: then the language stands beside it. */
  fileName?: string;
  /**
   * Line numbers in a quiet gutter at the start. They are never selected or copied.
   * @default true
   */
  lineNumbers?: boolean;
  /**
   * Long lines wrap rather than scroll sideways.
   * @default false
   */
  wrap?: boolean;
  /** Lines to mark, by number from 1: a wash of mint and a bar at the start. */
  marked?: number[];
  /**
   * Past this many lines it is folded under Show more. `false` never folds.
   * @default 18
   */
  maxLines?: number | false;
  /** An agent is still writing it: the head says so in words, copying waits, and the code grows in place. */
  streaming?: boolean;
  /**
   * A spinner beside the head's words while it is written. Off by default: the words say it.
   * @default false
   */
  streamingMark?: boolean;
  /**
   * The copy button's name, in the page's language.
   * @default "Copy code"
   */
  copyLabel?: string;
  /**
   * What the copy button says once the code is copied.
   * @default "Copied"
   */
  copiedLabel?: string;
  /**
   * What the copy button says when it could not copy.
   * @default "Could not copy"
   */
  copyFailedLabel?: string;
  /**
   * The words in the head while it is still being written.
   * @default "Writing"
   */
  writingLabel?: string;
  /**
   * Show more's words.
   * @default "Show more"
   */
  moreLabel?: string;
  /**
   * Show less's words.
   * @default "Show less"
   */
  lessLabel?: string;
}

const dynamic = stylex.create({
  foldAt: (lines: number) => ({
    [foldVars.height]: `calc(${lines} * ${grasp.codeBlockLine} + ${grasp.space3})`,
  }),
  digits: (count: number) => ({
    minWidth: `${count}ch`,
  }),
});

/** The colour of a run: the innermost of Prism's names that has one. */
const toneOf = (types: string[]) => {
  const tone = types
    .map((type) => tones[type])
    .findLast((found) => found !== undefined);
  return tone === undefined ? null : styles[tone];
};

type Highlight = Awaited<ReturnType<typeof grammarOrNull>>;

/** Prism and the language's grammar once they have loaded, in the browser; null until then. */
const useHighlight = (language: string): Highlight => {
  // The grammar is kept with its language, so code in a new language is never coloured as the old.
  const [loaded, setLoaded] = useState<{
    language: string;
    found: Highlight;
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
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const element = scroller.current;
    const measure = () => {
      if (element !== null) {
        const room = element.scrollWidth - element.clientWidth;
        // Right to left, scrollLeft runs from 0 to minus the room.
        const along = Math.abs(element.scrollLeft);
        setScrolls(room > 1);
        element.toggleAttribute("data-under-start", along > 1);
        element.toggleAttribute("data-under-end", along < room - 1);
      }
    };
    element?.addEventListener("scroll", measure, { passive: true });
    // Measured by the observer only: it reports each box once when it starts watching, after the
    // page is laid out, so a block that mounts while an answer streams forces no layout of its own.
    // The lines' own box too: it changes with the code, and when wrapping is turned on or off.
    const observer = new ResizeObserver(measure);
    if (element !== null) {
      observer.observe(element);
    }
    if (element?.firstElementChild) {
      observer.observe(element.firstElementChild);
    }
    return () => {
      observer.disconnect();
      element?.removeEventListener("scroll", measure);
    };
  }, []);
  return { scroller, scrolls };
};

type HeadProps = Pick<
  CodeBlockProps,
  | "code"
  | "fileName"
  | "copyLabel"
  | "copiedLabel"
  | "copyFailedLabel"
  | "writingLabel"
  | "streamingMark"
> & {
  name: string;
  streaming: boolean;
};

const Head = ({
  code,
  fileName,
  name,
  streaming,
  streamingMark = false,
  copyLabel: copyLabelGiven,
  copiedLabel: copiedLabelGiven,
  copyFailedLabel: copyFailedLabelGiven,
  writingLabel: writingLabelGiven,
}: HeadProps) => {
  const {
    copy: copyLabel,
    copied: copiedLabel,
    copyFailed: copyFailedLabel,
    writing: writingLabel,
  } = withGiven(useWords("codeBlock", codeBlockWords), {
    copy: copyLabelGiven,
    copied: copiedLabelGiven,
    copyFailed: copyFailedLabelGiven,
    writing: writingLabelGiven,
  });
  const hasFile = fileName !== undefined && fileName !== "";
  return (
    <div {...stylex.props(styles.head)}>
      {hasFile ? (
        <span title={fileName} {...stylex.props(styles.name)}>
          {fileName}
        </span>
      ) : null}
      <span {...stylex.props(styles.language, !hasFile && styles.name)}>
        {name}
      </span>
      {/* Always in the page, so a screen reader hears it start; empty once the code is written. */}
      <output {...stylex.props(streaming ? styles.writing : visuallyHidden)}>
        {streaming && streamingMark && <Spinner size="sm" />}
        {streaming ? writingLabel : ""}
      </output>
      <CopyButton
        text={code}
        label={copyLabel}
        copiedLabel={copiedLabel}
        failedLabel={copyFailedLabel}
        disabled={streaming}
      />
    </div>
  );
};

interface CodeLineProps {
  line: Line;
  number: number;
  lineNumbers: boolean;
  wrap: boolean;
  marked: boolean;
  digits: number;
}

const CodeLine = ({
  line,
  number,
  lineNumbers,
  wrap,
  marked,
  digits,
}: CodeLineProps) => (
  <span
    data-line={number}
    {...stylex.props(
      styles.line,
      wrap && styles.lineWrapped,
      marked && styles.marked
    )}
  >
    {lineNumbers ? (
      <span
        aria-hidden="true"
        {...stylex.props(styles.number, dynamic.digits(digits))}
      >
        {number}
      </span>
    ) : (
      <span aria-hidden="true" {...stylex.props(styles.bare)} />
    )}
    <span {...stylex.props(styles.text)}>
      {line.length === 0
        ? "\n"
        : line.map((run, at) => (
            <span key={at} {...stylex.props(toneOf(run.types))}>
              {run.text}
            </span>
          ))}
    </span>
  </span>
);

interface LinesProps {
  id: string;
  lines: Line[];
  language: string;
  /** What the scroller is called when it takes focus. */
  label: string;
  /** The number of lines it is folded to, or null while it shows them all. */
  foldAt: number | null;
  lineNumbers: boolean;
  wrap: boolean;
  marked: number[] | undefined;
}

const Lines = ({
  id,
  lines,
  language,
  label,
  foldAt,
  lineNumbers,
  wrap,
  marked,
}: LinesProps) => {
  const { scroller, scrolls } = useScrolls();
  const markedLines = new Set(marked);
  const digits = String(lines.length).length;
  return (
    <>
      <div
        ref={scroller}
        id={id}
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-label={scrolls ? label : undefined}
        {...stylex.props(
          styles.scroller,
          foldAt !== null && styles.folded,
          foldAt !== null && dynamic.foldAt(foldAt),
          focus.carrier
        )}
      >
        {/* A div, not a pre: the lines carry their own whitespace, and a page's prose rules for
            `pre span` (as the docs site's) never reach the highlighting. */}
        <div
          data-code-lines=""
          {...stylex.props(styles.code, wrap && styles.wrapped)}
        >
          <code data-language={language}>
            {lines.map((line, index) => (
              <CodeLine
                key={index}
                line={line}
                number={index + 1}
                lineNumbers={lineNumbers}
                wrap={wrap}
                marked={markedLines.has(index + 1)}
                digits={digits}
              />
            ))}
          </code>
        </div>
      </div>
      {/* The scroller's ring, round the whole block (styles.ring): shown while the scroller before it has focus. */}
      <span
        aria-hidden="true"
        data-slot="code-block-ring"
        {...stylex.props(styles.ring)}
      />
    </>
  );
};

type FootProps = Pick<CodeBlockProps, "moreLabel" | "lessLabel"> & {
  open: boolean;
  /** The id of what it folds. */
  controls: string;
  onToggle: () => void;
};

const Foot = ({
  open,
  controls,
  onToggle,
  moreLabel: moreGiven,
  lessLabel: lessGiven,
}: FootProps) => {
  const { more, less } = withGiven(useWords("codeBlock", codeBlockWords), {
    more: moreGiven,
    less: lessGiven,
  });
  return (
    <div {...stylex.props(styles.foot)}>
      <Button
        variant="quiet"
        size="sm"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        {open ? less : more}
      </Button>
    </div>
  );
};

/** Code, highlighted, with its language, a copy button, and Show more when it is long. */
export const CodeBlock = ({
  code,
  language = "text",
  languageLabel,
  fileName,
  lineNumbers = true,
  wrap = false,
  marked,
  maxLines = 18,
  streaming = false,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
  writingLabel,
  streamingMark,
  moreLabel,
  lessLabel,
}: CodeBlockProps) => {
  // Plain until Prism and the language have loaded; then highlighted.
  const highlight = useHighlight(language);
  // While code streams in, a render may wait for the next chunk rather than fall behind. The
  // compiler keeps the lines until the code or the grammar changes.
  const shownCode = useDeferredValue(code);
  const lines: Line[] = linesOf(shownCode, highlight);

  const [open, setOpen] = useOpen(streaming);
  // Never folded while it is still being written: new lines would arrive under the fade.
  const limit = streaming || maxLines === false ? null : maxLines;
  const folds = limit !== null && lines.length > limit;
  const scrollerId = useId();
  const name =
    languageLabel ?? languageNames[language.toLowerCase()] ?? language;

  return (
    <div
      data-slot="code-block"
      data-streaming={streaming || undefined}
      {...stylex.props(styles.box)}
    >
      <Head
        code={code}
        fileName={fileName}
        name={name}
        streaming={streaming}
        copyLabel={copyLabel}
        copiedLabel={copiedLabel}
        copyFailedLabel={copyFailedLabel}
        writingLabel={writingLabel}
        streamingMark={streamingMark}
      />
      <Lines
        id={scrollerId}
        lines={lines}
        language={language}
        label={fileName ?? name}
        foldAt={folds && !open ? limit : null}
        lineNumbers={lineNumbers}
        wrap={wrap}
        marked={marked}
      />
      {folds && (
        <Foot
          open={open}
          controls={scrollerId}
          moreLabel={moreLabel}
          lessLabel={lessLabel}
          onToggle={() => {
            setOpen((now) => !now);
          }}
        />
      )}
    </div>
  );
};
