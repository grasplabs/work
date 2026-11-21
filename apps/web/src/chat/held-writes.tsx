import { heldAppCallsPage, shownVisibly } from "@grasp-os/shared/chat";
import type { HeldAppCall } from "@grasp-os/shared/chat";
import type {
  ActionDescription,
  PendingAction,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import {
  ApprovalRequest,
  ApprovalRequestApprove,
} from "../grasp/approval-request/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { EmailDraft, EventDraft, TaskDraft } from "../grasp/draft/index.ts";
import type { DraftStatus } from "../grasp/draft/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { draftOf, draftTimeZone } from "./held-drafts.ts";
import type { DraftShown, HeldDraft } from "./held-drafts.ts";

// The changes the chat's agent asked for in outside systems (sending,
// booking, deleting), which connect holds until the person confirms or
// rejects each (pending-actions.ts in core). Core lists only the person's
// own; this shows those from this chat. A write whose tool describes it
// reads as a title and the parts of its input that matter, each value the
// input's own, never a summary; any other shows its action and its input.
// Either way the exact input each runs with, which is what confirming
// names, is one click away, and open from the start whenever the card
// doesn't show all of it. On Grasp UI's Approval request, Confirm is held,
// with its reason, until everything that will be sent has been shown in
// full (`approveHeld`).
//
// A write that makes a thing (an email, an event, a task) stands as that
// thing instead, on Grasp UI's draft (held-drafts.ts), read only until
// core takes an input changed in place: its main action confirms it as
// written, Discard rejects it. What the draft has no place for is listed
// under it in its tool's words. A draft's main action can't be held, so
// whenever the draft and that list might not show all of the input whole,
// the exact input is open from the start: confirming is then never for
// less than the person was shown.
//
// Beside them, the writes to Apps core holds once the chat used something
// only the person can read, each with that reason and its exact request,
// open from the start. Why a decision didn't go through stands above the
// list, which keeps it should the card go, until the next decision.

/**
 * What the page read of the chat's held writes: connect's (`actions`), and
 * the writes to Apps core holds once the chat used something only the
 * person can read (`calls`).
 */
type Held =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; actions: PendingAction[]; calls: HeldAppCall[] };

/**
 * Every App write held in chat `chatId`, oldest first: page after page
 * (`heldAppCallsPage` each), until one comes back short.
 */
const heldCallsOf = async (
  session: Session,
  chatId: string
): Promise<HeldAppCall[]> => {
  const calls: HeldAppCall[] = [];
  let page = await session.chats.heldCalls(chatId);
  calls.push(...page);
  while (page.length === heldAppCallsPage) {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    page = await session.chats.heldCalls(chatId, page.at(-1)?.id);
    calls.push(...page);
  }
  return calls;
};

/**
 * The person's held writes from chat `chatId`, newest first. Outside the
 * component, as the React Compiler can't compile `try`.
 */
