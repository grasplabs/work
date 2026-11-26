// Terminal: a command an assistant runs and what it prints: a
// Trace with one TraceCollapsible, its line the command ("Ran pnpm build"), the output under it on
// the code surface.
//
//   <Terminal output={log} isStreaming={running} onClear={() => setLog("")} />
//
//   <Terminal output={log} isStreaming={running}>
//     <TerminalHeader>
//       <TerminalTitle>{running ? "Running pnpm build" : "Ran pnpm build"}</TerminalTitle>
//       <TerminalActions>
//         <TerminalCopyButton />
//       </TerminalActions>
//     </TerminalHeader>
//     <TerminalContent />
//   </Terminal>
//
// The line runs while `isStreaming`, and opens once output arrives, unless the person opened or
// closed it first. A button cannot sit inside the line's trigger, so TerminalTitle is the trigger and the status
// and the buttons stand beside it in the header. The output's ANSI colours and marks are read by
// terminal-ansi.ts and drawn as text in Damsko's syntax and status colours, never as HTML; every
// other escape sequence is taken out. The output follows its end as it grows, until the person
// scrolls up. Trace says the line once when it finishes or fails. Every value is a token. A caller
// may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { Icon, TerminalIcon, TrashIcon } from "../lib/icons";
import { createStickToBottom } from "../lib/stick-to-bottom";
import { codeStyles, focusRingInset, scrollbarHidden } from "../lib/styles";
import { colors, font, size, space } from "../lib/tokens.stylex";
import { announce } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { Button } from "./button";
import { CopyButton } from "./copy-button";
import { Spinner } from "./spinner";
import { parseAnsi, plainText } from "./terminal-ansi";
import type { AnsiColor, AnsiSpan } from "./terminal-ansi";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";
import type { TraceLineStatus } from "./trace";

