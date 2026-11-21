import type { WorkflowBindingTarget } from "@grasp-os/shared/workflow-resources";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { grantReviewed, reviewedVersion } from "../activity/pending.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
import { draftOf } from "../chat/held-drafts.ts";
import {
  confirmHeld,
  declineHeld,
  HeldWriteDetails,
  HeldWriteDraft,
  useShown,
} from "../chat/held-writes.tsx";
import type { Session } from "../core.ts";
import { formatDate, formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import {
  ApprovalRequest,
  ApprovalRequestApprove,
} from "../grasp/approval-request/index.ts";
import type { ApprovalWords } from "../grasp/approval-request/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { External } from "../grasp/icons/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import {
  QuestionTool,
  QuestionToolSubmit,
} from "../grasp/question-tool/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { PendingBindingList } from "../workflows/binding-approvals.tsx";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import { InterviewsDetail } from "./interviews-item.tsx";
import type { InboxItem, InboxSource, Target } from "./items.ts";
import { isUnresolvable, OutcomeDetails } from "./outcome-details.tsx";
import { RequestDetails } from "./request-details.tsx";
import { TargetLink } from "./target-link.tsx";

// An item of the inbox, on Grasp UI: what it is and what happened, what
// has to be read before deciding, its facts, and its actions in one row
// under them, the one that settles it first. Each action goes to core with
// the same calls the dashboard's pile makes, and the inbox is read again
// once it is through, so a settled item leaves the list. A question the
// brain asked the person is answered here, in their own words, on the
// Question tool (`brain.answerGap`); core then lists it no more.

const styles = stylex.create({
  item: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    minWidth: 0,
  },
  marks: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
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
    /** How the dialog's button reads: danger unless saying so is not. */
    variant?: "ink" | "danger";
  };
}

