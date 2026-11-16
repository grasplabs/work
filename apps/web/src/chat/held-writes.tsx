import { heldAppCallsPage, shownVisibly } from "@grasp-os/shared/chat";
import type { HeldAppCall } from "@grasp-os/shared/chat";
import type {
  ActionDescription,
  PendingAction,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
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
// doesn't show all of it. Confirm waits until everything that will be
// sent has been shown in full. Beside them, the writes to Apps core holds
// once the chat used something only the person can read, each with that
// reason and its exact request, open from the start.

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

/**
 * The input an action runs with, laid out to read, every character nobody
 * sees shown as an escape (`shownVisibly`).
 */
export const inputOf = (input: string): string => {
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

/** How much of `value` a card shows before "Show all": its start, if not all. */
const startOf = (value: string): string =>
  value.split("\n").slice(0, shownLines).join("\n").slice(0, shownCharacters);

/** Whether a card starts `value` cut short. */
const isCutShort = (value: string): boolean =>
  startOf(value).length < value.length;

/**
 * A text value, exactly as the input holds it, all of it: no scroll box
 * hides a part, and every character nobody sees is shown as an escape
 * (`shownVisibly`), counted as shown. A very long one starts cut short,
 * with a control that says how much there is and shows it all
 * (`onShowAll`), so what follows a run of blank lines can't go unseen
 * unnoticed.
 */
const TextValue = ({
  value: held,
  onShowAll,
}: {
  value: string;
  onShowAll: () => void;
}) => {
  const value = shownVisibly(held);
  const [all, setAll] = useState(false);
  const lines = value.split("\n");
  const start = startOf(value);
  const long = isCutShort(value);
  const { t } = useLingui();
  const count = lines.length;
  const characters = value.length;
  return (
    <dd className="flex flex-col items-start gap-1">
      <span className="break-words whitespace-pre-wrap">
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
          variant="outline"
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
    <dd>
      <ul className="flex flex-col">
        {value.map((item, index) => (
          // By position: the input's own order, and values may repeat.
          <li className="break-words whitespace-pre-wrap" key={index}>
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
  <dl className="flex flex-col gap-2 text-sm">
    {description.fields.map(({ input, label, value }) => (
      <div className="flex flex-col" key={input}>
        <dt className="text-muted-foreground">{label}</dt>
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
    <div className="flex flex-col items-start gap-2">
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
        <pre
          className="bg-muted w-full overflow-x-auto rounded-md p-3 text-sm"
          id={id}
        >
          <code className="font-mono">{inputOf(input)}</code>
        </pre>
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

/**
 * Where a held write would act and when it was asked for, and everything
 * it would send: what a person reads before they confirm it.
 */
export const HeldWriteDetails = ({
  action,
  shown,
}: {
  action: PendingAction;
  shown: Shown;
}) => {
  const { t } = useLingui();
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
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        <Trans>On {where}</Trans>
      </p>
      <p className="text-muted-foreground">
        <Trans>
          Asked for <time dateTime={action.requestedAt}>{asked}</time>
        </Trans>
      </p>
      {action.restricted ? (
        <Badge variant="attention">
          <Trans>This chat read restricted data: this may send it out</Trans>
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
        <p role="note">
          <Trans>
            More will be sent than is shown above. Read exactly what will be
            sent before you confirm.
          </Trans>
        </p>
      ) : null}
      <ExactInput
        input={action.input}
        onOpen={() => {
          shown.onInputOpen();
        }}
        shown={description?.complete === true}
      />
      {shown.unseen ? (
        <p className="text-muted-foreground" id={shown.unseenId}>
          <Trans>
            Part of what will be sent is cut short above. Show it all, or
            exactly what will be sent, to confirm.
          </Trans>
        </p>
      ) : null}
    </div>
  );
};

export const HeldWrite = ({
  action,
  onDecided,
}: {
  action: PendingAction;
  /**
   * Told once a decision ended, with why it failed if it did: connect
   * takes a confirmed action before it carries it out, so one that then
   * fails is gone, its card with it, and only the list can say why.
   */
  onDecided: (failed?: DecisionFailed) => void;
}) => {
  const { busy, run } = useCoreAction();
  const router = useRouter();
  const { t } = useLingui();
  const shown = useShown(action);
  const title = action.description?.title ?? action.action;
  const what = useHeldName(action);
  // Read again however it went: a failed decision may have changed
  // something too (the action gone already, say).
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    let reason: string | undefined;
    await run(decision, (failed) => {
      reason = failed;
    });
    onDecided(reason === undefined ? undefined : { what, reason });
    // Core notes the decision in the chat, which moves it up the chat
    // list: the list is read again so it shows under its new time.
    await router.invalidate();
  };
  return (
    <article
      aria-label={what}
      className="bg-card flex w-full flex-col gap-4 rounded-xl border p-4 text-sm"
    >
      <h3 className="flex items-start gap-2 font-medium">
        <ClockIcon
          aria-hidden="true"
          className="text-status-attention mt-0.5 size-4 flex-none"
        />
        <span>
          <Trans>Waiting for you: {title}</Trans>
        </span>
      </h3>
      <div className="flex flex-col gap-2">
        <HeldWriteDetails action={action} shown={shown} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          aria-describedby={shown.unseen ? shown.unseenId : undefined}
          aria-label={t`Confirm ${what}`}
          disabled={busy || shown.unseen}
          onClick={() => {
            void decide(confirmHeld(action));
          }}
        >
          <Trans>Confirm</Trans>
        </Button>
        <Button
          aria-label={t`Reject ${what}`}
          disabled={busy}
          onClick={() => {
            void decide(declineHeld(action));
          }}
          variant="outline"
        >
          <Trans>Reject</Trans>
        </Button>
      </div>
    </article>
  );
};

/** A held write whose decision failed: which, and why, in core's words. */
interface DecisionFailed {
  what: string;
  reason: string;
}

/**
 * Why a held write the person decided didn't go through, kept in the
 * list, since its card may have gone (a held App write ends either way;
 * connect takes an action before carrying it out), with core's reason.
 * Until their next decision in this chat.
 */
const DecisionFailedAlert = ({ failed }: { failed: DecisionFailed }) => {
  const { what, reason } = failed;
  const { t } = useLingui();
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{t`${what} didn't go through.`}</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
    </Alert>
  );
};

/**
 * A write to an App held because the chat used something only the person
 * can read (held-app-calls.ts in core): which function of which App, why
 * it waits, and exactly the request that would run, open from the start.
 * Confirming names that request's hash.
 */
const HeldAppCallCard = ({
  chatId,
  call,
  onDecided,
}: {
  chatId: string;
  call: HeldAppCall;
  /**
   * Told once a decision ended, with why it failed if it did
   * (`DecisionFailed`): deciding ends the hold either way, so the card
   * goes, and only the list it was in can keep saying why.
   */
  onDecided: (failed?: DecisionFailed) => void;
}) => {
  const { busy, run } = useCoreAction();
  const router = useRouter();
  const { t } = useLingui();
  // Named by the App's builder and the agent's code: every character nobody
  // sees shown as an escape, as the request is (`shownVisibly`).
  const app = shownVisibly(call.appName ?? call.appId);
  const fn = shownVisibly(call.function);
  const title = t`${fn} in ${app}`;
  const what = title;
  const where = app;
  const asked = formatDateTime(call.heldAt);
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    let reason: string | undefined;
    await run(decision, (failed) => {
      reason = failed;
    });
    onDecided(reason === undefined ? undefined : { what, reason });
    await router.invalidate();
  };
  return (
    <article
      aria-label={what}
      className="bg-card flex w-full flex-col gap-4 rounded-xl border p-4 text-sm"
    >
      <h3 className="flex items-start gap-2 font-medium">
        <ClockIcon
          aria-hidden="true"
          className="text-status-attention mt-0.5 size-4 flex-none"
        />
        <span>
          <Trans>Waiting for you: {title}</Trans>
        </span>
      </h3>
      <div className="flex flex-col gap-2">
        <Badge variant="attention">
          <Trans>This uses something only you can read</Trans>
        </Badge>
        <p className="text-muted-foreground">
          <Trans>On {where}</Trans>
        </p>
        <p className="text-muted-foreground">
          <Trans>
            Asked for <time dateTime={call.heldAt}>{asked}</time>
          </Trans>
        </p>
        <ExactInput
          input={call.request}
          onOpen={() => {
            // Open from the start: nothing waits for it.
          }}
          shown={false}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          aria-label={t`Confirm ${what}`}
          disabled={busy}
          onClick={() => {
            void decide(async (session) => {
              await session.chats.confirmHeldCall(
                chatId,
                call.id,
                call.requestHash
              );
            });
          }}
        >
          <Trans>Confirm</Trans>
        </Button>
        <Button
          aria-label={t`Reject ${what}`}
          disabled={busy}
          onClick={() => {
            void decide(async (session) => {
              await session.chats.declineHeldCall(chatId, call.id);
            });
          }}
          variant="outline"
        >
          <Trans>Reject</Trans>
        </Button>
      </div>
    </article>
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
  const { busy, run } = useCoreAction();
  const router = useRouter();
  const { t } = useLingui();
  const count = actions.length + calls.length;
  // Each write as its own card names it (`useHeldName`, and the App card's).
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
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">
        <Plural
          one="# change waits for you to confirm or reject it."
          other="# changes wait for you to confirm or reject them."
          value={count}
        />
      </p>
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
        variant="outline"
      >
        <Trans>Reject all</Trans>
      </Button>
    </div>
  );
};

/** The held writes of chat `chatId`, as `HeldWrites` shows them. */
const ChatHeldWrites = ({
  chatId,
  version,
}: {
  chatId: string;
  version: number;
}) => {
  const [held, setHeld] = useState<Held>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
  // Why the person's last decision of a held App write failed, if it did:
  // its card is gone, so the list keeps it until their next decision.
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
  return (
    <section aria-label={t`Waiting for you`} className="flex flex-col gap-2">
      {failed === undefined ? null : <DecisionFailedAlert failed={failed} />}
      {count > 1 ? (
        <RejectAll
          actions={held.actions}
          calls={held.calls}
          chatId={chatId}
          onDecided={(failure) => {
            setFailed(failure);
            setReads((read) => read + 1);
          }}
        />
      ) : null}
      {held.calls.map((call) => (
        <HeldAppCallCard
          call={call}
          chatId={chatId}
          key={call.id}
          onDecided={(failure) => {
            setFailed(failure);
            setReads((read) => read + 1);
          }}
        />
      ))}
      {held.actions.map((action) => (
        <HeldWrite
          action={action}
          key={action.id}
          onDecided={(failure) => {
            setFailed(failure);
            setReads((read) => read + 1);
          }}
        />
      ))}
    </section>
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
}) => (
  // One list per chat: what it read and why a decision failed are that
  // chat's, never shown, announced or pressed in the next one opened.
  <ChatHeldWrites chatId={chatId} key={chatId} version={version} />
);