/** Every prop a Terminal takes. */
export interface TerminalProps {
  /** What the command printed, with its ANSI escape sequences. While it runs, pass it as it grows. */
  output: string;
  /**
   * The command is still running: its line runs, and opens once there is output.
   * @default false
   */
  isStreaming?: boolean;
  /**
   * Follow the end of the output as it grows, until the person scrolls up; back at the end, it
   * follows again.
   * @default true
   */
  autoScroll?: boolean;
  /** Runs when Clear is pressed: the product empties `output`. Without it there is no Clear. */
  onClear?: () => void;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open at first. Left out, it opens once the running command prints, and stays open until the
   * person closes it.
   */
  defaultOpen?: boolean;
  /** Runs when the line opens or closes it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Its parts, to arrange them yourself: a TerminalHeader and a TerminalContent. Left out, it draws
   * the header (title, copy and clear) and the output.
   */
  children?: ReactNode;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a TerminalHeader takes. */
export interface TerminalHeaderProps {
  /** Its TerminalTitle, then a TerminalStatus and TerminalActions beside it. */
  children: ReactNode;
  /**
   * Where the command stands: `error` once it exited with a code other than 0. Without one it runs
   * while `isStreaming` and is done after.
   */
  status?: TraceLineStatus;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TerminalTitle takes. */
export interface TerminalTitleProps {
  /**
   * The command, as a sentence in the tense of its status ("Running pnpm build", "Ran pnpm
   * build", "pnpm lint exited with code 1"), after the terminal's mark.
   * @default the catalogue's terminal.title, "Terminal"
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TerminalStatus takes. */
export interface TerminalStatusProps {
  /**
   * What stands beside the line while the command runs. Shown only while `isStreaming`.
   * @default a Spinner
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TerminalActions takes. */
export interface TerminalActionsProps {
  /** Its buttons: a TerminalCopyButton, a TerminalClearButton, or ghost icon Buttons of your own. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TerminalCopyButton takes. */
export interface TerminalCopyButtonProps {
  /** Runs with what was copied, once it is on the clipboard. */
  onCopy?: (value: string) => void;
  /**
   * Its name and its tooltip.
   * @default the catalogue's terminal.copy, "Copy the output"
   */
  "aria-label"?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TerminalClearButton takes. */
export interface TerminalClearButtonProps {
  /** A mark in place of the bin (`<Icon />`). */
  children?: ReactNode;
  /**
   * Its name and its tooltip.
   * @default the catalogue's terminal.clear, "Clear the output"
   */
  "aria-label"?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TerminalContent takes. */
export interface TerminalContentProps {
  /** Your own drawing of the output, in place of the coloured text. */
  children?: ReactNode;
  /** Where it sits and how tall it may grow (`maxHeight`); it scrolls past that. */
  style?: LayoutStyle;
}

/** At most this much of the end of the output is drawn: a terminal shows its latest lines. */
const MOST_SHOWN = 200_000;

const styles = stylex.create({
  root: {
    display: "grid",
    minWidth: 0,
  },
  // The line, then the status and the buttons at the end.
  header: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["1"]} / 2)`,
    minWidth: 0,
  },
  status: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  // At the header's end.
  actions: {
    display: "flex",
    marginInlineStart: "auto",
    alignItems: "center",
    gap: space["1"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["1"]} / 2)`,
    // The last icon ends on the output's end edge, as the line's mark starts on its start edge; the
    // button's fill under the pointer reaches past it by the button's own padding.
    marginInlineEnd: `calc((${size.iconSm} - ${size.controlSm}) / 2)`,
    flexShrink: 0,
  },
  // The output, on the code surface (codeStyles): mono text that wraps, scrolling inside once it
  // is as tall as a popup.
  content: {
    maxHeight: size.popupHeight,
    overflowX: "hidden",
    overflowY: "auto",
    tabSize: 4,
  },
  pre: {
    margin: 0,
    fontFamily: "inherit",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  bold: { fontWeight: font.weightSemibold },
  dim: { color: colors.mutedForeground },
  italic: { fontStyle: "italic" },
  underline: { textDecorationLine: "underline" },
  // The 16 colours, two by two, in the syntax and status colours: each reads on the code surface in
  // light and dark.
  fgBlack: { color: colors.mutedForeground },
  fgRed: { color: colors.destructive },
  fgGreen: { color: colors.success },
  fgYellow: { color: colors.warning },
  fgBlue: { color: colors.info },
  fgMagenta: { color: colors.syntaxKeyword },
  fgCyan: { color: colors.syntaxConstant },
  fgWhite: { color: colors.bodyForeground },
  fgBrightWhite: { color: colors.foreground },
  // Grounds: the status washes, and for the rest the wash of the text's own colour.
  bgBlack: { backgroundColor: colors.muted },
  bgRed: { backgroundColor: colors.destructiveSubtle },
  bgGreen: { backgroundColor: colors.successSubtle },
  bgYellow: { backgroundColor: colors.warningSubtle },
  bgBlue: { backgroundColor: colors.infoSubtle },
  bgMagenta: {
    backgroundColor: `color-mix(in oklch, ${colors.syntaxKeyword} 16%, transparent)`,
  },
  bgCyan: {
    backgroundColor: `color-mix(in oklch, ${colors.syntaxConstant} 16%, transparent)`,
  },
  bgWhite: { backgroundColor: colors.accent },
});

/** Which style each of the 16 colours takes as text. */
const foregrounds: Record<AnsiColor, stylex.StyleXStyles> = {
  black: styles.fgBlack,
  red: styles.fgRed,
  green: styles.fgGreen,
  yellow: styles.fgYellow,
  blue: styles.fgBlue,
  magenta: styles.fgMagenta,
  cyan: styles.fgCyan,
  white: styles.fgWhite,
  brightBlack: styles.fgBlack,
  brightRed: styles.fgRed,
  brightGreen: styles.fgGreen,
  brightYellow: styles.fgYellow,
  brightBlue: styles.fgBlue,
  brightMagenta: styles.fgMagenta,
  brightCyan: styles.fgCyan,
  brightWhite: styles.fgBrightWhite,
};

/** Which style each of the 16 colours takes as a ground. */
const backgrounds: Record<AnsiColor, stylex.StyleXStyles> = {
  black: styles.bgBlack,
  red: styles.bgRed,
  green: styles.bgGreen,
  yellow: styles.bgYellow,
  blue: styles.bgBlue,
  magenta: styles.bgMagenta,
  cyan: styles.bgCyan,
  white: styles.bgWhite,
  brightBlack: styles.bgBlack,
  brightRed: styles.bgRed,
  brightGreen: styles.bgGreen,
  brightYellow: styles.bgYellow,
  brightBlue: styles.bgBlue,
  brightMagenta: styles.bgMagenta,
  brightCyan: styles.bgCyan,
  brightWhite: styles.bgWhite,
};

interface TerminalState {
  output: string;
  isStreaming: boolean;
  autoScroll: boolean;
  onClear: (() => void) | undefined;
}

const TerminalContext = createContext<TerminalState>({
  output: "",
  isStreaming: false,
  autoScroll: true,
  onClear: undefined,
});

// The header's line status, for its title.
const StatusContext = createContext<TraceLineStatus | undefined>(undefined);

/** The end of the output, from the start of a line, when it is longer than is drawn. */
const shownOf = (output: string) => {
  if (output.length <= MOST_SHOWN) {
    return output;
  }
  const tail = output.slice(-MOST_SHOWN);
  const line = tail.indexOf("\n");
  return line === -1 ? tail : tail.slice(line + 1);
};

/** One run of the output, in its look. */
const Run = ({ span }: { span: AnsiSpan }) => {
  const { fg, bg, bold, dim, italic, underline } = span.style;
  if (span.key === "") {
    return span.text;
  }
  return (
    <span
      {...stylex.props(
        dim && styles.dim,
        fg !== null && foregrounds[fg],
        bg !== null && backgrounds[bg],
        bold && styles.bold,
        italic && styles.italic,
        underline && styles.underline
      )}
    >
      {span.text}
    </span>
  );
};

/** The header: the command's line, then the status and the buttons beside it. */
export const TerminalHeader = ({
  children,
  status,
  style,
}: TerminalHeaderProps) => {
  const { isStreaming } = use(TerminalContext);
  return (
    <div data-slot="terminal-header" {...stylex.props(styles.header, style)}>
      <StatusContext value={status ?? (isStreaming ? "running" : undefined)}>
        {children}
      </StatusContext>
    </div>
  );
};

/** The command's line, after the terminal's mark: the trigger that opens the output. */
export const TerminalTitle = ({ children, style }: TerminalTitleProps) => {
  const words = useI18n().terminal;
  const status = use(StatusContext);
  return (
    <TraceCollapsibleTrigger style={style}>
      <TraceLine status={status}>
        <TraceIcon>
          <Icon icon={TerminalIcon} />
        </TraceIcon>
        <TraceTitle>{children ?? words.title}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

/** While the command runs, a Spinner beside its line; nothing once it is done. */
export const TerminalStatus = ({ children, style }: TerminalStatusProps) => {
  const { isStreaming } = use(TerminalContext);
  if (!isStreaming) {
    return null;
  }
  return (
    <span data-slot="terminal-status" {...stylex.props(styles.status, style)}>
      {children ?? <Spinner />}
    </span>
  );
};

/** The header's buttons, in a row at its end. */
export const TerminalActions = ({ children, style }: TerminalActionsProps) => (
  <div data-slot="terminal-actions" {...stylex.props(styles.actions, style)}>
    {children}
  </div>
);

/** Copies the output's words, without its escape sequences. */
export const TerminalCopyButton = ({
  onCopy,
  "aria-label": label,
  style,
}: TerminalCopyButtonProps) => {
  const words = useI18n().terminal;
  const { output } = use(TerminalContext);
  return (
    <CopyButton
      value={() => plainText(output)}
      onCopy={onCopy}
      aria-label={label ?? words.copy}
      style={style}
    />
  );
};

/** Empties the output through the Terminal's `onClear`; not drawn without one. */
export const TerminalClearButton = ({
  children,
  "aria-label": label,
  style,
}: TerminalClearButtonProps) => {
  const words = useI18n().terminal;
  const { onClear } = use(TerminalContext);
  if (onClear === undefined) {
    return null;
  }
  const name = label ?? words.clear;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={name}
          onClick={() => {
            onClear();
            announce(words.cleared);
          }}
          style={style}
          asChild
        >
          <button type="button" data-slot="terminal-clear-button">
            {children ?? <Icon icon={TrashIcon} />}
          </button>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
};

/**
 * The scroller, following its end while `follow` and the person has not scrolled up, and whether it
 * has more than it shows: then it takes focus, so the keys can scroll it.
 */
const useScroller = (follow: boolean) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  // oxlint-disable-next-line react/hook-use-state -- a follower made once, never replaced
  const [stick] = useState(() => createStickToBottom());
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!follow || element === null) {
      return () => {
        stick.release();
      };
    }
    const disconnect = stick.connect(element);
    stick.scrollToBottom();
    return disconnect;
  }, [follow, stick]);
  useEffect(() => {
    const element = scroller.current;
    const measure = () => {
      if (element !== null) {
        setScrolls(element.scrollHeight > element.clientHeight + 1);
      }
    };
    const observer = new ResizeObserver(measure);
    if (element !== null) {
      observer.observe(element);
      for (const child of element.children) {
        observer.observe(child);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  return { scroller, scrolls };
};

/** What opens under the line: the output in its colours, following its end as it grows. */
export const TerminalContent = ({ children, style }: TerminalContentProps) => {
  const words = useI18n().terminal;
  const { output, autoScroll } = use(TerminalContext);
  const { scroller, scrolls } = useScroller(autoScroll);
  const spans = parseAnsi(shownOf(output));
  return (
    <TraceCollapsibleContent>
      <div
        ref={scroller}
        data-slot="terminal-content"
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-label={scrolls ? words.output : undefined}
        {...stylex.props(
          codeStyles.surface,
          codeStyles.text,
          styles.content,
          scrollbarHidden,
          style,
          scrolls && focusRingInset
        )}
      >
        {children ?? (
          <pre {...stylex.props(styles.pre)}>
            {spans.map((span, at) => (
              // A run has no id; its place in the output is its key, and runs never reorder.
              <Run key={at} span={span} />
            ))}
          </pre>
        )}
      </div>
    </TraceCollapsibleContent>
  );
};

/** A command and what it printed: its line, opening on the output. */
export const Terminal = ({
  output,
  isStreaming = false,
  autoScroll = true,
  onClear,
  open,
  defaultOpen,
  onOpenChange,
  children,
  style,
}: TerminalProps) => {
  // Open or closed as the person last left it. Until they press it, it opens once the running
  // command prints, and stays so.
  const [chosen, setChosen] = useState(defaultOpen);
  if (chosen === undefined && isStreaming && output !== "") {
    setChosen(true);
  }
  const shown = open ?? chosen ?? false;
  return (
    <div
      data-slot="terminal"
      data-streaming={isStreaming || undefined}
      {...stylex.props(styles.root, style)}
    >
      <Trace>
        {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
        <TerminalContext value={{ output, isStreaming, autoScroll, onClear }}>
          <TraceCollapsible
            open={shown}
            onOpenChange={(next) => {
              setChosen(next);
              onOpenChange?.(next);
            }}
          >
            {children ?? (
              <>
                <TerminalHeader>
                  <TerminalTitle />
                  <TerminalActions>
                    <TerminalCopyButton />
                    <TerminalClearButton />
                  </TerminalActions>
                </TerminalHeader>
                <TerminalContent />
              </>
            )}
          </TraceCollapsible>
        </TerminalContext>
      </Trace>
    </div>
  );
};
