// Confirmation: a step that waits for a person's yes, from shadcn's Confirmation pattern
// (content/docs/ai-elements/base/confirmation.mdx), built as it builds it: an outlined small Item,
// the title its ItemTitle, the answers its ItemActions and each answer a small Button. The title and
// the answers share a row while there is room, the answers at its end; what the step touches
// (ConfirmationDetails) takes a line of its own between them. It knows only the state it is given,
// the AI SDK's tool state and its approval:
// while approval is requested it says the request and offers the answers; once answered it says what
// was decided, and the answers go.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Confirmation state={part.state} approval={part.approval}>
//     <ConfirmationTitle>
//       <ConfirmationRequest>Delete the 3 drafts in Archive?</ConfirmationRequest>
//       <ConfirmationAccepted>Approved: the drafts are deleted.</ConfirmationAccepted>
//       <ConfirmationRejected>Declined: the drafts stay.</ConfirmationRejected>
//     </ConfirmationTitle>
//     <ConfirmationActions>
//       <ConfirmationAction variant="outline" onClick={() => respond(false)}>Decline</ConfirmationAction>
//       <ConfirmationAction onClick={() => respond(true)}>Approve</ConfirmationAction>
//     </ConfirmationActions>
//   </Confirmation>
//
// A group named by its title; each answer is a button named by its words and described by the
// request, so a screen reader hears what it answers. An answer that returns a Promise works in place
// until it settles, and one that fails says so on its own button and can be pressed again. An
// agent's press waits for the person's yes (UI SDK's agent bridge). Once answered, focus that was on
// an answer lands on the title, which now says the decision. A grave answer is held (`hold`). A
// settled answer's own follow-up (an Undo) goes in ConfirmationAccepted or ConfirmationRejected,
// outside the title: they show any children once the answer is given.
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { focusRingText } from "../lib/styles";
import { colors, font, size, space } from "../lib/tokens.stylex";
import { announce } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonVariant } from "./button";
import { HoldButton } from "./hold-button";
import { Item, ItemActions, ItemContent, ItemTitle } from "./item";
import type { ToolState } from "./tool";

/** The approval the step waits on: its id, and once answered whether it was approved, and why. */
interface ConfirmationApproval {
  id: string;
  approved?: boolean;
  reason?: string;
}

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a Confirmation takes. */
export interface ConfirmationProps {
  /** A ConfirmationTitle, any ConfirmationDetails and the ConfirmationActions. */
  children: ReactNode;
  /**
   * Where the step is, as the AI SDK's tool part says: `approval-requested` waits for the answer;
   * `approval-responded`, `output-available` and `output-denied` once it is given. While the input
   * is still coming (`input-streaming`, `input-available`) it draws nothing.
   */
  state: ToolState;
  /** The approval: its `id`, and `approved` (with a `reason`) once answered. Without it, nothing draws. */
  approval?: ConfirmationApproval;
  /** Layout only: where it sits and how wide it is. It stands at most `confirmation-width` wide. */
  style?: LayoutStyle;
}