/** An action's button: a press, asked once more where it can't be taken back, or the way to its page. */
const ActButton = ({
  act,
  busy,
  first,
}: {
  act: Act;
  busy: boolean;
  /** The item's own next step: ink; the rest quiet. */
  first: boolean;
}) => {
  const { t } = useLingui();
  const variant = first ? "ink" : "quiet";
  if (act.to !== undefined) {
    return (
      <Button
        iconEnd={External}
        render={<TargetLink aria-label={act.name} destination={act.to} />}
        size="sm"
        variant={variant}
      >
        {act.label}
      </Button>
    );
  }
  const press = async () => {
    await act.onPress?.();
  };
  const disabled = busy || act.disabled === true;
  const { confirm } = act;
  if (confirm === undefined) {
    return (
      <Button
        aria-describedby={act.describedBy}
        aria-label={act.name}
        disabled={disabled}
        onClick={() => {
          void press();
        }}
        size="sm"
        variant={variant}
      >
        {act.label}
      </Button>
    );
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-describedby={act.describedBy}
        aria-label={act.name}
        disabled={disabled}
        size="sm"
        variant={variant}
      >
        {act.label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
        <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            action={press}
            failedLabel={t`Not done`}
            variant={confirm.variant ?? "danger"}
          >
            {act.label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** The item as it is shown: what happened, what to read, its facts, and its actions. */
const ItemFrame = ({
  frame,
  extra,
  acts,
  busy,
  failure,
}: {
  frame: Frame;
  /** What has to be read before deciding, under what happened. */
  extra?: ReactNode;
  acts: Act[];
  busy: boolean;
  failure: string | undefined;
}) => {
  const { t, i18n } = useLingui();
  const { item } = frame;
  // Who it is for, when it is someone in particular: an admin's by default.
  const facts = item.facts.map(({ label, value }) => ({ key: label, value }));
  if (item.forWhom !== undefined && "role" in item.forWhom) {
    const { role } = item.forWhom;
    facts.unshift({ key: t`For`, value: t`The ${role}` });
  } else if (item.forWhom !== undefined) {
    facts.unshift({ key: t`For`, value: item.forWhom.person });
  }
  // With no action of its own, the item is dealt with where it lives.
  const shown: Act[] =
    acts.length === 0 && item.about !== undefined
      ? [{ label: t`Open`, to: item.about }]
      : acts;
  return (
    <div {...stylex.props(styles.item)}>
      <SectionCard
        aside={
          <span {...stylex.props(styles.marks)}>
            <Badge icon={kindMark[item.kind]} size="sm">
              {i18n._(kindLabel[item.kind])}
            </Badge>
            {item.urgent ? (
              <Badge size="sm" tone="attention">
                <Trans context="inbox: something waits on this item">
                  Blocks work
                </Trans>
              </Badge>
            ) : null}
          </span>
        }
        density="compact"
        description={item.date === "" ? undefined : formatDate(item.date)}
        title={item.title}
      >
        <div {...stylex.props(styles.body)}>
          {item.body.map((paragraph) => (
            <Text key={paragraph} size="sm" tone="text">
              {paragraph}
            </Text>
          ))}
          {extra}
          {shown.length === 0 ? null : (
            <div {...stylex.props(styles.actions)}>
              {shown.map((act, index) => (
                <ActButton
                  act={act}
                  busy={busy}
                  first={index === 0}
                  key={act.label}
                />
              ))}
            </div>
          )}
          {failure === undefined ? null : (
            <Alert tone="danger">{failure}</Alert>
          )}
          {/* What `extra` shows says these already, in its own words. */}
          {extra === undefined && facts.length > 0 ? (
            <KeyValueList items={facts} variant="inline" />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
};

/** What the inbox gives an item: the way back to the list, and where to say what was done. */
interface Frame {
  item: InboxItem;
  /** Says what was done, for a screen reader: the list only loses the item. */
  onSaid: (said: string) => void;
}

/** Makes a change, says what was done, and reads the inbox again whatever came of it. */
const useDecide = (onSaid: (said: string) => void) => {
  const router = useRouter();
  const action = useCoreAction();
  const decide = async (
    change: (session: Session) => Promise<unknown>,
    said: string
  ): Promise<void> => {
    await action.run(async (session) => {
      await changeThenRefresh(
        async () => {
          await change(session);
          onSaid(said);
        },
        async () => {
          // `sync` waits for the read, so the buttons stay off until the item goes.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { ...action, decide };
};

/** Every word the Approval request card shows, in the page's language. */
const useApprovalWords = (): Partial<ApprovalWords> => {
  const { t } = useLingui();
  return {
    // Who asks when an item names nobody: a held write or start, which a
    // chat's agent or an App run in Grasp asked for.
    theAgent: "Grasp",
    details: t`Details`,
    askForChanges: t`Ask for changes`,
    whatShouldChange: t`What should change`,
    back: t`Back`,
    send: t`Send`,
    decline: t`Decline`,
    final: t`cannot be undone`,
    sure: t`Approve it?`,
    sureFinal: t`Approve it? This cannot be undone.`,
    notYet: t`Not yet`,
    yes: t`Yes`,
    // The second ask says only what Approve does: joining it to "Yes" differs by language.
    confirm: (_yes, approve) => approve,
    signed: (decided, by) => t`${decided} by ${by}`,
    you: t`you`,
    undo: t`Undo`,
    approving: t`Approving`,
    declining: t`Declining`,
    sending: t`Sending`,
    couldNotApprove: t({
      message: "Failed",
      context: "an approval that did not go through",
    }),
    couldNotDecline: t({
      message: "Failed",
      context: "a decline that did not go through",
    }),
    couldNotSend: t`Not sent`,
    approved: t`Approved`,
    declined: t`Declined`,
    changes: t`Changes asked`,
    expired: t`Expired`,
    superseded: t`Replaced by a newer request`,
    undone: t`Undone, waiting again`,
  };
};

/**
 * An ask for the person's yes (a start an agent asked for, a permission,
 * a version to go live), on Grasp UI's Approval request: what it is, who
 * asks, what to read under Details, Approve and Decline. Each answer goes
 * to core as the person; one core refuses fails on the card itself, with
 * why, and the item stays. Once it is through, the inbox is read again,
 * so the item leaves.
 */
const ApprovalFrame = ({
  frame,
  summary,
  details,
  approveLabel,
  approveHeld,
  grave = false,
  onApprove,
  onDecline,
}: {
  frame: Frame;
  /** The one fact that decides it, in the card's quiet line. */
  summary?: string;
  /** What to read before answering, under Details. */
  details?: ReactNode;
  approveLabel?: string;
  /** Why Approve waits, while it does: it stays out of use until then. */
  approveHeld?: string | undefined;
  grave?: boolean;
  onApprove: (session: Session) => Promise<unknown>;
  onDecline: (session: Session) => Promise<unknown>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const core = useCore();
  const words = useApprovalWords();
  const { item } = frame;
  // Read again whatever core answered: a refused grant shows the version
  // there is now, to review that one instead.
  const answer =
    (change: (session: Session) => Promise<unknown>, said: string) =>
    async () => {
      await changeThenRefresh(
        async () => {
          await core.withSession(change);
          frame.onSaid(said);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    };
  const { title } = item;
  return (
    <div {...stylex.props(styles.item)}>
      <ApprovalRequest
        {...(item.asker === undefined ? {} : { agent: item.asker })}
        {...(summary === undefined ? {} : { summary })}
        {...(approveHeld === undefined ? {} : { approveHeld })}
        askedAt={item.date === "" ? undefined : formatDate(item.date)}
        grave={grave}
        headingLevel={2}
        onApprove={answer(onApprove, t`Approved: ${title}`)}
        onDecline={answer(onDecline, t`Declined: ${title}`)}
        title={title}
        variant="ledger"
        words={words}
      >
        {approveLabel === undefined ? null : (
          <ApprovalRequestApprove>{approveLabel}</ApprovalRequestApprove>
        )}
        {details}
      </ApprovalRequest>
    </div>
  );
};

/**
 * A held write: confirming it is for what the person was shown, all of
 * it. Confirm waits, with why, until every part of what it sends was shown.
 * One that makes a thing (an email, an event, a task) stands as its draft,
 * as in the chat.
 */
const HeldItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "held" }>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { action } = source;
  const shown = useShown(action);
  const draft = draftOf(action);
  if (draft !== undefined) {
    const { title } = frame.item;
    return (
      <div {...stylex.props(styles.item)}>
        <HeldWriteDraft
          action={action}
          draft={draft}
          onDecided={async (done, confirmed) => {
            // A refusal stays on the draft, in core's words, with the item.
            if (done) {
              frame.onSaid(
                confirmed ? t`Approved: ${title}` : t`Declined: ${title}`
              );
              await router.invalidate({ sync: true });
            }
          }}
        />
      </div>
    );
  }
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
      details={
        <HeldWriteDetails action={action} saysUnseen={false} shown={shown} />
      }
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
      details={
        <CodeBlock
          code={JSON.stringify(start.args, null, 2)}
          fileName={t`What it starts with`}
          language="json"
        />
      }
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
        await session.permissions.revoke(request.id)
      }
    />
  );
};

/**
 * A change whose answer was lost: "It happened" or "It didn't happen", each
 * asked once more, as on the dashboard's pile (`outcome-card.tsx`). Saying
 * it didn't happen lets it go out again, so it waits while part of what was
 * sent is cut short and unseen, or no longer kept.
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
  const { busy, failure, decide } = useDecide(frame.onSaid);
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
            variant: "ink",
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
  const router = useRouter();
  const { workflow, version, bindings } = source.item.pending;
  const { busy, failure, run } = useCoreAction();
  const approve = async (
    alias: string,
    target: WorkflowBindingTarget
  ): Promise<void> => {
    await run(async (session) => {
      await session.workflowResources.approveBinding(workflow.id, {
        alias,
        target,
        reviewed: { version },
      });
      const { name } = workflow;
      frame.onSaid(t`Approved: ${alias} of ${name}.`);
      await router.invalidate({ sync: true });
    });
  };
  return (
    <ItemFrame
      acts={[]}
      busy={busy}
      extra={
        <PendingBindingList
          bindings={bindings}
          busy={busy}
          elsewhere={workflow.id}
          onApprove={approve}
        />
      }
      failure={failure}
      frame={frame}
    />
  );
};

/**
 * A question the brain asked the person: answered here, in their own
 * words, for everyone in the company to read with their name. Once it is
 * answered core lists it no more, so it leaves the inbox.
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
  const { owner } = notification;
  const asked = t`Asked of you as the ${owner}`;
  const answer = async (words: string[]): Promise<void> => {
    const [text = ""] = words;
    await core.withSession(
      async (session) =>
        await session.brain.answerGap(notification.gap, text.trim())
    );
    const { question } = notification;
    frame.onSaid(t`Answered: ${question}`);
    await router.invalidate({ sync: true });
  };
  return (
    <ItemFrame
      acts={[]}
      busy={false}
      extra={
        <QuestionTool
          embedded
          words={{ failed: t`Your answer wasn't saved. Try again.` }}
          kind="text"
          label={t`Question`}
          onSubmit={answer}
          question={notification.question}
        >
          <QuestionToolSubmit>{t`Answer`}</QuestionToolSubmit>
        </QuestionTool>
      }
      failure={undefined}
      frame={{
        ...frame,
        item: { ...frame.item, title: asked, context: asked },
      }}
    />
  );
};

/**
 * A question the Brain still has, for an admin: answered here in their
 * own words, or asked of whoever holds its role (`brain.askAboutGap`)
 * while nobody was. Answered, core lists it no more, so it leaves.
 */
const GapItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "gap" }>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const core = useCore();
  const { busy, failure, decide } = useDecide(frame.onSaid);
  const { gap } = source;
  const { owner, askedAt, question } = gap;
  const heading =
    askedAt === undefined ? t`For the ${owner}` : t`Asked of the ${owner}`;
  const answer = async (words: string[]): Promise<void> => {
    const [text = ""] = words;
    await core.withSession(
      async (session) => await session.brain.answerGap(gap.id, text.trim())
    );
    frame.onSaid(t`Answered: ${question}`);
    await router.invalidate({ sync: true });
  };
  return (
    <ItemFrame
      acts={
        askedAt === undefined
          ? [
              {
                label: t`Ask the ${owner}`,
                onPress: async () => {
                  await decide(
                    async (session) => await session.brain.askAboutGap(gap.id),
                    t`Asked the ${owner}: ${question}`
                  );
                },
              },
            ]
          : []
      }
      busy={busy}
      extra={
        <QuestionTool
          embedded
          words={{ failed: t`Your answer wasn't saved. Try again.` }}
          kind="text"
          label={t`Question`}
          onSubmit={answer}
          question={question}
        >
          <QuestionToolSubmit>{t`Answer`}</QuestionToolSubmit>
        </QuestionTool>
      }
      failure={failure}
      frame={{
        ...frame,
        item: { ...frame.item, title: heading, context: heading },
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
    decision: t`Review and answer`,
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

/** The interviews. */
const InterviewsFrame = ({
  source,
}: {
  source: Extract<InboxSource, { type: "interviews" }>;
}) => (
  <div {...stylex.props(styles.item)}>
    <InterviewsDetail interviews={source.interviews} today={source.today} />
  </div>
);

/**
 * Someone else's change whose answer was lost, for the organization's own
 * admin to follow up with them: what it was, for whom, where and when, and
 * its receipt, by which its trail is found in the audit log. Read only:
 * only that person can say what became of it, and only they see what was
 * sent.
 */
const EveryonesOutcomeItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "everyonesOutcome" }>;
}) => {
  const { t } = useLingui();
  const { listing, person } = source;
  const connection = listing.connectionName ?? listing.connectionId;
  return (
    <div {...stylex.props(styles.item)}>
      <SectionCard
        density="compact"
        description={t`Its answer was lost: nobody can tell whether it took effect.`}
        title={frame.item.title}
      >
        <div {...stylex.props(styles.body)}>
          <KeyValueList
            items={[
              { key: t`For`, value: person },
              {
                key: t`Connection`,
                value:
                  listing.resource === null
                    ? connection
                    : `${connection} · ${listing.resource}`,
              },
              { key: t`Sent`, value: formatDateTime(listing.sentAt) },
              {
                key: t`Receipt`,
                value: listing.effectKeyHash,
                mono: true,
                copy: true,
              },
            ]}
            variant="inline"
          />
          <Text size="sm" tone="muted">
            {t`Only ${person} can say whether it happened.`}
          </Text>
        </div>
      </SectionCard>
    </div>
  );
};

/** The item, by what it was made from. */
export const ItemDetail = (frame: Frame) => {
  const { source } = frame.item;
  if (source.type === "interviews") {
    return <InterviewsFrame source={source} />;
  }
  if (source.type === "everyonesOutcome") {
    return <EveryonesOutcomeItem frame={frame} source={source} />;
  }
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
  if (source.type === "gap") {
    return <GapItem frame={frame} source={source} />;
  }
  return <ElsewhereItem frame={frame} />;
};
