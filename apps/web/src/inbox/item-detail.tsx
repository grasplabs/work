import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowBindingTarget } from "@grasp-os/shared/workflow-resources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import type { QuestionnaireAnswer } from "@grasp-os/ui/components/questionnaire";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowUpRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import { focusRingText, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { grantReviewed, reviewedVersion } from "../activity/pending.tsx";
import {
  confirmHeld,
  declineHeld,
  HeldWriteDetails,
  useShown,
} from "../chat/held-writes.tsx";
import type { Session } from "../core.ts";
import { formatDate } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { PendingBindingList } from "../workflows/binding-approvals.tsx";
import { ApprovalRequest, useArmed } from "./approval-request.tsx";
import { DecisionCard } from "./decision-card.tsx";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import type { InboxItem, InboxSource, Target } from "./items.ts";
import { JsonBlock } from "./json-block.tsx";
import { isUnresolvable, OutcomeDetails } from "./outcome-details.tsx";
import { RequestDetails } from "./request-details.tsx";
import { TargetLink } from "./target-link.tsx";

// An item of the inbox, on Damsko: an ask for the person's yes on the
// Inbox's approval request (approval-request.tsx); anything else on a card,
// with what happened, what has to be read before deciding, its actions in
// one row under them, the one that settles it first, and its facts. Each
// action goes to core, and the inbox is read again once it is through, so
// a settled item leaves the list. A question the Brain asked the person is
// answered here, in their own words (`brain.answerGap`); core then lists
// it no more.

const styles = stylex.create({
  // Under the title, before the date: what kind it is, and whether it blocks work.
  marks: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["1"],
    paddingBlockStart: space["2"],
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    minWidth: 0,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  // A Brain question that waits no more: its words and box, off as one.
  closed: {
    borderWidth: 0,
    margin: 0,
    minInlineSize: 0,
    padding: 0,
  },
  closedOff: { opacity: size.opacityDisabled },
});

/** One of an item's actions: a press that goes to core, or the way to where it is done. */
interface Act {
  label: string;
  /** Its name: the word, with what it acts on. */
  name?: string;
  onPress?: () => Promise<void>;
  /** Done on its own page: the button leads there. */
  to?: Target;
  disabled?: boolean;
  /** The id of a line that says why it waits. */
  describedBy?: string;
  /** Asked once more before it is done: for a no that can't be taken back. */
  confirm?: {
    title: string;
    description: string;
    /** How the dialog's button reads: destructive unless saying so is not. */
    variant?: "default" | "destructive";
  };
}

