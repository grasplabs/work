// StackTrace: an error and its stack frames:
// a Trace with one TraceCollapsible, its line the error in red, the frames under it in a muted
// monospace block, the product's own frames in ink and the dependencies' muted. The parts:
// StackTraceHeader the row's trigger, its TraceLine failed,
// StackTraceError its TraceTitle, and StackTraceActions beside the trigger, not in it.
//
//   <StackTrace trace={error.stack} onFilePathClick={(path, line) => openFile(path, line)} />
//
//   <StackTrace trace={part.errorText}>
//     <StackTraceHeader>
//       <StackTraceError />
//     </StackTraceHeader>
//     <StackTraceActions>
//       <StackTraceCopyButton />
//     </StackTraceActions>
//     <StackTraceContent>
//       <StackTraceFrames showInternalFrames={false} />
//     </StackTraceContent>
//   </StackTrace>
//
// The stack is read by stack-trace-parse.ts (V8's frames and Firefox's and Safari's), bounded, and
// drawn as text, never as HTML. A file path is a button only when the product handles the press
// (`onFilePathClick`): it is never a link made from the stack. A button cannot sit inside the
// line's trigger, so StackTraceActions stands beside StackTraceHeader, at the end of its row.
// Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { codeStyles, focusRingText, tapTarget } from "../lib/styles";
import { colors, font, media, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { CopyButton } from "./copy-button";
import { parseStackTrace } from "./stack-trace-parse";
import type { ParsedStackTrace, StackFrame } from "./stack-trace-parse";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";

/** Every prop a StackTrace takes. */
export interface StackTraceProps {
  /** The error's stack as text: `error.stack`, or a failed tool call's error text. Read as text, never as HTML. */
  trace: string;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open on its frames at first.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the line opens or closes it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Runs when a frame's file path is pressed, with the path, its line and its column: open the file
   * there. Without it a path is text.
   */
  onFilePathClick?: (filePath: string, line?: number, column?: number) => void;
  /**
   * Its parts, to arrange them yourself: a StackTraceHeader and a StackTraceContent. Left out, it
   * draws the error, Copy, and the frames.
   */
  children?: ReactNode;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceHeader takes. */
export interface StackTraceHeaderProps {
  /**
   * The line's words.
   * @default a StackTraceError
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceError takes. */
export interface StackTraceErrorProps {
  /**
   * What the line says.
   * @default the error's StackTraceErrorType and StackTraceErrorMessage
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceErrorType takes. */
export interface StackTraceErrorTypeProps {
  /**
   * The error's type.
   * @default the type the stack names ("TypeError"); nothing when it names none
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceErrorMessage takes. */
export interface StackTraceErrorMessageProps {
  /**
   * The error's message.
   * @default the message the stack gives
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceActions takes. */
export interface StackTraceActionsProps {
  /** Its buttons: a StackTraceCopyButton, or ghost icon Buttons of your own. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceCopyButton takes. */
export interface StackTraceCopyButtonProps {
  /** Runs with what was copied, once it is on the clipboard. */
  onCopy?: (value: string) => void;
  /**
   * Its name and its tooltip.
   * @default the catalogue's stackTrace.copy, "Copy the stack trace"
   */
  "aria-label"?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceContent takes. */
export interface StackTraceContentProps {
  /** What opens under the line: StackTraceFrames. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StackTraceFrames takes. */
export interface StackTraceFramesProps {
  /**
   * Show the frames from dependencies and the runtime (node_modules, node:, native code), muted.
   * With `false`, only the product's own.
   * @default true
   */
  showInternalFrames?: boolean;
  /** Where it sits and how tall it may grow (`maxHeight`). */
  style?: LayoutStyle;
}

const styles = stylex.create({
  root: {
    display: "grid",
    minWidth: 0,
  },
  // The header's line and its actions share the first row; the frames run under both.
  rows: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["2"],
    minWidth: 0,
  },
  across: { gridColumn: "1 / -1", minWidth: 0 },
  type: {
    fontWeight: font.weightSemibold,
  },
  message: {
    whiteSpace: "pre-line",
  },
  // At the end of the header's row.
  actions: {
    display: "flex",
    gridColumn: 2,
    gridRow: 1,
    alignItems: "center",
    gap: space["1"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["1"]} / 2)`,
    // The last icon ends on the output's end edge, as the line's mark starts on its start edge; the
    // button's fill under the pointer reaches past it by the button's own padding.
    marginInlineEnd: `calc((${size.iconSm} - ${size.controlSm}) / 2)`,
  },
  // The frames, on the code surface (codeStyles): monospace lines, the dependencies' muted and the
  // product's in ink.
  frames: {
    overflowY: "auto",
    margin: 0,
    listStyle: "none",
    color: colors.mutedForeground,
  },
  frame: {
    overflowWrap: "anywhere",
  },
  own: {
    color: colors.foreground,
  },
  // A path the product opens: the path's words, dotted under, a finger's reach on a touch screen.
  path: {
    position: "relative",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "start",
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: "0.2em",
    overflowWrap: "anywhere",
    cursor: "pointer",
  },
  pathHover: {
    color: {
      default: null,
      ":hover": { default: null, [media.hover]: colors.foreground },
    },
  },
  empty: {
    margin: 0,
  },
});

interface StackTraceState {
  trace: string;
  parsed: ParsedStackTrace;
  onFilePathClick: StackTraceProps["onFilePathClick"];
}

const StackTraceContext = createContext<StackTraceState>({
  trace: "",
  parsed: { errorType: null, errorMessage: "", frames: [] },
  onFilePathClick: undefined,
});

/** The error's type, in the weight that sets it off from the message. */
export const StackTraceErrorType = ({
  children,
  style,
}: StackTraceErrorTypeProps) => {
  const { parsed } = use(StackTraceContext);
  const type = children ?? parsed.errorType;
  if (type === null) {
    return null;
  }
  return (
    <span
      data-slot="stack-trace-error-type"
      {...stylex.props(styles.type, style)}
    >
      {type}
    </span>
  );
};

/** The error's message. */
export const StackTraceErrorMessage = ({
  children,
  style,
}: StackTraceErrorMessageProps) => {
  const { parsed } = use(StackTraceContext);
  return (
    <span
      data-slot="stack-trace-error-message"
      {...stylex.props(styles.message, style)}
    >
      {children ?? parsed.errorMessage}
    </span>
  );
};

/** What the line says: the error's type and message. */
export const StackTraceError = ({ children, style }: StackTraceErrorProps) => {
  const words = useI18n().stackTrace;
  const { parsed } = use(StackTraceContext);
  const { errorType, errorMessage } = parsed;
  let said = children;
  if (said === undefined) {
    said =
      errorType === null && errorMessage === "" ? (
        words.error
      ) : (
        <>
          <StackTraceErrorType />
          {errorType !== null && errorMessage !== "" && ": "}
          <StackTraceErrorMessage />
        </>
      );
  }
  return <TraceTitle style={style}>{said}</TraceTitle>;
};

/** The error's line, in red with the alert: the trigger that opens the frames. */
export const StackTraceHeader = ({
  children,
  style,
}: StackTraceHeaderProps) => (
  <TraceCollapsibleTrigger style={style}>
    <TraceLine status="error">
      <TraceIcon />
      {children ?? <StackTraceError />}
    </TraceLine>
  </TraceCollapsibleTrigger>
);

/** The buttons beside the header's line, at the end of its row. */
export const StackTraceActions = ({
  children,
  style,
}: StackTraceActionsProps) => (
  <div data-slot="stack-trace-actions" {...stylex.props(styles.actions, style)}>
    {children}
  </div>
);

/** Copies the stack as it was given. */
export const StackTraceCopyButton = ({
  onCopy,
  "aria-label": label,
  style,
}: StackTraceCopyButtonProps) => {
  const words = useI18n().stackTrace;
  const { trace } = use(StackTraceContext);
  return (
    <CopyButton
      value={trace}
      onCopy={onCopy}
      aria-label={label ?? words.copy}
      style={style}
    />
  );
};

/** What opens under the line, across the header's row. */
export const StackTraceContent = ({
  children,
  style,
}: StackTraceContentProps) => (
  <div data-slot="stack-trace-content" {...stylex.props(styles.across)}>
    <TraceCollapsibleContent style={style}>{children}</TraceCollapsibleContent>
  </div>
);

/**
 * A frame's line as the stack wrote it; where the product opens files, its place in the line (the
 * file, the line and the column) is a button that hands them to it.
 */
const FrameLine = ({ frame }: { frame: StackFrame }) => {
  const { onFilePathClick } = use(StackTraceContext);
  const { raw, filePath, lineNumber, columnNumber } = frame;
  const where = [filePath, lineNumber, columnNumber]
    .filter((part) => part !== null)
    .join(":");
  const at = filePath === null ? -1 : raw.lastIndexOf(where);
  if (onFilePathClick === undefined || filePath === null || at === -1) {
    return raw;
  }
  return (
    <>
      {raw.slice(0, at)}
      <button
        type="button"
        data-slot="stack-trace-file-path"
        onClick={() => {
          onFilePathClick(
            filePath,
            lineNumber ?? undefined,
            columnNumber ?? undefined
          );
        }}
        {...stylex.props(styles.path, styles.pathHover, focusRingText)}
      >
        <span aria-hidden="true" {...stylex.props(tapTarget)} />
        {where}
      </button>
      {raw.slice(at + where.length)}
    </>
  );
};

/** The frames, one a line as the stack wrote it, the product's own in ink. */
export const StackTraceFrames = ({
  showInternalFrames = true,
  style,
}: StackTraceFramesProps) => {
  const words = useI18n().stackTrace;
  const { parsed } = use(StackTraceContext);
  const frames = showInternalFrames
    ? parsed.frames
    : parsed.frames.filter((frame) => !frame.isInternal);
  if (frames.length === 0) {
    return (
      <p
        data-slot="stack-trace-frames"
        {...stylex.props(
          codeStyles.surface,
          codeStyles.text,
          styles.frames,
          styles.empty,
          style
        )}
      >
        {words.noFrames}
      </p>
    );
  }
  return (
    <ol
      aria-label={words.frames}
      data-slot="stack-trace-frames"
      {...stylex.props(
        codeStyles.surface,
        codeStyles.text,
        styles.frames,
        style
      )}
    >
      {frames.map((frame, index) => (
        // Frames have no id and never reorder; the same line can come twice (recursion).
        <li
          key={index}
          {...stylex.props(styles.frame, !frame.isInternal && styles.own)}
        >
          <FrameLine frame={frame} />
        </li>
      ))}
    </ol>
  );
};

/** An error and its stack: its line, opening on the frames. */
export const StackTrace = ({
  trace,
  open,
  defaultOpen = false,
  onOpenChange,
  onFilePathClick,
  children,
  style,
}: StackTraceProps) => {
  const parsed = parseStackTrace(trace);
  return (
    <div data-slot="stack-trace" {...stylex.props(styles.root, style)}>
      <Trace>
        {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
        <StackTraceContext value={{ trace, parsed, onFilePathClick }}>
          <TraceCollapsible
            open={open}
            defaultOpen={defaultOpen}
            onOpenChange={onOpenChange}
          >
            <div {...stylex.props(styles.rows)}>
              {children ?? (
                <>
                  <StackTraceHeader />
                  <StackTraceActions>
                    <StackTraceCopyButton />
                  </StackTraceActions>
                  <StackTraceContent>
                    <StackTraceFrames />
                  </StackTraceContent>
                </>
              )}
            </div>
          </TraceCollapsible>
        </StackTraceContext>
      </Trace>
    </div>
  );
};
