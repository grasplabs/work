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
  CardAction,
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
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { grantReviewed, reviewedVersion } from "../activity/pending.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
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
import { ApprovalRequest } from "./approval-request.tsx";
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
  marks: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["1"],
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
  variant,
}: {
  act: Act;
  confirm: NonNullable<Act["confirm"]>;
  disabled: boolean;
  variant: "default" | "outline";
}) => {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button
          aria-describedby={act.describedBy}
          aria-label={act.name}
          disabled={disabled}
          focusableWhenDisabled={act.describedBy !== undefined}
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
            size="sm"
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
  first,
}: {
  act: Act;
  busy: boolean;
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
  if (act.confirm !== undefined) {
    return (
      <ConfirmedAct
        act={act}
        confirm={act.confirm}
        disabled={disabled}
        variant={variant}
      />
    );
  }
  return (
    <Button
      aria-label={act.name}
      disabled={disabled}
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

/** What the inbox gives an item: where to say what was done. */
interface Frame {
  item: InboxItem;
  /** Says what was done, for a screen reader: the list only loses the item. */
  onSaid: (said: string) => void;
}

/** The item as it is shown: what happened, what to read, its actions, and its facts. */
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
  const titleId = useId();
  const { item } = frame;
  // Who it is for, when it is someone in particular: an admin's by default.
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
  // With no action of its own, the item is dealt with where it lives.
  const shown: Act[] =
    acts.length === 0 && item.about !== undefined
      ? [{ label: t`Open`, to: item.about }]
      : acts;
  return (
    <Card asChild size="sm">
      <article aria-labelledby={titleId}>
        <CardHeader>
          <span id={titleId}>
            <CardTitle level={2}>{item.title}</CardTitle>
          </span>
          {item.date === "" ? null : (
            <CardDescription>{formatDate(item.date)}</CardDescription>
          )}
          <CardAction>
            <span {...stylex.props(styles.marks)}>
              <Badge icon={kindMark[item.kind]} size="sm" variant="secondary">
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
          </CardAction>
        </CardHeader>
        <CardContent>
          <div {...stylex.props(styles.body)}>
            {item.body.map((paragraph) => (
              <Text key={paragraph} size="sm">
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
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
            {facts.length === 0 ? null : (
              <KeyValueList items={facts} orientation="horizontal" />
            )}
          </div>
        </CardContent>
      </article>
    </Card>
  );
};

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
    <ApprovalRequest
      approveHeld={approveHeld}
      approveLabel={approveLabel}
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
 * A question the Brain asked the person: answered here, in their own
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
  const { owner, question } = notification;
  const asked = t`Asked of you as the ${owner}`;
  const answer = async (
    answers: Record<string, QuestionnaireAnswer>
  ): Promise<void> => {
    const text = answers.answer?.text.trim() ?? "";
    await core.withSession(
      async (session) => await session.brain.answerGap(notification.gap, text)
    );
    frame.onSaid(t`Answered: ${question}`);
    await router.invalidate({ sync: true });
  };
  return (
    <ItemFrame
      acts={[]}
      busy={false}
      extra={
        <Questionnaire aria-label={t`Question`} onSubmit={answer}>
          <QuestionnaireItem name="answer" required>
            <QuestionnaireTitle>{question}</QuestionnaireTitle>
            <QuestionnaireInput />
            <QuestionnaireError />
          </QuestionnaireItem>
          <QuestionnaireActions>
            <QuestionnaireSubmit>{t`Answer`}</QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      }
      failure={undefined}
      frame={{ ...frame, item: { ...frame.item, title: asked } }}
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
  return <ElsewhereItem frame={frame} />;
};