/** Every prop a ConfirmationTitle takes. */
export interface ConfirmationTitleProps {
  /** A ConfirmationRequest, a ConfirmationAccepted and a ConfirmationRejected: the one for the state shows. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ConfirmationRequest takes. */
export interface ConfirmationRequestProps {
  /** What is asked, in one sentence, a verb first ("Delete the 3 drafts in Archive?"). Shown while it waits. */
  children: ReactNode;
}

/** Every prop a ConfirmationAccepted takes. */
export interface ConfirmationAcceptedProps {
  /**
   * What the yes did, once approved: in the title, its words; after the title, what follows the
   * answer (an Undo).
   * @default `confirmation.approved` ("Approved")
   */
  children?: ReactNode;
}

/** Every prop a ConfirmationRejected takes. */
export interface ConfirmationRejectedProps {
  /**
   * What the no did, once declined: in the title, its words; after the title, what follows the
   * answer.
   * @default `confirmation.declined` ("Declined")
   */
  children?: ReactNode;
}

/** Every prop a ConfirmationDetails takes. */
export interface ConfirmationDetailsProps {
  /** What the step touches: each a name, a quiet line about what happens to it, and a mark if it helps. */
  items: readonly { label: string; detail?: string; icon?: IconData }[];
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ConfirmationActions takes. */
export interface ConfirmationActionsProps {
  /** The answers, as ConfirmationActions: the way out first, the yes last. Shown while it waits. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ConfirmationAction takes. */
export interface ConfirmationActionProps {
  /** Its words, a verb that says what it does ("Approve", "Delete drafts"). */
  children: ReactNode;
  /**
   * Button's variant: `default` for the yes, `outline` for the way out beside it, `destructive`
   * for a yes that deletes.
   * @default "default"
   */
  variant?: ButtonVariant;
  /**
   * Gives the answer. Return a Promise and the button works until it settles; when it rejects, the
   * button says `errorLabel` and can be pressed again.
   */
  onClick?: () => unknown;
  /**
   * Matters enough to hold: the answer goes only once the press is held, or once a tap's own
   * confirmation is pressed (HoldButton).
   * @default false
   */
  hold?: boolean;
  /**
   * Out of use.
   * @default false
   */
  disabled?: boolean;
  /**
   * The words on the button when the answer failed.
   * @default `confirmation.failed` ("Failed")
   */
  errorLabel?: string;
  /**
   * What an agent's press is said to do as the person is asked first.
   * @default `Presses "<its words>"`
   */
  agentConfirm?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  root: {
    display: "grid",
    width: "100%",
    maxWidth: size.confirmationWidth,
    minWidth: 0,
  },
  // The title and the answers on one row while there is room, the answers at its end; the
  // details on a line of their own.
  stack: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
    minWidth: 0,
  },
  title: {
    flexGrow: 1,
    flexBasis: "10rem",
    minWidth: 0,
    textWrap: "pretty",
    overflowWrap: "anywhere",
  },
  details: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    flexBasis: "100%",
    gap: space["1"],
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
  },
  detail: {
    display: "flex",
    alignItems: "baseline",
    gap: space["2"],
    minWidth: 0,
  },
  detailIcon: {
    display: "inline-flex",
    alignSelf: "center",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  detailLine: {
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  actions: {
    display: "contents",
  },
});

interface ConfirmationContextValue {
  state: ToolState;
  approval: ConfirmationApproval;
  titleId: string;
  requestId: string;
}

const ConfirmationContext = createContext<ConfirmationContextValue | null>(
  null
);

/** Whether the answer is given: the approval responded to, and what came of it. */
const answered = (state: ToolState) =>
  state === "approval-responded" ||
  state === "output-available" ||
  state === "output-denied";

/**
 * Once answered, the answers go: focus that was on one lands on the title, which says the decision;
 * else the decision is said once. Asked again (an Undo in ConfirmationAccepted), focus that was on
 * the settled answer lands on the title, which says the request again.
 */
const useDecisionFocus = (requested: boolean, titleId: string) => {
  const before = useRef(requested);
  const inside = useRef(false);
  useEffect(() => {
    if (before.current === requested) {
      return;
    }
    before.current = requested;
    const title = document.querySelector<HTMLElement>(
      `#${CSS.escape(titleId)}`
    );
    if (inside.current || document.activeElement === document.body) {
      title?.focus({ preventScroll: true });
    } else if (!requested) {
      announce(title?.textContent ?? "");
    }
  }, [requested, titleId]);
  return {
    handleFocus: () => {
      inside.current = true;
    },
    handleBlur: (event: { currentTarget: Element; relatedTarget: unknown }) => {
      if (
        event.relatedTarget instanceof Node &&
        !event.currentTarget.contains(event.relatedTarget)
      ) {
        inside.current = false;
      }
    },
  };
};

/** The step and its approval: a group named by its title. */
export const Confirmation = ({
  children,
  state,
  approval,
  style,
}: ConfirmationProps) => {
  const titleId = useId();
  const requestId = useId();
  const requested = state === "approval-requested";
  const focus = useDecisionFocus(requested, titleId);
  if (
    approval === undefined ||
    state === "input-streaming" ||
    state === "input-available"
  ) {
    return null;
  }
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the group hears where focus is, to hand it on once answered
    <div
      role="group"
      aria-labelledby={titleId}
      data-slot="confirmation"
      data-state={state}
      onFocus={focus.handleFocus}
      onBlur={focus.handleBlur}
      {...stylex.props(styles.root, style)}
    >
      <ConfirmationContext
        // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
        value={{ state, approval, titleId, requestId }}
      >
        <Item variant="outline" size="sm">
          <ItemContent>
            <span {...stylex.props(styles.stack)}>{children}</span>
          </ItemContent>
        </Item>
      </ConfirmationContext>
    </div>
  );
};

/** The sentence: what is asked while it waits, what was decided once answered. */
export const ConfirmationTitle = ({
  children,
  style,
}: ConfirmationTitleProps) => {
  const context = use(ConfirmationContext);
  return (
    <span {...stylex.props(styles.title, style)}>
      <ItemTitle>
        <span
          id={context?.titleId}
          tabIndex={-1}
          data-slot="confirmation-title"
          {...stylex.props(focusRingText)}
        >
          {children}
        </span>
      </ItemTitle>
    </span>
  );
};

/** What is asked: shown while the approval is requested, and the description of each answer. */
export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const context = use(ConfirmationContext);
  if (context?.state !== "approval-requested") {
    return null;
  }
  return (
    <span id={context.requestId} data-slot="confirmation-request">
      {children}
    </span>
  );
};