const readHeld = async (
  core: CoreConnection,
  chatId: string
): Promise<Held> => {
  try {
    const [waiting, calls] = await core.withSession(
      async (session) =>
        await Promise.all([
          session.pendingActions.list(),
          heldCallsOf(session, chatId),
        ])
    );
    return {
      state: "ready",
      actions: waiting.filter(
        ({ context }) => context.type === "chat" && context.chatId === chatId
      ),
      calls,
    };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

const styles = stylex.create({
  stack: { display: "grid", gap: grasp.space2 },
  list: { display: "grid", gap: grasp.space3 },
  value: {
    display: "grid",
    justifyItems: "start",
    gap: grasp.space1,
    margin: 0,
  },
  // A value exactly as the input holds it: its line breaks kept.
  words: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  items: { margin: 0, paddingInlineStart: grasp.space4 },
  fields: { display: "grid", gap: grasp.space2, margin: 0 },
  field: { display: "grid", gap: grasp.space1 },
  rejectAll: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
});

/**
 * The input an action runs with, laid out to read, every character nobody
 * sees shown as an escape (`shownVisibly`).
 */
const inputOf = (input: string): string => {
  try {
    return shownVisibly(JSON.stringify(JSON.parse(input), null, 2));
  } catch {
    return shownVisibly(input);
  }
};

/** Lines of a value shown before the rest waits behind "Show all". */
const shownLines = 12;

/** Characters of a value shown before the rest waits behind "Show all". */
const shownCharacters = 1200;

/**
 * A value as the card shows it, the one place both what is shown and
 * whether it was all shown are decided: every character nobody sees as an
 * escape (`shownVisibly`), and, measured on that, its start before "Show
 * all" and whether that start cuts it short. So an escape that lengthens a
 * value counts toward what is cut, and Confirm waits for what the start
 * hides (`useShown`).
 */
const shownOf = (held: string) => {
  const value = shownVisibly(held);
  const start = value
    .split("\n")
    .slice(0, shownLines)
    .join("\n")
    .slice(0, shownCharacters);
  return { value, start, cutShort: start.length < value.length };
};

/**
 * A text value, exactly as the input holds it, all of it: no scroll box
 * hides a part, and every character nobody sees is shown as an escape,
 * counted as shown (`shownOf`). A very long one starts cut short, with a
 * control that says how much there is and shows it all (`onShowAll`), so
 * what follows a run of blank lines can't go unseen unnoticed.
 */
const TextValue = ({
  value: held,
  onShowAll,
}: {
  value: string;
  onShowAll: () => void;
}) => {
  const { value, start, cutShort: long } = shownOf(held);
  const [all, setAll] = useState(false);
  const lines = value.split("\n");
  const { t } = useLingui();
  const count = lines.length;
  const characters = value.length;
  return (
    <dd {...stylex.props(styles.value)}>
      <span {...stylex.props(styles.words)}>
        {all || !long ? value : `${start}…`}
      </span>
      {long ? (
        <Button
          aria-expanded={all}
          onClick={() => {
            if (!all) {
              onShowAll();
            }
            setAll(!all);
          }}
          size="sm"
          variant="quiet"
        >
          {all
            ? t`Show less`
            : t`Show all ${count} lines (${characters} characters)`}
        </Button>
      ) : null}
    </dd>
  );
};

/** One value of a description, exactly as the input holds it. */
const FieldValue = ({
  value,
  onShowAll,
}: {
  value: string | string[];
  onShowAll: () => void;
}) =>
  typeof value === "string" ? (
    <TextValue onShowAll={onShowAll} value={value} />
  ) : (
    <dd {...stylex.props(styles.value)}>
      <ul {...stylex.props(styles.items)}>
        {value.map((item, index) => (
          // By position: the input's own order, and values may repeat.
          <li key={index} {...stylex.props(styles.words)}>
            {shownVisibly(item)}
          </li>
        ))}
      </ul>
    </dd>
  );

/**
 * The parts of the input its tool shows, each under its label; `onShowAll`
 * names a value cut short once it is shown in full.
 */
export const Described = ({
  description,
  onShowAll,
}: {
  description: ActionDescription;
  onShowAll: (input: string) => void;
}) => (
  <dl {...stylex.props(styles.fields)}>
    {description.fields.map(({ input, label, value }) => (
      <div key={input} {...stylex.props(styles.field)}>
        <dt>
          <Text element="span" size="sm" tone="muted">
            {label}
          </Text>
        </dt>
        <FieldValue
          onShowAll={() => {
            onShowAll(input);
          }}
          value={value}
        />
      </div>
    ))}
  </dl>
);

/**
 * The exact input the write runs with, behind a disclosure: open from the
 * start unless the card already shows all of it (`shown`). `onOpen` says
 * it was opened. `sent`: it went out already (a call of unknown outcome),
 * so it is what was sent, not what will be.
 */
export const ExactInput = ({
  input,
  shown,
  onOpen,
  sent = false,
}: {
  input: string;
  shown: boolean;
  onOpen: () => void;
  sent?: boolean;
}) => {
  const [open, setOpen] = useState(!shown);
  const id = useId();
  const { t } = useLingui();
  let label = open
    ? t`Hide exactly what will be sent`
    : t`Show exactly what will be sent`;
  if (sent) {
    label = open
      ? t`Hide exactly what was sent`
      : t`Show exactly what was sent`;
  }
  return (
    <div {...stylex.props(styles.value)}>
      <Button
        aria-controls={id}
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            onOpen();
          }
          setOpen(!open);
        }}
        size="sm"
        variant="ghost"
      >
        {label}
      </Button>
      {open ? (
        <div id={id}>
          {/* All of it, never folded: it is what confirming names. */}
          <CodeBlock
            code={inputOf(input)}
            language="json"
            maxLines={false}
            wrap
          />
        </div>
      ) : null}
    </div>
  );
};