/** An action asked once more in an alert dialog, which closes once core has it. */
const ConfirmedAct = ({
  act,
  confirm,
  disabled,
  describedBy,
  variant,
}: {
  act: Act;
  confirm: NonNullable<Act["confirm"]>;
  disabled: boolean;
  describedBy: string | undefined;
  variant: "default" | "outline";
}) => {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button
          aria-describedby={describedBy}
          aria-label={act.name}
          disabled={disabled}
          focusableWhenDisabled={describedBy !== undefined}
          size="sm"
          variant={variant}
        >
          {act.label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            onClick={async () => {
              await act.onPress?.();
              setOpen(false);
            }}
            variant={confirm.variant ?? "destructive"}
          >
            {act.label}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** An action's button: a press, asked once more where it can't be taken back, or the way to its page. */
const ActButton = ({
  act,
  busy,
  heldBy,
  first,
}: {
  act: Act;
  busy: boolean;
  /** The id of a line that says why every action waits, while it does. */
  heldBy: string | undefined;
  /** The item's own next step: filled; the rest quiet. */
  first: boolean;
}) => {
  const variant = first ? "default" : "outline";
  if (act.to !== undefined) {
    return (
      <Button asChild size="sm" variant={variant}>
        <TargetLink aria-label={act.name} destination={act.to}>
          {act.label}
          <Icon icon={ArrowUpRightIcon} />
        </TargetLink>
      </Button>
    );
  }
  const disabled = busy || act.disabled === true;
  // Off and said why, it stays a Tab stop that says so.
  const why = [act.describedBy, heldBy].filter((id) => id !== undefined);
  const describedBy = disabled && why.length > 0 ? why.join(" ") : undefined;
  if (act.confirm !== undefined) {
    return (
      <ConfirmedAct
        act={act}
        confirm={act.confirm}
        describedBy={describedBy}
        disabled={disabled}
        variant={variant}
      />
    );
  }
  return (
    <Button
      aria-describedby={describedBy}
      aria-label={act.name}
      disabled={disabled}
      focusableWhenDisabled={describedBy !== undefined}
      onClick={() => {
        void act.onPress?.();
      }}
      size="sm"
      variant={variant}
    >
      {act.label}
    </Button>
  );
};

/** What the inbox gives an item: where it stands, and where to say what came of an answer. */
export interface Frame {
  item: InboxItem;
  /** Opened in place of an item just answered: its answers wait a moment. */
  arriving: boolean;
  /** Kept on screen after core refused an answer, though it waits no more. */
  gone: boolean;
  /** Says what was done, for a screen reader: the list only loses the item. */
  onSaid: (said: string) => void;
  /** Core refused an answer: the inbox keeps the item in place until the person moves on. */
  onRefused: () => void;
  /**
   * An answer is through or refused, and the inbox read again: focus that
   * fell to the page goes to the heading of the item in view.
   */
  onLanded: () => void;
}

/**
 * Gives an answer to core, then reads the inbox again whatever came of
 * it, and then says it `landed`. Through: `said`. Refused: `refused` with
 * core's reason, before the inbox is read again (which may no longer list
 * the item), and it fails as core did. Outside components, as the React
 * Compiler can't compile `try`.
 */
const answerThenRefresh = async ({
  give,
  said,
  refused,
  refresh,
  landed,
}: {
  give: () => Promise<unknown>;
  said: () => void;
  refused: (reason: string) => void;
  refresh: () => Promise<void>;
  landed: () => void;
}): Promise<void> => {
  try {
    await give();
  } catch (error) {
    refused(failureText(error));
    await refresh();
    landed();
    throw error;
  }
  said();
  await refresh();
  landed();
};

/** The item's facts, with who it is for first when it is someone in particular: an admin's by default. */
const useFacts = (item: InboxItem): KeyValueItem[] => {
  const { t } = useLingui();
  const facts: KeyValueItem[] = item.facts.map(({ label, value }) => ({
    id: label,
    label,
    value,
  }));
  if (item.forWhom !== undefined && "role" in item.forWhom) {
    const { role } = item.forWhom;
    facts.unshift({ id: "for", label: t`For`, value: t`The ${role}` });
  } else if (item.forWhom !== undefined) {
    facts.unshift({ id: "for", label: t`For`, value: item.forWhom.person });
  }
  return facts;
};

/** The item as it is shown: what happened, what to read, its actions, and its facts. */
const ItemFrame = ({
  frame,
  extra,
  renderAnswers,
  acts,
  busy,
  failure,
}: {
  frame: Frame;
  /** What has to be read before deciding, under what happened. */
  extra?: ReactNode;
  /** Answers of the item's own there, drawn with whether they are held. */
  renderAnswers?: (held: boolean) => ReactNode;
  acts: Act[];
  busy: boolean;
  failure: string | undefined;
}) => {
  const { t, i18n } = useLingui();
  const titleId = useId();
  const pauseId = useId();
  const armed = useArmed(frame.arriving);
  // No action while the item has only just come, or waits no more.
  const held = busy || !armed || frame.gone;
  // The pause after an answer, said to a screen reader: on each action,
  // and beside answers of the item's own that can't say it themselves.
  const paused =
    !armed &&
    !busy &&
    !frame.gone &&
    (acts.length > 0 || renderAnswers !== undefined);
  const { item } = frame;
  // With no action of its own, the item is dealt with where it lives.
  const shown: Act[] =
    acts.length === 0 && item.about !== undefined
      ? [{ label: t`Open`, to: item.about }]
      : acts;
  const facts = useFacts(item);
  return (
    <Card asChild size="sm">
      <article aria-labelledby={titleId}>
        <CardHeader>
          {/* Where focus lands once an answer is through or refused. */}
          <span
            data-item-heading
            id={titleId}
            tabIndex={-1}
            {...stylex.props(focusRingText)}
          >
            <CardTitle level={2}>{item.title}</CardTitle>
          </span>
          <span {...stylex.props(styles.marks)}>
            <Badge icon={kindMark[item.kind]} size="sm">
              {i18n._(kindLabel[item.kind])}
            </Badge>
            {item.urgent ? (
              <Badge size="sm" variant="warning">
                <Trans context="inbox: something waits on this item">
                  Blocks work
                </Trans>
              </Badge>
            ) : null}
          </span>
          {item.date === "" ? null : (
            <CardDescription>{formatDate(item.date)}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div {...stylex.props(styles.body)}>
            {item.body.map((paragraph) => (
              <Text key={paragraph} size="sm">
                {paragraph}
              </Text>
            ))}
            {extra}
            {renderAnswers?.(held)}
            {shown.length === 0 ? null : (
              <div {...stylex.props(styles.actions)}>
                {shown.map((act, index) => (
                  <ActButton
                    act={act}
                    busy={held}
                    first={index === 0}
                    heldBy={paused ? pauseId : undefined}
                    key={act.label}
                  />
                ))}
              </div>
            )}
            {paused ? (
              <span id={pauseId} {...stylex.props(visuallyHidden)}>
                {t`Its answers can be used in a moment, so a press meant for the one before doesn't answer it.`}
              </span>
            ) : null}
            {failure === undefined ? null : (
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
            {/* What the item shows to answer it says these already, in
                its own words; the panel lists them under it. */}
            {extra === undefined &&
            renderAnswers === undefined &&
            facts.length > 0 ? (
              <KeyValueList items={facts} orientation="horizontal" />
            ) : null}
          </div>
        </CardContent>
      </article>
    </Card>
  );
};

/**
 * Makes a change, says what was done, and reads the inbox again whatever
 * came of it; refused, the item is kept with core's reason.
 */
const useDecide = (frame: Frame) => {
  const router = useRouter();
  const action = useCoreAction();
  const decide = async (
    change: (session: Session) => Promise<unknown>,
    said: string
  ): Promise<void> => {
    await action.run(async (session) => {
      await answerThenRefresh({
        give: async () => await change(session),
        said: () => {
          frame.onSaid(said);
        },
        refused: () => {
          frame.onRefused();
        },
        refresh: async () => {
          // `sync` waits for the read, so the buttons stay off until the item goes.
          await router.invalidate({ sync: true });
        },
        landed: frame.onLanded,
      });
    });
  };
  return { ...action, decide };
};

/**
 * An ask for the person's yes (a held change, a start an agent asked for,
 * a permission): on the Inbox's approval request, with what to read under
 * Details. Each answer goes to core as the person; one core refuses fails
 * on its own button, and the item stays, read again: a refused grant then
 * shows the version there is now, to review that one instead. Once it is
 * through, the item leaves.
 */
const ApprovalFrame = ({
  frame,
  details,
  approveLabel,
  approveHeld,
  onApprove,
  onDecline,
}: {
  frame: Frame;
  details?: ReactNode;
  approveLabel?: string;
  /** Why Approve waits, while it does. */
  approveHeld?: string | undefined;
  onApprove: (session: Session) => Promise<unknown>;
  onDecline: (session: Session) => Promise<unknown>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const core = useCore();
  const { item } = frame;
  // Core's reason stands under the ask, said by ApprovalRequest itself.
  const answer =
    (change: (session: Session) => Promise<unknown>, said: string) =>
    async () => {
      await answerThenRefresh({
        give: async () => await core.withSession(change),
        said: () => {
          frame.onSaid(said);
        },
        refused: () => {
          frame.onRefused();
        },
        refresh: async () => {
          await router.invalidate({ sync: true });
        },
        landed: frame.onLanded,
      });
    };
  const { title } = item;
  return (
    <ApprovalRequest
      approveHeld={approveHeld}
      approveLabel={approveLabel}
      arriving={frame.arriving}
      gone={frame.gone}
      asker={item.asker}
      askedAt={item.date === "" ? undefined : formatDate(item.date)}
      details={details}
      onApprove={answer(onApprove, t`Approved: ${title}`)}
      onDecline={answer(onDecline, t`Declined: ${title}`)}
      title={title}
    />
  );
};

/**
 * A held write: confirming it is for what the person was shown, all of
 * it. Confirm waits, with why, until every part of what it sends was shown.
 */
const HeldItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "held" }>;
}) => {
  const { t } = useLingui();
  const { action } = source;
  const shown = useShown(action);
  // Nobody approves what they can't read: withheld, it is only declined.
  let approveHeld: string | undefined;
  if (action.withheld === "revoked") {
    approveHeld = t`What this would send is withheld: the run that asked for it may no longer read what it read, so you can only decline it.`;
  } else if (action.withheld === "unchecked") {
    approveHeld = t`What this would send can't be shown right now, so you can only decline it for now. Try again in a moment.`;
  } else if (shown.unseen) {
    approveHeld = t`Part of what will be sent is cut short. Open Details and show it all, or exactly what will be sent, to confirm.`;
  }
  return (
    <ApprovalFrame
      approveHeld={approveHeld}
      approveLabel={t`Confirm`}
      details={<HeldWriteDetails action={action} shown={shown} />}
      frame={frame}
      onApprove={confirmHeld(action)}
      onDecline={declineHeld(action)}
    />
  );
};

/**
 * A start of a workflow a chat's agent asked for: approving starts it, as
 * the agent acting for the person, with exactly the input shown.
 */
const HeldStartItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "heldStart" }>;
}) => {
  const { t } = useLingui();
  const { start } = source;
  return (
    <ApprovalFrame
      approveLabel={t`Start it`}
      details={<JsonBlock title={t`What it starts with`} value={start.args} />}
      frame={frame}
      onApprove={async (session) => {
        await session.heldStarts.confirm(start.id, start.argsHash);
      }}
      onDecline={async (session) => {
        await session.heldStarts.decline(start.id);
      }}
    />
  );
};

/** A permission request: approving grants it for the version of its App that was reviewed. */
const RequestItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "request" }>;
}) => {
  const { t } = useLingui();
  const { request, pending } = source;
  return (
    <ApprovalFrame
      approveLabel={t`Grant it`}
      details={
        <RequestDetails directory={pending.directory} request={request} />
      }
      frame={frame}
      onApprove={async (session) =>
        await grantReviewed(
          session.permissions,
          request,
          reviewedVersion(request, pending.directory)
        )
      }
      onDecline={async (session) =>
        await session.permissions.decline(request.id)
      }
    />
  );
};

