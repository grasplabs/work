import { failureText } from "@grasp-os/shared/errors";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

// An ask for the person's yes in the Inbox (a held change, a start an
// agent asked for, a permission, a skill to share), on Damsko's
// Confirmation: the ask in one sentence, one quiet line of who asks and
// since when, what to read before answering under Details, then Decline
// and Approve. Confirmation keeps to the yes and the no; what the Inbox
// adds round them lives here: the quiet line, Details, an Approve held back
// with why, and the two answers as one, so the one not pressed waits while
// the other works. Each answer works in place until core has it; one core
// refuses says so on its own button, with core's reason under the ask,
// and the Inbox keeps the item in place until the person moves on, even
// once it waits no more (answered elsewhere). Once
// answered the title says what was decided, and the Inbox reads again, so
// the item leaves.

const styles = stylex.create({
  // What stands between the ask and the answers, on a line of its own.
  line: {
    display: "grid",
    flexBasis: "100%",
    gap: space["2"],
    minWidth: 0,
  },
  // The answers at the row's end, where the eye ends.
  answers: { display: "flex", marginInlineStart: "auto" },
  details: {
    display: "grid",
    gap: space["2"],
    minWidth: 0,
    paddingBlockStart: space["2"],
  },
});

/**
 * Runs `work`, then `settle` whatever came of it; when it fails, says why
 * through `failed` and fails as `work` did, so the button says so too.
 * Outside the component, as the React Compiler can't compile `finally`.
 */
const settled = async (
  work: () => Promise<void>,
  settle: () => void,
  failed: (reason: string) => void
): Promise<void> => {
  try {
    await work();
  } catch (error) {
    failed(failureText(error));
    throw error;
  } finally {
    settle();
  }
};

/**
 * How long the answers of an item that opened in place of one just
 * answered stay out of use: longer than a double click, so a second press
 * meant for the item before never answers this one.
 */
const arrivalPauseMs = 1000;

/**
 * Whether an item's answers may be used: at once, or, for one `arriving`
 * in place of an item just answered, after `arrivalPauseMs`.
 */
export const useArmed = (arriving: boolean): boolean => {
  const [armed, setArmed] = useState(!arriving);
  useEffect(() => {
    const timer = armed
      ? undefined
      : setTimeout(() => {
          setArmed(true);
        }, arrivalPauseMs);
    return () => {
      clearTimeout(timer);
    };
  }, [armed]);
  return armed;
};

/** Where the request stands: waiting, or what was answered here. */
type Answer = { state: "waiting" } | { state: "answered"; approved: boolean };

export const ApprovalRequest = ({
  title,
  asker,
  askedAt,
  approveLabel,
  approveHeld,
  details,
  arriving = false,
  gone = false,
  onApprove,
  onDecline,
}: {
  /** What is asked, in one sentence, a verb first. */
  title: string;
  /** Who asks, by name: Grasp when nobody is named (a chat's agent, an App's run). */
  asker?: string;
  /** When it was asked, as the page writes a date. */
  askedAt?: string;
  /** The words on Approve, when they can say what it does ("Grant it"). */
  approveLabel?: string;
  /** Why Approve waits, while it does: it stays out of use, and Decline stays. */
  approveHeld?: string | undefined;
  /** What to read before answering, under Details. */
  details?: ReactNode;
  /** Opened in place of an item just answered: its answers wait a moment. */
  arriving?: boolean;
  /** Kept on screen after it waits no more: nothing to answer. */
  gone?: boolean;
  /** Gives the yes to core: the button works until it is through, and says so when it fails. */
  onApprove: () => Promise<unknown>;
  onDecline: () => Promise<unknown>;
}) => {
  const { t } = useLingui();
  const approvalId = useId();
  const [answer, setAnswer] = useState<Answer>({ state: "waiting" });
  // The answer being given: the other one waits until it is through.
  const [giving, setGiving] = useState<boolean>();
  // Why core refused the last answer, in its words: the request still waits.
  const [failure, setFailure] = useState<string>();
  const armed = useArmed(arriving);
  // Neither answer, while the item has only just come or waits no more.
  const off = !armed || gone;
  const give = (approved: boolean) => async () => {
    setGiving(approved);
    setFailure(undefined);
    await settled(
      async () => {
        await (approved ? onApprove() : onDecline());
        setAnswer({ state: "answered", approved });
      },
      () => {
        setGiving(undefined);
      },
      setFailure
    );
  };
  const quiet = [asker ?? "Grasp", ...(askedAt === undefined ? [] : [askedAt])];
  return (
    <Confirmation
      approval={
        answer.state === "waiting"
          ? { id: approvalId }
          : { id: approvalId, approved: answer.approved }
      }
      state={
        answer.state === "waiting" ? "approval-requested" : "approval-responded"
      }
    >
      <ConfirmationTitle>
        <ConfirmationRequest>{title}</ConfirmationRequest>
        <ConfirmationAccepted>{t`Approved: ${title}`}</ConfirmationAccepted>
        <ConfirmationRejected>{t`Declined: ${title}`}</ConfirmationRejected>
      </ConfirmationTitle>
      <span {...stylex.props(styles.line)}>
        <Text color="muted" size="sm">
          {quiet.join(" · ")}
        </Text>
        {details === undefined ? null : (
          <Collapsible fitContent>
            <CollapsibleTrigger>{t`Details`}</CollapsibleTrigger>
            <CollapsibleContent>
              <div {...stylex.props(styles.details)}>{details}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {approveHeld === undefined || answer.state !== "waiting" ? null : (
          <Text color="muted" size="xs">
            {approveHeld}
          </Text>
        )}
        {failure === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
      </span>
      <span {...stylex.props(styles.answers)}>
        <ConfirmationActions>
          <ConfirmationAction
            disabled={off || giving === true}
            onClick={give(false)}
            variant="outline"
          >
            {t`Decline`}
          </ConfirmationAction>
          <ConfirmationAction
            disabled={off || giving === false || approveHeld !== undefined}
            onClick={give(true)}
          >
            {approveLabel ?? t`Approve`}
          </ConfirmationAction>
        </ConfirmationActions>
      </span>
    </Confirmation>
  );
};