/** What of a held write the person has been shown, and whether confirming still waits for more. */
export interface Shown {
  /** Part of what will be sent is cut short and the exact input wasn't opened: confirming waits. */
  unseen: boolean;
  /** The id of the line that says so. */
  unseenId: string;
  onInputOpen: () => void;
  onShowAll: (input: string) => void;
}

/**
 * Confirming is for what the person was shown, all of it: while a value
 * the card cut short hasn't been shown in full, and the exact input hasn't
 * been opened, Confirm waits. The exact input starts open unless the
 * description shows every property of the input.
 */
export const useShown = ({
  description,
}: Pick<PendingAction, "description">): Shown => {
  const complete = description?.complete === true;
  const [inputSeen, setInputSeen] = useState(!complete);
  const [seen, setSeen] = useState<string[]>([]);
  const unseen =
    !inputSeen &&
    (description?.fields ?? []).some(
      ({ input, value }) =>
        typeof value === "string" &&
        shownOf(value).cutShort &&
        !seen.includes(input)
    );
  const unseenId = useId();
  return {
    unseen,
    unseenId,
    onInputOpen: () => {
      setInputSeen(true);
    },
    onShowAll: (input) => {
      setSeen((shown) => [...shown, input]);
    },
  };
};

/** A held write's name: what it does, on which connection. */
const useHeldName = (action: PendingAction): string => {
  const { t } = useLingui();
  const title = action.description?.title ?? action.action;
  const connection = action.connectionName ?? action.connectionId;
  return t`${title} on ${connection}`;
};

/** The person's yes to a held write, as core takes it: for exactly the input they were shown. */
export const confirmHeld =
  (action: PendingAction) =>
  async (session: Session): Promise<unknown> =>
    await session.pendingActions.confirm(action.id, action.inputHash);

/** The person's no to a held write. */
export const declineHeld =
  (action: PendingAction) =>
  async (session: Session): Promise<void> => {
    await session.pendingActions.decline(action.id);
  };

/** Why confirming waits, while part of what will be sent is still unseen. */
const useUnseenWords = (): string => {
  const { t } = useLingui();
  return t`Part of what will be sent is cut short above. Show it all, or exactly what will be sent, to confirm.`;
};

/** Why a held write can only be rejected while what it would send is withheld. */
const useWithheldWords = (
  withheld: NonNullable<PendingAction["withheld"]>
): string => {
  const { t } = useLingui();
  return withheld === "revoked"
    ? t`What this would send is withheld: the run that asked for it may no longer read what it read, so you can only reject it.`
    : t`What this would send can't be shown right now, so you can only reject it for now. Try again in a moment.`;
};

/**
 * Why a held write shows nothing of what it would send (core's
 * `withheld`): its run may no longer read what it read, or that can't be
 * checked now. Either way it can only be rejected.
 */
const WithheldInput = ({
  withheld,
  id,
}: {
  withheld: NonNullable<PendingAction["withheld"]>;
  id?: string | undefined;
}) => {
  const words = useWithheldWords(withheld);
  return (
    <div id={id} role="note">
      <Text size="sm">{words}</Text>
    </div>
  );
};

/**
 * Where a held write would act and when it was asked for, and everything
 * it would send: what a person reads before they confirm it; nothing of it
 * while withheld (`WithheldInput`, `withheldId` its line's id).
 * `saysUnseen` says under it when confirming waits for more (off where the
 * card holds its Confirm with that reason itself).
 */