/**
 * A change whose answer was lost: "It happened" or "It didn't happen", each
 * asked once more. Saying it didn't happen lets it go out again, so it
 * waits while part of what was sent is cut short and unseen, or no longer
 * kept.
 */
const OutcomeItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "outcome" }>;
}) => {
  const { t } = useLingui();
  const { outcome } = source;
  const shown = useShown(outcome);
  const unresolvableId = useId();
  const removedId = useId();
  const { busy, failure, decide } = useDecide(frame);
  const who = frame.item.context;
  const connection = outcome.connectionName ?? outcome.key.connectionId;
  const unresolvable = isUnresolvable(outcome);
  const removed = outcome.input === null;
  // The line that says why "It didn't happen" waits, if it does.
  let whyNot: string | undefined;
  if (unresolvable) {
    whyNot = unresolvableId;
  } else if (removed) {
    whyNot = removedId;
  } else if (shown.unseen) {
    whyNot = shown.unseenId;
  }
  return (
    <ItemFrame
      acts={[
        {
          label: t`It happened`,
          name: t`It happened: ${who}`,
          // Saying it happened sends nothing: it doesn't wait for all of it to be seen.
          disabled: unresolvable,
          describedBy: unresolvable ? unresolvableId : undefined,
          confirm: {
            title: t`Say it happened?`,
            description: t`Grasp records your word that it took effect and never sends it again; a run waiting on it goes on without the answer that was lost. Nothing is changed or undone on ${connection}.`,
            variant: "default",
          },
          onPress: async () => {
            await decide(
              async (session) => {
                await session.unknownOutcomes.resolve(
                  outcome.key,
                  "happened",
                  outcome.claim
                );
              },
              t`Said it happened: ${who}.`
            );
          },
        },
        {
          label: t`It didn't happen`,
          name: t`It didn't happen: ${who}`,
          disabled: unresolvable || removed || shown.unseen,
          describedBy: whyNot,
          confirm: {
            title: t`Say it didn't happen?`,
            description: t`Grasp lets it be sent once more, exactly as before, and a run waiting on it sends it again now. Nothing is undone: if it did take effect on ${connection}, it takes effect twice.`,
          },
          onPress: async () => {
            await decide(
              async (session) => {
                await session.unknownOutcomes.resolve(
                  outcome.key,
                  "not_happened",
                  outcome.claim
                );
              },
              t`Said it didn't happen: ${who}.`
            );
          },
        },
      ]}
      busy={busy}
      extra={
        <OutcomeDetails
          outcome={outcome}
          removedId={removedId}
          shown={shown}
          unresolvableId={unresolvableId}
        />
      }
      failure={failure}
      frame={frame}
    />
  );
};

