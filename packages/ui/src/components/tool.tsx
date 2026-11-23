// Tool: one call an assistant made to a tool, from shadcn's Tool pattern (content/docs/ai-elements/
// base/tool.mdx), built as it builds it: a Trace with a TraceCollapsible, its header a TraceLine with
// a TraceIcon and a TraceTitle in the tense of its state, the line's status from the call's state
// (running while it works or waits on its answer, error when it failed), its input and output
// CodeBlocks. In Damsko's look: a card round it, the state a Badge beside the title.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Tool>
//     <ToolHeader name="web_search" title="Searched the web" state={part.state} />
//     <ToolContent>
//       <ToolInput input={part.input} />
//       <ToolOutput output={part.output} errorText={part.errorText} />
//     </ToolContent>
//   </Tool>
//
// `state` is the AI SDK tool part's (`input-streaming` … `output-denied`), declared here, so there is
// no AI SDK dependency. Every state shows as a Badge after the title, in its colour and with its
// mark; a screen reader hears the line's status, and the Badge's words only for a state the status
// cannot say (waiting on approval, answered, denied). A state this file does not know (a newer AI
// SDK's) is a neutral Badge with its own name. Trace draws the row that opens (the card's width,
// no fill: the card carries traceCardMarker), the chevron and the panel, and says the call once
// when it finishes or fails. Input, output and the error are CodeBlocks named Input, Output and
// Error; an output may instead be the product's own card (any
// element). CodeBlock is loaded the first time the call opens: the server draws it as before, and
// the browser keeps that until then. Every value is a token. A caller may set layout only (the
// `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { Suspense, createContext, isValidElement, use, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  Icon,
  LoaderIcon,
  WrenchIcon,
  XIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import { colors, font, media, radius, size, space } from "../lib/tokens.stylex";
import { lazyPart, NotYetShown, ownValue } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { traceCardMarker } from "../lib/vars.stylex";
import { Badge } from "./badge";
import type { BadgeVariant } from "./badge";
import { codeOf } from "./tool-code";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";
import type { TraceLineStatus } from "./trace";

/**
 * Where a tool call stands, as the AI SDK's tool part says it: its input still being written, its
 * input ready and the call under way, waiting for a person's yes, answered, done with output,
 * failed, or refused.
 */
export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