export const HeldWriteDetails = ({
  action,
  shown,
  saysUnseen = true,
  withheldId,
}: {
  action: PendingAction;
  shown: Shown;
  saysUnseen?: boolean;
  /** The id of the line that says why it is withheld, if it is. */
  withheldId?: string;
}) => {
  const { t } = useLingui();
  const unseenWords = useUnseenWords();
  const { description, resource } = action;
  const connection = action.connectionName ?? action.connectionId;
  const tool = action.action;
  const asked = formatDateTime(action.requestedAt);
  let where = connection;
  if (resource !== null && description !== undefined) {
    where = t`${connection}, ${resource} (${tool})`;
  } else if (resource !== null) {
    where = t`${connection}, ${resource}`;
  } else if (description !== undefined) {
    where = t`${connection} (${tool})`;
  }
  return (
    <div {...stylex.props(styles.stack)}>
      <Text size="sm" tone="muted">
        {t`On ${where}`}
      </Text>
      <Text size="sm" tone="muted">
        <Trans>
          Asked for <time dateTime={action.requestedAt}>{asked}</time>
        </Trans>
      </Text>
      {action.restricted ? (
        <Badge tone="attention">
          {t`This chat read private or restricted data: this may send it out`}
        </Badge>
      ) : null}
      {action.withheld === undefined ? (
        <>
          {description === undefined ? null : (
            <Described
              description={description}
              onShowAll={(input) => {
                shown.onShowAll(input);
              }}
            />
          )}
          {description?.complete === false ? (
            <Text size="sm">
              {t`More will be sent than is shown above. Read exactly what will be sent before you confirm.`}
            </Text>
          ) : null}
          <ExactInput
            input={action.input}
            onOpen={() => {
              shown.onInputOpen();
            }}
            shown={description?.complete === true}
          />
        </>
      ) : (
        <WithheldInput id={withheldId} withheld={action.withheld} />
      )}
      {saysUnseen && shown.unseen ? (
        <Text id={shown.unseenId} size="sm" tone="muted">
          {unseenWords}
        </Text>
      ) : null}
    </div>
  );
};

/**
 * Characters a draft's one-line field or person's chip holds whole at a
 * phone's width; a longer value may be cut at its edge.
 */
const lineCharacters = 40;

/** Matches a line break, which a one-line field doesn't show. */
const lineBreak = /[\r\n]/u;

/**
 * Whether a draft's fields grow with their words (`field-sizing`): where
 * they don't, a long value scrolls inside its field, out of sight.
 */
const fieldsGrow = (): boolean =>
  typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/** Whether the draft shows every value of one of the input's properties whole. */
const shownWhole = ({ as, values }: DraftShown): boolean =>
  values.every((value) => {
    if (as === "line") {
      return value.length <= lineCharacters && !lineBreak.test(value);
    }
    if (as === "grows") {
      return fieldsGrow() && !shownOf(value).cutShort;
    }
    return as === "whole";
  });

/**
 * The held write as its draft leaves it to the page: its description
 * holds only what the draft has no place for, and is complete only when
 * the draft and that list show every property of the input, each whole;
 * else the exact input is open from the start.
 */
const draftRest = (action: PendingAction, draft: HeldDraft): PendingAction => {
  const fields = (action.description?.fields ?? []).filter(({ input }) =>
    draft.left.includes(input)
  );
  const complete =
    draft.left.every((key) => fields.some(({ input }) => input === key)) &&
    fields.every(
      ({ value }) => typeof value !== "string" || !shownOf(value).cutShort
    ) &&
    draft.shown.every(shownWhole);
  return {
    ...action,
    description: {
      title: action.description?.title ?? action.action,
      fields,
      complete,
    },
  };
};

/** A held write whose decision failed: which, and why, in core's words. */
interface DecisionFailed {
  what: string;
  reason: string;
}

/** What a card tells its list once a decision of it ended. */
interface Decided {
  /**
   * Told once a decision ended, with why it failed if it did: connect
   * takes a confirmed action before it carries it out, and a held App
   * write ends either way, so one that then fails is gone, its card with
   * it, and only the list can say why.
   */
  onDecided: (failed?: DecisionFailed) => void;
  /** Told once the person's confirmation went through. */
  onConfirmed: () => void;
}

/**
 * Decides a held write named `what` as `decision` says, then tells the
 * list (`Decided`) and reads the chat list again: core notes the decision
 * in the chat, which moves it up the list. Whether it went through.
 */
const useDecide = (what: string, { onDecided, onConfirmed }: Decided) => {
  const { busy, run } = useCoreAction();
  const router = useRouter();
  const decide = async (
    decision: (session: Session) => Promise<unknown>,
    confirming: boolean
  ): Promise<boolean> => {
    let reason: string | undefined;
    await run(decision, (failed) => {
      reason = failed;
    });
    onDecided(reason === undefined ? undefined : { what, reason });
    if (confirming && reason === undefined) {
      onConfirmed();
    }
    await router.invalidate();
    return reason === undefined;
  };
  return { busy, decide };
};

