import type { WorkflowBindingTarget } from "@grasp-os/shared/workflow-resources";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId } from "react";
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
import { isUnresolvable, OutcomeDetails } from "../dashboard/outcome-card.tsx";
import { RequestDetails } from "../dashboard/pile-cards.tsx";
import { formatDate } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { ArrowLeft, External } from "../grasp/icons/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { QuestionTool } from "../grasp/question-tool/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { PendingBindingList } from "../workflows/binding-approvals.tsx";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import type { InboxItem, InboxSource, Target } from "./items.ts";
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
  back: { alignSelf: "flex-start" },
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
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={press}
            failedLabel={t`It didn't go through`}
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
  const { item, onBack } = frame;
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
      {onBack === undefined ? null : (
        <Button
          icon={ArrowLeft}
          layout={styles.back}
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          {t`All items`}
        </Button>
      )}
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
        description={formatDate(item.date)}
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
            <Alert variant="danger">{failure}</Alert>
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
  /** Back to the list, where the item takes the list's place (a narrow page). */
  onBack?: () => void;
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

/** A held write: approving it is for what the person was shown, all of it. */
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
  const { busy, failure, decide } = useDecide(frame.onSaid);
  const who = frame.item.context;
  return (
    <ItemFrame
      acts={[
        {
          label: t`Approve`,
          name: t`Approve ${who}`,
          disabled: shown.unseen,
          describedBy: shown.unseen ? shown.unseenId : undefined,
          onPress: async () => {
            await decide(confirmHeld(action), t`Approved: ${who}.`);
          },
        },
        {
          label: t`Reject`,
          name: t`Reject ${who}`,
          onPress: async () => {
            await decide(declineHeld(action), t`Rejected: ${who}.`);
          },
        },
      ]}
      busy={busy}
      extra={<HeldWriteDetails action={action} shown={shown} />}
      failure={failure}
      frame={frame}
    />
  );
};

/**
 * A start of a workflow a chat's agent asked for: confirming starts it,
 * as the agent acting for the person, with exactly the input shown, which
 * is all shown before either button.
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
  const { busy, failure, decide } = useDecide(frame.onSaid);
  const name = start.workflowName;
  return (
    <ItemFrame
      acts={[
        {
          label: t`Start`,
          name: t`Start ${name}`,
          onPress: async () => {
            await decide(
              async (session) => {
                await session.heldStarts.confirm(start.id, start.argsHash);
              },
              t`Started: ${name}.`
            );
          },
        },
        {
          label: t`Decline`,
          name: t`Decline starting ${name}`,
          onPress: async () => {
            await decide(
              async (session) => {
                await session.heldStarts.decline(start.id);
              },
              t`Declined: ${name}.`
            );
          },
        },
      ]}
      busy={busy}
      extra={
        <CodeBlock
          code={JSON.stringify(start.args, null, 2)}
          fileName={t`What it starts with`}
          language="json"
        />
      }
      failure={failure}
      frame={frame}
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
  const { busy, failure, decide } = useDecide(frame.onSaid);
  const who = frame.item.context;
  return (
    <ItemFrame
      acts={[
        {
          label: t`Approve`,
          name: t`Approve ${who}`,
          onPress: async () => {
            await decide(
              async (session) =>
                await grantReviewed(
                  session.permissions,
                  request,
                  reviewedVersion(request, pending.directory)
                ),
              t`Approved: ${who}.`
            );
          },
        },
        {
          label: t`Reject`,
          name: t`Reject ${who}`,
          confirm: {
            title: t`Reject this request?`,
            description: t`${who} can't be granted later: it has to ask again.`,
          },
          onPress: async () => {
            await decide(
              async (session) => await session.permissions.revoke(request.id),
              t`Rejected: ${who}.`
            );
          },
        },
      ]}
      busy={busy}
      extra={<RequestDetails directory={pending.directory} request={request} />}
      failure={failure}
      frame={frame}
    />
  );
};

/**
 * A version of a workflow asked to go live: approved or sent back here,
 * through the workflow's lifecycle, which checks again that the person
 * may and that it is still the version waiting.
 */
const WorkflowGoLiveDetail = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "workflowGoLive" }>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { item } = source;
  const { busy, failure, run } = useCoreAction();
  const who = frame.item.context;
  const { version } = item;
  // Read again once it is decided. A refused decision stays, with why.
  const decide = async (
    verdict: "approve" | "reject",
    said: string
  ): Promise<void> => {
    await run(async (session) => {
      await session.workflowResources.lifecycle.decideGoLive(item.workflow.id, {
        version,
        verdict,
        revision: item.revision,
      });
      frame.onSaid(said);
      await router.invalidate({ sync: true });
    });
  };
  return (
    <ItemFrame
      acts={[
        {
          label: t`Approve`,
          name: t`Let version ${version} of ${who} go live`,
          onPress: async () => {
            await decide("approve", t`Live: ${who}, version ${version}.`);
          },
        },
        {
          label: t`Send back`,
          name: t`Send version ${version} of ${who} back`,
          onPress: async () => {
            await decide("reject", t`Sent back: ${who}, version ${version}.`);
          },
        },
      ]}
      busy={busy}
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
          failedLabel={t`Your answer wasn't saved. Try again.`}
          kind="text"
          label={t`Your answer`}
          onSubmit={answer}
          question={notification.question}
          submitLabel={t`Answer`}
        />
      }
      failure={undefined}
      frame={{
        ...frame,
        item: { ...frame.item, title: asked, context: asked },
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
  if (source.type === "workflowGoLive") {
    return <WorkflowGoLiveDetail frame={frame} source={source} />;
  }
  if (source.type === "bindings") {
    return <BindingsDetail frame={frame} source={source} />;
  }
  if (source.type === "asked") {
    return <AskedItem frame={frame} source={source} />;
  }
  return <ElsewhereItem frame={frame} />;
};