/**
 * A version of a workflow whose bindings no admin approved: each approved
 * here for the version shown, through the workflow's own approval, which
 * checks again that the person is an admin and that the target serves.
 */
const BindingsDetail = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "bindings" }>;
}) => {
  const { t } = useLingui();
  const { workflow, version, bindings } = source.item.pending;
  const { busy, failure, decide } = useDecide(frame);
  const approve = async (
    alias: string,
    target: WorkflowBindingTarget
  ): Promise<void> => {
    const { name } = workflow;
    await decide(
      async (session) => {
        await session.workflowResources.approveBinding(workflow.id, {
          alias,
          target,
          reviewed: { version },
        });
      },
      t`Approved: ${alias} of ${name}.`
    );
  };
  return (
    <ItemFrame
      acts={[]}
      busy={busy}
      renderAnswers={(held) => (
        <PendingBindingList
          bindings={bindings}
          busy={held}
          elsewhere={workflow.id}
          onApprove={approve}
        />
      )}
      failure={failure}
      frame={frame}
    />
  );
};

/**
 * A question the Brain asked the person: answered here, in their own
 * words, for everyone in the company to read with their name. Once it is
 * answered core lists it no more, so it leaves the inbox. One core
 * refuses says core's reason, once; when it waits no more (answered
 * elsewhere) its box and Answer are off, so nothing more goes to core.
 */
const AskedItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "asked" }>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const core = useCore();
  const { notification } = source;
  const { owner, question } = notification;
  const asked = t`Asked of you as the ${owner}`;
  // Why core refused the answer, in its words: answered already, say
  // (`brain.gap_closed`).
  const [failure, setFailure] = useState<string>();
  // The words, kept across a refusal: the Questionnaire is drawn afresh
  // then (`tries`), so only core's reason says it failed, not its own
  // "Could not send" beside it.
  const [words, setWords] = useState("");
  const [tries, setTries] = useState(0);
  const closed = frame.gone;
  const answer = async (
    answers: Record<string, QuestionnaireAnswer>
  ): Promise<void> => {
    const text = answers.answer?.text.trim() ?? "";
    setFailure(undefined);
    await answerThenRefresh({
      give: async () =>
        await core.withSession(
          async (session) =>
            await session.brain.answerGap(notification.gap, text)
        ),
      said: () => {
        frame.onSaid(t`Answered: ${question}`);
      },
      refused: (reason) => {
        setFailure(reason);
        setTries(tries + 1);
        frame.onRefused();
      },
      refresh: async () => {
        await router.invalidate({ sync: true });
      },
      landed: frame.onLanded,
    });
  };
  return (
    <ItemFrame
      acts={[]}
      busy={false}
      renderAnswers={(held) => (
        <Questionnaire aria-label={t`Question`} key={tries} onSubmit={answer}>
          <fieldset
            disabled={closed}
            {...stylex.props(styles.closed, closed && styles.closedOff)}
          >
            <QuestionnaireItem name="answer" required>
              <QuestionnaireTitle>{question}</QuestionnaireTitle>
              <QuestionnaireInput onValueChange={setWords} value={words} />
              <QuestionnaireError />
            </QuestionnaireItem>
          </fieldset>
          <QuestionnaireActions>
            <QuestionnaireSubmit disabled={held}>
              {t`Answer`}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      )}
      failure={failure}
      frame={{ ...frame, item: { ...frame.item, title: asked } }}
    />
  );
};

/**
 * A decision a workflow's run waits for: answered here, on the card its
 * own page shows (decision-card.tsx), which asks the person to confirm
 * the answer; once it is recorded the inbox is read again, and the item
 * goes.
 */
const DecisionItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "decision" }>;
}) => {
  const router = useRouter();
  const armed = useArmed(frame.arriving);
  return (
    <DecisionCard
      decision={source.decision}
      held={!armed || frame.gone}
      onAnswered={(said) => {
        frame.onSaid(said);
        void (async () => {
          await router.invalidate({ sync: true });
          frame.onLanded();
        })();
      }}
    />
  );
};

/** What is done on its own page: its next step leads there. */
const ElsewhereItem = ({ frame }: { frame: Frame }) => {
  const { t } = useLingui();
  const { item } = frame;
  const labels: Partial<Record<InboxSource["type"], string>> = {
    reconnect: t`Sign in again`,
    stoppedEvents: t`Open the connection`,
    appMessage: t`Open the App`,
  };
  const label = labels[item.source.type] ?? t`Review`;
  return (
    <ItemFrame
      acts={item.about === undefined ? [] : [{ label, to: item.about }]}
      busy={false}
      failure={undefined}
      frame={frame}
    />
  );
};

/** The item, by what it was made from. */
export const ItemDetail = (frame: Frame) => {
  const { source } = frame.item;
  if (source.type === "held") {
    return <HeldItem frame={frame} source={source} />;
  }
  if (source.type === "heldStart") {
    return <HeldStartItem frame={frame} source={source} />;
  }
  if (source.type === "outcome") {
    return <OutcomeItem frame={frame} source={source} />;
  }
  if (source.type === "request") {
    return <RequestItem frame={frame} source={source} />;
  }
  if (source.type === "bindings") {
    return <BindingsDetail frame={frame} source={source} />;
  }
  if (source.type === "asked") {
    return <AskedItem frame={frame} source={source} />;
  }
  if (source.type === "decision") {
    return <DecisionItem frame={frame} source={source} />;
  }
  return <ElsewhereItem frame={frame} />;
};