/**
 * A held write as the thing it makes, on Grasp UI's draft, read only: its
 * main action (Send, Create event, Add task) confirms exactly the input,
 * Discard rejects it. Under it, where it would act, what the draft has no
 * place for, and the exact input. `onDecided` follows each decision,
 * whether it went through (`done`) or core refused it, which the draft
 * says in core's words (`reason`).
 */
export const HeldWriteDraft = ({
  action,
  draft,
  onDecided,
}: {
  action: PendingAction;
  draft: HeldDraft;
  onDecided: (
    done: boolean,
    confirmed: boolean,
    reason?: string
  ) => Promise<void>;
}) => {
  const { run } = useCoreAction();
  const [failure, setFailure] = useState<string>();
  const [status, setStatus] = useState<DraftStatus>("ready");
  const rest = draftRest(action, draft);
  const shown = useShown(rest);
  const decide = async (confirming: boolean): Promise<void> => {
    if (confirming) {
      setStatus("sending");
    }
    let reason: string | undefined;
    await run(
      async (session) => {
        await (confirming ? confirmHeld(action) : declineHeld(action))(session);
      },
      (failed) => {
        reason = failed;
      }
    );
    setFailure(reason);
    if (reason !== undefined && confirming) {
      setStatus("failed");
    }
    await onDecided(reason === undefined, confirming, reason);
  };
  const confirm = async (): Promise<void> => {
    // Never so as the page is built (the exact input is open whenever
    // something may be unseen), and never confirmed if it were.
    if (!shown.unseen) {
      await decide(true);
    }
  };
  const reject = () => {
    void decide(false);
  };
  return (
    <div {...stylex.props(styles.stack)}>
      {draft.kind === "email" ? (
        <EmailDraft
          draft={draft.draft}
          onDismiss={reject}
          onSend={confirm}
          status={status}
        />
      ) : null}
      {draft.kind === "event" ? (
        <EventDraft
          draft={draft.draft}
          onCreate={confirm}
          onDismiss={reject}
          status={status}
          timeZone={draftTimeZone}
        />
      ) : null}
      {draft.kind === "task" ? (
        <TaskDraft
          draft={draft.draft}
          onAdd={confirm}
          onDismiss={reject}
          status={status}
          timeZone={draftTimeZone}
        />
      ) : null}
      <HeldWriteDetails action={rest} shown={shown} />
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * A held write on Grasp UI's Approval request: Confirm and Reject, Confirm
 * held with its reason until all it sends was shown, or for good while
 * what it would send is withheld. A refusal reaches the card, which says
 * it could not; the list says why.
 */
const HeldCard = ({
  action,
  ...decided
}: Decided & {
  action: PendingAction;
}) => {
  const { t } = useLingui();
  const shown = useShown(action);
  const what = useHeldName(action);
  const { decide } = useDecide(what, decided);
  const withheldWords = useWithheldWords(action.withheld ?? "revoked");
  const decideCard = async (
    decision: (session: Session) => Promise<unknown>,
    confirming: boolean
  ): Promise<void> => {
    if (!(await decide(decision, confirming))) {
      throw new Error("The decision was not taken");
    }
  };
  let approveHeld: string | undefined;
  if (action.withheld !== undefined) {
    approveHeld = withheldWords;
  } else if (shown.unseen) {
    approveHeld = t`Part of what will be sent is cut short. Open Details and show it all, or exactly what will be sent, to confirm.`;
  }
  return (
    <ApprovalRequest
      approveHeld={approveHeld}
      onApprove={async () => {
        await decideCard(confirmHeld(action), true);
      }}
      onDecline={async () => {
        await decideCard(declineHeld(action), false);
      }}
      title={what}
      words={{ decline: t`Reject` }}
    >
      <ApprovalRequestApprove>{t`Confirm`}</ApprovalRequestApprove>
      <HeldWriteDetails action={action} saysUnseen={false} shown={shown} />
    </ApprovalRequest>
  );
};

/**
 * A held write in the chat: as its draft when it makes one and what it
 * would send is shown, else on Grasp UI's Approval request.
 */
const HeldWrite = ({
  action,
  ...decided
}: Decided & {
  action: PendingAction;
}) => {
  const router = useRouter();
  const what = useHeldName(action);
  const draft = action.withheld === undefined ? draftOf(action) : undefined;
  if (draft === undefined) {
    return <HeldCard action={action} {...decided} />;
  }
  return (
    <HeldWriteDraft
      action={action}
      draft={draft}
      onDecided={async (done, confirmed, reason) => {
        // Read again however it went, as the card does.
        decided.onDecided(reason === undefined ? undefined : { what, reason });
        if (done && confirmed) {
          decided.onConfirmed();
        }
        await router.invalidate();
      }}
    />
  );
};

/** A held App write's name: its function, in its App, as the person reads both. */
const useCallName = (call: HeldAppCall): string => {
  const { t } = useLingui();
  // Named by the App's builder and the agent's code: every character nobody
  // sees shown as an escape, as the request is (`shownVisibly`).
  const fn = shownVisibly(call.function);
  const app = shownVisibly(call.appName ?? call.appId);
  return t`${fn} in ${app}`;
};

/**
 * A write to an App held because the chat used something only the person
 * can read (held-app-calls.ts in core), on Grasp UI's Approval request:
 * which function of which App, why it waits, and exactly the request that
 * would run, open from the start. Confirming names that request's hash.
 */
const HeldAppCallCard = ({
  chatId,
  call,
  ...decided
}: Decided & {
  chatId: string;
  call: HeldAppCall;
}) => {
  const { t } = useLingui();
  const what = useCallName(call);
  const { decide } = useDecide(what, decided);
  const where = shownVisibly(call.appName ?? call.appId);
  const asked = formatDateTime(call.heldAt);
  const decideCard = async (
    decision: (session: Session) => Promise<unknown>,
    confirming: boolean
  ): Promise<void> => {
    if (!(await decide(decision, confirming))) {
      throw new Error("The decision was not taken");
    }
  };
  return (
    <ApprovalRequest
      onApprove={async () => {
        await decideCard(async (session) => {
          await session.chats.confirmHeldCall(
            chatId,
            call.id,
            call.requestHash
          );
        }, true);
      }}
      onDecline={async () => {
        await decideCard(async (session) => {
          await session.chats.declineHeldCall(chatId, call.id);
        }, false);
      }}
      title={what}
      words={{ decline: t`Reject` }}
    >
      <ApprovalRequestApprove>{t`Confirm`}</ApprovalRequestApprove>
      <div {...stylex.props(styles.stack)}>
        <Badge tone="attention">{t`This uses something only you can read`}</Badge>
        <Text size="sm" tone="muted">
          {t`On ${where}`}
        </Text>
        <Text size="sm" tone="muted">
          <Trans>
            Asked for <time dateTime={call.heldAt}>{asked}</time>
          </Trans>
        </Text>
        <ExactInput
          input={call.request}
          onOpen={() => {
            // Open from the start: nothing waits for it.
          }}
          shown={false}
        />
      </div>
    </ApprovalRequest>
  );
};

/**
 * Why a held write the person decided didn't go through, kept in the
 * list, since its card may have gone, with core's reason. Until their next
 * decision in this chat.
 */
const DecisionFailedAlert = ({ failed }: { failed: DecisionFailed }) => {
  const { what, reason } = failed;
  const { t } = useLingui();
  return (
    <Alert title={t`${what} didn't go through.`} tone="danger">
      {reason}
    </Alert>
  );
};

/**
 * Rejects every write the chat holds at once. Confirming stays one at a
 * time: each is confirmed only once what it sends has been shown.
 */
const RejectAll = ({
  chatId,
  actions,
  calls,
  onDecided,
}: {
  chatId: string;
  actions: readonly PendingAction[];
  calls: readonly HeldAppCall[];
  /**
   * Told once the rejections settled, with why the first refused one
   * failed: what it rejected may still wait, but this row goes once fewer
   * than two do, so only the list can say why.
   */
  onDecided: (failed?: DecisionFailed) => void;
}) => {
  const { t } = useLingui();
  const { busy, run } = useCoreAction();
  const router = useRouter();
  const count = actions.length + calls.length;
  // Each write as its own card names it (`useHeldName`, `useCallName`).
  const names = [
    ...actions.map((action) => {
      const title = action.description?.title ?? action.action;
      const connection = action.connectionName ?? action.connectionId;
      return t`${title} on ${connection}`;
    }),
    ...calls.map((call) => {
      const fn = shownVisibly(call.function);
      const app = shownVisibly(call.appName ?? call.appId);
      return t`${fn} in ${app}`;
    }),
  ];
  return (
    <div {...stylex.props(styles.rejectAll)}>
      <Text size="sm" tone="muted">
        {t`${plural(count, { one: "# change waits for you to confirm or reject it.", other: "# changes wait for you to confirm or reject them." })}`}
      </Text>
      <Button
        disabled={busy}
        onClick={() => {
          void (async () => {
            let failed: DecisionFailed | undefined;
            let firstRefused = -1;
            await run(
              async (session) => {
                // Every rejection settles before the list is read again, so
                // none still running is shown as waiting; then the first
                // refusal says why.
                const outcomes = await Promise.allSettled([
                  ...actions.map(async ({ id }) => {
                    await session.pendingActions.decline(id);
                  }),
                  ...calls.map(async ({ id }) => {
                    await session.chats.declineHeldCall(chatId, id);
                  }),
                ]);
                firstRefused = outcomes.findIndex(
                  (outcome) => outcome.status === "rejected"
                );
                const refused = outcomes[firstRefused];
                if (refused?.status === "rejected") {
                  throw refused.reason;
                }
              },
              (reason) => {
                failed = { what: names[firstRefused] ?? "", reason };
              }
            );
            onDecided(failed);
            // Each rejection is noted in the chat: its place in the list moves.
            await router.invalidate();
          })();
        }}
        size="sm"
        variant="quiet"
      >
        {t`Reject all`}
      </Button>
    </div>
  );
};

/** The held writes of chat `chatId`, as `HeldWrites` shows them. */
const ChatHeldWrites = ({
  chatId,
  version,
  onConfirmed,
}: {
  chatId: string;
  version: number;
  onConfirmed: () => void;
}) => {
  const [held, setHeld] = useState<Held>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
  // Why the person's last decision failed, if it did: its card may be
  // gone, so the list keeps it until their next decision.
  const [failed, setFailed] = useState<DecisionFailed>();
  const { t } = useLingui();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await readHeld(core, chatId);
      // A read for another chat, or an older one, doesn't show.
      if (current) {
        setHeld(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` and `reads` say when to read again
  }, [core, chatId, version, reads]);
  if (held.state === "refused") {
    return <ErrorText>{held.message}</ErrorText>;
  }
  const count =
    held.state === "loading" ? 0 : held.actions.length + held.calls.length;
  if (held.state === "loading" || (count === 0 && failed === undefined)) {
    return null;
  }
  const decided = (failure?: DecisionFailed): void => {
    setFailed(failure);
    setReads((read) => read + 1);
  };
  return (
    <section aria-label={t`Waiting for you`} {...stylex.props(styles.list)}>
      {failed === undefined ? null : <DecisionFailedAlert failed={failed} />}
      {count > 1 ? (
        <RejectAll
          actions={held.actions}
          calls={held.calls}
          chatId={chatId}
          onDecided={decided}
        />
      ) : null}
      {held.calls.map((call) => (
        <HeldAppCallCard
          call={call}
          chatId={chatId}
          key={call.id}
          onConfirmed={onConfirmed}
          onDecided={decided}
        />
      ))}
      {held.actions.map((action) => (
        <HeldWrite
          action={action}
          key={action.id}
          onConfirmed={onConfirmed}
          onDecided={decided}
        />
      ))}
    </section>
  );
};

/**
 * The chat's held writes, each with confirm and reject. Read again when
 * `version` changes (core says the agent had a write held:
 * `ChatUpdate.held`) and after each decision. `onConfirmed` is told each
 * time a confirmation went through: a rejection, or one that failed, tells
 * it nothing.
 */
export const HeldWrites = ({
  chatId,
  version,
  onConfirmed,
}: {
  chatId: string;
  version: number;
  onConfirmed: () => void;
}) => (
  // One list per chat: what it read and why a decision failed are that
  // chat's, never shown, announced or pressed in the next one opened.
  <ChatHeldWrites
    chatId={chatId}
    key={chatId}
    onConfirmed={onConfirmed}
    version={version}
  />
);