/** What the yes did: shown once approved. */
export const ConfirmationAccepted = ({
  children,
}: ConfirmationAcceptedProps) => {
  const words = useI18n().confirmation;
  const context = use(ConfirmationContext);
  if (
    context === null ||
    context.approval.approved !== true ||
    !answered(context.state)
  ) {
    return null;
  }
  return (
    <span data-slot="confirmation-accepted">{children ?? words.approved}</span>
  );
};

/** What the no did: shown once declined. */
export const ConfirmationRejected = ({
  children,
}: ConfirmationRejectedProps) => {
  const words = useI18n().confirmation;
  const context = use(ConfirmationContext);
  if (
    context === null ||
    context.approval.approved !== false ||
    !answered(context.state)
  ) {
    return null;
  }
  return (
    <span data-slot="confirmation-rejected">{children ?? words.declined}</span>
  );
};

/** What the step touches, a row each: a mark, its name and a quiet line. */
export const ConfirmationDetails = ({
  items,
  style,
}: ConfirmationDetailsProps) => (
  <ul data-slot="confirmation-details" {...stylex.props(styles.details, style)}>
    {items.map((item, index) => (
      // Two rows may say the same: their place keys them, as they are given whole, never reordered.
      <li key={index} {...stylex.props(styles.detail)}>
        {item.icon !== undefined && (
          <span aria-hidden="true" {...stylex.props(styles.detailIcon)}>
            <Icon icon={item.icon} />
          </span>
        )}
        <span>{item.label}</span>
        {item.detail !== undefined && (
          <span {...stylex.props(styles.detailLine)}>{item.detail}</span>
        )}
      </li>
    ))}
  </ul>
);

/** The answers, at the end of the row: shown while the approval is requested. */
export const ConfirmationActions = ({
  children,
  style,
}: ConfirmationActionsProps) => {
  const context = use(ConfirmationContext);
  if (context?.state !== "approval-requested") {
    return null;
  }
  return (
    <span data-slot="confirmation-actions" {...stylex.props(styles.actions)}>
      <ItemActions style={style}>{children}</ItemActions>
    </span>
  );
};

/** What an agent's press is said to do: an agent's press always waits for the person. */
const confirmOf = (
  given: string | undefined,
  children: ReactNode,
  said: { agentAsks: string; agentPresses: (words: string) => string }
) => {
  if (given !== undefined) {
    return given;
  }
  return typeof children === "string"
    ? said.agentPresses(children)
    : said.agentAsks;
};

/** One answer: a small Button described by the request, or a HoldButton with `hold`. */
export const ConfirmationAction = ({
  children,
  variant = "default",
  onClick,
  hold = false,
  disabled = false,
  errorLabel,
  agentConfirm,
  style,
}: ConfirmationActionProps) => {
  const { agentAsks, agentPresses } = useI18n().action;
  const words = useI18n().confirmation;
  const context = use(ConfirmationContext);
  const failed = errorLabel ?? words.failed;
  const confirm = confirmOf(agentConfirm, children, {
    agentAsks,
    agentPresses,
  });
  const run = async () => {
    await onClick?.();
  };
  if (hold) {
    return (
      <HoldButton
        variant={variant}
        size="sm"
        disabled={disabled}
        agentConfirm={confirm}
        aria-describedby={context?.requestId}
        data-slot="confirmation-action"
        onConfirm={run}
        errorLabel={failed}
        style={style}
      >
        {children}
      </HoldButton>
    );
  }
  return (
    <Button
      asChild
      variant={variant}
      size="sm"
      onClick={run}
      errorLabel={failed}
      agentConfirm={confirm}
      disabled={disabled}
      style={style}
    >
      <button
        type="button"
        data-slot="confirmation-action"
        aria-describedby={context?.requestId}
      >
        {children}
      </button>
    </Button>
  );
};
