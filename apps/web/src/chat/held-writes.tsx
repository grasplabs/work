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
import { ApprovalRequest } from "../grasp/approval-request/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

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

/** What the page read of the chat's held writes. */
type Held =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; actions: PendingAction[] };

/**
 * The person's held writes from chat `chatId`, newest first. Outside the
 * component, as the React Compiler can't compile `try`.
 */
const readHeld = async (
  core: CoreConnection,
  chatId: string
): Promise<Held> => {
  try {
    const waiting = await core.withSession(
      async (session) => await session.pendingActions.list()
    );
    return {
      state: "ready",
      actions: waiting.filter(
        ({ context }) => context.type === "chat" && context.chatId === chatId
      ),
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

/** The input an action runs with, laid out to read. */
export const inputOf = (input: string): string => {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
};

/** Lines of a value shown before the rest waits behind "Show all". */
const shownLines = 12;

/** Characters of a value shown before the rest waits behind "Show all". */
const shownCharacters = 1200;

/** How much of `value` a card shows before "Show all": its start, if not all. */
const startOf = (value: string): string =>
  value.split("\n").slice(0, shownLines).join("\n").slice(0, shownCharacters);

/** Whether a card starts `value` cut short. */
const isCutShort = (value: string): boolean =>
  startOf(value).length < value.length;

/**
 * A text value, exactly as the input holds it, all of it: no scroll box
 * hides a part. A very long one starts cut short, with a control that says
 * how much there is and shows it all (`onShowAll`), so what follows a run
 * of blank lines can't go unseen unnoticed.
 */
const TextValue = ({
  value,
  onShowAll,
}: {
  value: string;
  onShowAll: () => void;
}) => {
  const [all, setAll] = useState(false);
  const lines = value.split("\n");
  const start = startOf(value);
  const long = isCutShort(value);
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
            {item}
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
        typeof value === "string" && isCutShort(value) && !seen.includes(input)
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
export const useHeldName = (action: PendingAction): string => {
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

/**
 * Where a held write would act and when it was asked for, and everything
 * it would send: what a person reads before they confirm it. `saysUnseen`
 * says under it when confirming waits for more (off where the card holds
 * its Confirm with that reason itself).
 */
export const HeldWriteDetails = ({
  action,
  shown,
  saysUnseen = true,
}: {
  action: PendingAction;
  shown: Shown;
  saysUnseen?: boolean;
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
          {t`This chat read restricted data: this may send it out`}
        </Badge>
      ) : null}
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
      {saysUnseen && shown.unseen ? (
        <Text id={shown.unseenId} size="sm" tone="muted">
          {unseenWords}
        </Text>
      ) : null}
    </div>
  );
};

/**
 * A held write in the chat, on Grasp UI's Approval request: Confirm and
 * Reject, Confirm held with its reason until all it sends was shown.
 */
export const HeldWrite = ({
  action,
  onDecided,
}: {
  action: PendingAction;
  onDecided: () => void;
}) => {
  const { failure, run } = useCoreAction();
  const router = useRouter();
  const { t } = useLingui();
  // Read again however it went: a failed decision may have changed
  // something too (the action gone already, say). A refusal reaches the
  // card, which says it could not.
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    const done = await run(async (session) => {
      await decision(session);
      return true;
    });
    onDecided();
    // Core notes the decision in the chat, which moves it up the chat
    // list: the list is read again so it shows under its new time.
    await router.invalidate();
    if (done !== true) {
      throw new Error("The decision was not taken");
    }
  };
  const shown = useShown(action);
  const what = useHeldName(action);
  return (
    <>
      <ApprovalRequest
        approveHeld={
          shown.unseen
            ? t`Part of what will be sent is cut short. Open Details and show it all, or exactly what will be sent, to confirm.`
            : undefined
        }
        approveLabel={t`Confirm`}
        onApprove={async () => {
          await decide(confirmHeld(action));
        }}
        onDecline={async () => {
          await decide(declineHeld(action));
        }}
        title={what}
        words={{ decline: t`Reject` }}
      >
        <HeldWriteDetails action={action} saysUnseen={false} shown={shown} />
      </ApprovalRequest>
      {/* Core's own words for a refusal, under the card's "Could not approve". */}
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/**
 * Rejects every write the chat holds at once. Confirming stays one at a
 * time: each is confirmed only once what it sends has been shown.
 */
const RejectAll = ({
  actions,
  onDecided,
}: {
  actions: readonly PendingAction[];
  onDecided: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const router = useRouter();
  const count = actions.length;
  return (
    <div {...stylex.props(styles.rejectAll)}>
      <Text size="sm" tone="muted">
        {t`${plural(count, { one: "# change waits for you to confirm or reject it.", other: "# changes wait for you to confirm or reject them." })}`}
      </Text>
      <Button
        disabled={busy}
        onClick={() => {
          void (async () => {
            await run(async (session) => {
              // Every rejection settles before the list is read again, so
              // none still running is shown as waiting; then the first
              // refusal says why.
              const outcomes = await Promise.allSettled(
                actions.map(async ({ id }) => {
                  await session.pendingActions.decline(id);
                })
              );
              const refused = outcomes.find(
                (outcome) => outcome.status === "rejected"
              );
              if (refused !== undefined) {
                throw refused.reason;
              }
            });
            onDecided();
            // Each rejection is noted in the chat: its place in the list moves.
            await router.invalidate();
          })();
        }}
        size="sm"
        variant="quiet"
      >
        {t`Reject all`}
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * The chat's held writes, each with confirm and reject. Read again when
 * `version` changes (core says the agent had a write held: `ChatUpdate.held`) and after each
 * decision.
 */
export const HeldWrites = ({
  chatId,
  version,
}: {
  chatId: string;
  version: number;
}) => {
  const [held, setHeld] = useState<Held>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
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
  if (held.state === "loading" || held.actions.length === 0) {
    return null;
  }
  const count = held.actions.length;
  return (
    <section aria-label={t`Waiting for you`} {...stylex.props(styles.list)}>
      {count > 1 ? (
        <RejectAll
          actions={held.actions}
          onDecided={() => {
            setReads(reads + 1);
          }}
        />
      ) : null}
      {held.actions.map((action) => (
        <HeldWrite
          action={action}
          key={action.id}
          onDecided={() => {
            setReads(reads + 1);
          }}
        />
      ))}
    </section>
  );
};