/** Every prop a Tool takes. */
export interface ToolProps {
  /** Its ToolHeader, then its ToolContent. */
  children: ReactNode;
  /**
   * Open on its input and output at first.
   * @default false
   */
  defaultOpen?: boolean;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /** Runs when the header opens or closes it. */
  onOpenChange?: (open: boolean) => void;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a ToolHeader takes. */
export interface ToolHeaderProps {
  /** The tool's own name, as the assistant called it (`web_search`). Shown when there is no `title`. */
  name: string;
  /** What the call does, in a few words, in the tense of its state ("Searched the web"). */
  title?: string;
  /** Where the call stands: a Badge after the title, in its words and colour. */
  state: ToolState;
  /** A mark of the tool's own, in place of the wrench. */
  icon?: IconData;
}

/** Every prop a ToolContent takes. */
export interface ToolContentProps {
  /** Its ToolInput and ToolOutput. */
  children: ReactNode;
}

/** Every prop a ToolInput takes. */
export interface ToolInputProps {
  /** What went into the tool: its arguments, as an object (shown as JSON) or as text. */
  input: unknown;
}

/** Every prop a ToolOutput takes. */
export interface ToolOutputProps {
  /**
   * What came back: an object (shown as JSON), text, or an element of the product's own (a card
   * for that tool's result), drawn as it is.
   */
  output?: unknown;
  /** Why the call failed, in words. Given, it stands in the output's place. */
  errorText?: string;
}

// CodeBlock, loaded the first time the call opens: one module, its parts each a lazy part;
// NotYetShown stands in until then.
const codeBlock = async () => await import("./code-block");
const CodeBlock = lazyPart(codeBlock, (module) => module.CodeBlock);
const CodeBlockHeader = lazyPart(codeBlock, (module) => module.CodeBlockHeader);
const CodeBlockTitle = lazyPart(codeBlock, (module) => module.CodeBlockTitle);
const CodeBlockActions = lazyPart(
  codeBlock,
  (module) => module.CodeBlockActions
);
const CodeBlockCopyButton = lazyPart(
  codeBlock,
  (module) => module.CodeBlockCopyButton
);
const CodeBlockContent = lazyPart(
  codeBlock,
  (module) => module.CodeBlockContent
);

const styles = stylex.create({
  // The call's card: a hairline round it, its header and content inset by the row's padding.
  root: {
    display: "grid",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingInline: size.collapsiblePadding,
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.border, [media.forcedColors]: "CanvasText" },
    borderRadius: radius.base,
    cornerShape: radius.shape,
  },
  // The header's row in the card: Trace's row runs over the card's edge, a step of room round its line.
  header: { display: "grid" },
  // Its input and output, under the header, a step apart.
  content: {
    display: "grid",
    rowGap: space["3"],
    minWidth: 0,
    paddingBlockEnd: space["2"],
  },
  // The code before CodeBlock is loaded: as it came, line for line.
  plain: {
    margin: 0,
    fontFamily: font.mono,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // The Badge beside the title, as the line's other parts stand: in the run of the line.
  badge: { display: "inline-flex", minWidth: 0 },
  // A product's own card for the output: named Output, drawn as it is.
  custom: {
    display: "grid",
    minWidth: 0,
  },
});

/**
 * A state as the header shows it: the line's status, whether a screen reader hears the Badge's
 * words too (the states a status cannot say), and the Badge's colour and mark.
 */
interface Look {
  status?: TraceLineStatus;
  said: boolean;
  variant: BadgeVariant;
  icon?: IconData;
}

const looks: Record<ToolState, Look> = {
  "input-streaming": {
    status: "running",
    said: false,
    variant: "default",
    icon: ClockIcon,
  },
  "input-available": {
    status: "running",
    said: false,
    variant: "default",
    icon: LoaderIcon,
  },
  "approval-requested": {
    status: "pending",
    said: true,
    variant: "warning",
    icon: ClockIcon,
  },
  "approval-responded": {
    status: "running",
    said: true,
    variant: "info",
    icon: CheckIcon,
  },
  "output-available": {
    said: false,
    variant: "success",
    icon: CircleCheckIcon,
  },
  "output-error": {
    status: "error",
    said: false,
    variant: "destructive",
    icon: CircleAlertIcon,
  },
  "output-denied": { said: true, variant: "warning", icon: XIcon },
};

/** The state's Badge: its words, colour and mark. */
const ToolBadge = ({ look, word }: { look: Look; word: string }) => (
  <Badge size="sm" variant={look.variant} icon={look.icon}>
    {word}
  </Badge>
);

// Whether the call has been open, for its code to load.
const ShownContext = createContext(false);

/** One call to a tool, behind a header that opens on its input and output. */
export const Tool = ({
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  style,
}: ToolProps) => {
  const [opened, setOpened] = useState(defaultOpen);
  const isOpen = open ?? opened;
  // Its code loads once it has been open; the server always draws it.
  const [shown, setShown] = useState(isOpen);
  if (isOpen && !shown) {
    setShown(true);
  }
  return (
    <div
      data-slot="tool"
      {...stylex.props(styles.root, traceCardMarker, style)}
    >
      <Trace>
        <TraceCollapsible
          open={isOpen}
          onOpenChange={(next) => {
            setOpened(next);
            onOpenChange?.(next);
          }}
        >
          <ShownContext value={shown || typeof document === "undefined"}>
            {children}
          </ShownContext>
        </TraceCollapsible>
      </Trace>
    </div>
  );
};

/** The header: the tool's mark, what the call does and its state's Badge; Trace adds the chevron. */
export const ToolHeader = ({ name, title, state, icon }: ToolHeaderProps) => {
  const words = useI18n().tool;
  // A state this file does not know is a neutral Badge, its own name said after the title.
  const look = ownValue(looks, state) ?? { said: true, variant: "default" };
  const word = ownValue(words.states, state) ?? state;
  const shown = title === undefined || title === "" ? name : title;
  return (
    <div data-slot="tool-header" {...stylex.props(styles.header)}>
      <TraceCollapsibleTrigger>
        <TraceLine status={look.status}>
          <TraceIcon>
            <Icon icon={icon ?? WrenchIcon} />
          </TraceIcon>
          <TraceTitle>{shown}</TraceTitle>
          {look.said ? (
            <TraceDescription>
              <ToolBadge look={look} word={word} />
            </TraceDescription>
          ) : (
            // The line's status says it to a screen reader; the Badge, to the eye.
            <span aria-hidden="true" {...stylex.props(styles.badge)}>
              <ToolBadge look={look} word={word} />
            </span>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
    </div>
  );
};

/** What opens under the header: the input, then the output. */
export const ToolContent = ({ children }: ToolContentProps) => (
  <TraceCollapsibleContent>
    <div data-slot="tool-content" {...stylex.props(styles.content)}>
      {children}
    </div>
  </TraceCollapsibleContent>
);

/** Code under the header, named by its title, in a small CodeBlock once the call has opened. */
const ToolCode = ({
  title,
  code,
  language,
  variant = "default",
}: {
  title: string;
  code: string;
  language: string;
  variant?: "default" | "destructive";
}) => {
  const shown = use(ShownContext);
  return (
    <Suspense fallback={<pre {...stylex.props(styles.plain)}>{code}</pre>}>
      {shown ? (
        <CodeBlock language={language} variant={variant}>
          <CodeBlockHeader>
            <CodeBlockTitle>{title}</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={code} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap maxLines={12}>
            {code}
          </CodeBlockContent>
        </CodeBlock>
      ) : (
        <NotYetShown />
      )}
    </Suspense>
  );
};

/** What went in, as code, named Input. */
export const ToolInput = ({ input }: ToolInputProps) => {
  const words = useI18n().tool;
  return (
    <div data-slot="tool-input">
      <ToolCode
        title={words.input}
        code={codeOf(input)}
        language={typeof input === "string" ? "text" : "json"}
      />
    </div>
  );
};

/** What came back, named Output: as code, or the product's own card; or why it failed, named Error. */
export const ToolOutput = ({ output, errorText }: ToolOutputProps) => {
  const words = useI18n().tool;
  if (errorText !== undefined && errorText !== "") {
    return (
      <div data-slot="tool-output" data-error="">
        <ToolCode
          title={words.error}
          code={errorText}
          language="text"
          variant="destructive"
        />
      </div>
    );
  }
  if (output === undefined || output === null) {
    return null;
  }
  // The product's own card, or several (a list of elements is not JSON: it holds itself in development).
  if (
    isValidElement(output) ||
    (Array.isArray(output) &&
      output.length > 0 &&
      output.every((each: unknown) => isValidElement(each)))
  ) {
    return (
      <section
        aria-label={words.output}
        data-slot="tool-output"
        {...stylex.props(styles.custom)}
      >
        {output}
      </section>
    );
  }
  return (
    <div data-slot="tool-output">
      <ToolCode
        title={words.output}
        code={codeOf(output)}
        language={typeof output === "string" ? "text" : "json"}
      />
    </div>
  );
};
