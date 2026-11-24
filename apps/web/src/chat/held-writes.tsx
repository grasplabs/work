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
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Text } from "@grasp-os/ui/components/text";
import { useScrollEdges } from "@grasp-os/ui/hooks/use-scroll-edges";
import { codeStyles, focusRing } from "@grasp-os/ui/lib/styles";
import { font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { DecisionButton } from "./decision-button.tsx";
import { FailureLine } from "./failure-line.tsx";

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

const styles = stylex.create({
  // A value as the input holds it, its lines and runs of spaces too.
  value: {
    display: "grid",
    justifyItems: "start",
    gap: space["1"],
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  list: { margin: 0, paddingInlineStart: 0, listStyleType: "none" },
  stack: {
    display: "grid",
    justifyItems: "start",
    gap: space["2"],
    // A line of its own in the confirmation, under its title.
    flexBasis: "100%",
    minWidth: 0,
  },
  // The exact input on a code block's ground, every line drawn: long
  // ones wrap, and what still overflows scrolls inside it, not the page.
  // Set as Damsko's CodeBlockContent sets its code (its size, line, and
  // room: 12px, and its line bar's 2px at the start), so it reads as the
  // reference's block without one element per line.
  exact: {
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    paddingBlock: space["3"],
    paddingInlineStart: `calc(${space["3"]} + ${size.codeBlockBarWidth})`,
    paddingInlineEnd: space["3"],
    fontFamily: font.mono,
    fontSize: font.textSm,
    lineHeight: font.codeBlockLine,
    tabSize: 2,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    overflowX: "auto",
  },
  list2: { display: "grid", gap: space["2"] },
  presses: { display: "flex", flexWrap: "wrap", gap: space["2"] },
  rejectAll: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["2"],
  },
});

/** Muted words of a held write's card, a sentence of their own. */
const Quiet = ({ children, id }: { children: ReactNode; id?: string }) => (
  <Text as="p" color="muted" id={id} size="sm">
    {children}
  </Text>
);

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
 * counted as shown (`shownOf`). A very long one starts cut short,
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
  const { value, start, cutShort: long } = shownOf(held);
  const [all, setAll] = useState(false);
  const lines = value.split("\n");
  const { t } = useLingui();
  const count = lines.length;
  const characters = value.length;
  return (
    <span {...stylex.props(styles.value)}>
      <span>{all || !long ? value : `${start}…`}</span>
      {long ? (
        <Button asChild size="sm" variant="outline">
          <button
            aria-expanded={all}
            onClick={() => {
              if (!all) {
                onShowAll();
              }
              setAll(!all);
            }}
            type="button"
          >
            {all
              ? t`Show less`
              : t`Show all ${count} lines (${characters} characters)`}
          </button>
        </Button>
      ) : null}
    </span>
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
    <ul {...stylex.props(styles.list, styles.value)}>
      {value.map((item, index) => (
        // By position: the input's own order, and values may repeat.
        <li key={index}>{shownVisibly(item)}</li>
      ))}
    </ul>
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
  <KeyValueList
    items={description.fields.map(({ input, label, value }) => ({
      id: input,
      label,
      value: (
        <FieldValue
          onShowAll={() => {
            onShowAll(input);
          }}
          value={value}
        />
      ),
    }))}
  />
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
  const [scrolls, setScrolls] = useState(false);
  const scroller = useScrollEdges({
    onChange: ({ overflows }) => {
      setScrolls(overflows);
    },
  });
  const id = useId();
  const { t } = useLingui();
  const name = sent ? t`Exactly what was sent` : t`Exactly what will be sent`;
  let label = open
    ? t`Hide exactly what will be sent`
    : t`Show exactly what will be sent`;
  if (sent) {
    label = open
      ? t`Hide exactly what was sent`
      : t`Show exactly what was sent`;
  }
  return (
    <div {...stylex.props(styles.stack)}>
      <Button asChild size="sm" variant="ghost">
        <button
          aria-controls={id}
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              onOpen();
            }
            setOpen(!open);
          }}
          type="button"
        >
          {label}
        </button>
      </Button>
      {open ? (
        // All of it, in a plain block: what is confirmed is never folded
        // away, and its text is exactly what Confirm sends. Damsko's
        // CodeBlock could draw it whole (`maxLines={false}`), but as an
        // element per line, highlighted: about 1.3 s more to open a request
        // at connect's 64 KiB.
        <pre
          aria-label={scrolls ? name : undefined}
          id={id}
          ref={scroller}
          role={scrolls ? "region" : undefined}
          tabIndex={scrolls ? 0 : undefined}
          {...stylex.props(codeStyles.surface, styles.exact, focusRing)}
        >
          {inputOf(input)}
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
  id?: string;
}) => (
  <p id={id} role="note">
    <Text as="span" size="sm">
      {withheld === "revoked" ? (
        <Trans>
          What this would send is withheld: the run that asked for it may no
          longer read what it read, so you can only reject it.
        </Trans>
      ) : (
        <Trans>
          What this would send can&apos;t be shown right now, so you can only
          reject it for now. Try again in a moment.
        </Trans>
      )}
    </Text>
  </p>
);

/**
 * Where a held write would act and when it was asked for, and everything
 * it would send: what a person reads before they confirm it. Nothing of
 * it while withheld (`WithheldInput`).
 */
export const HeldWriteDetails = ({
  action,
  shown,
  withheldId,
}: {
  action: PendingAction;
  shown: Shown;
  /** The id of the line that says why it is withheld, if it is. */
  withheldId?: string;
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
    <div {...stylex.props(styles.stack)}>
      <Quiet>
        <Trans>On {where}</Trans>
      </Quiet>
      <Quiet>
        <Trans>
          Asked for <time dateTime={action.requestedAt}>{asked}</time>
        </Trans>
      </Quiet>
      {action.restricted ? (
        <Badge variant="warning">
          <Trans>
            This chat read private or restricted data: this may send it out
          </Trans>
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
            <p role="note">
              <Text as="span" size="sm">
                <Trans>
                  More will be sent than is shown above. Read exactly what will
                  be sent before you confirm.
                </Trans>
              </Text>
            </p>
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
      {shown.unseen ? (
        <Quiet id={shown.unseenId}>
          <Trans>
            Part of what will be sent is cut short above. Show it all, or
            exactly what will be sent, to confirm.
          </Trans>
        </Quiet>
      ) : null}
    </div>
  );
};

/** A held write as a confirmation in the chat: what it is, everything it sends, Reject and Confirm. */
export const HeldWrite = ({
  action,
  onDecided,
  onConfirmed,
}: {
  action: PendingAction;
  /**
   * Told once a decision ended, with why it failed if it did: connect
   * takes a confirmed action before it carries it out, so one that then
   * fails is gone, its card with it, and only the list can say why.
   */
  onDecided: (failed?: DecisionFailed) => void;
  /** Told once the person's confirmation went through. */
  onConfirmed: () => void;
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
    decision: (session: Session) => Promise<unknown>,
    confirming: boolean
  ): Promise<void> => {
    let reason: string | undefined;
    await run(decision, (failed) => {
      reason = failed;
    });
    onDecided(reason === undefined ? undefined : { what, reason });
    if (confirming && reason === undefined) {
      onConfirmed();
    }
    // Core notes the decision in the chat, which moves it up the chat
    // list: the list is read again so it shows under its new time.
    await router.invalidate();
  };
  return (
    <section aria-label={what}>
      <Confirmation approval={{ id: action.id }} state="approval-requested">
        <ConfirmationTitle>
          <ConfirmationRequest>
            <Trans>Waiting for you: {title}</Trans>
          </ConfirmationRequest>
        </ConfirmationTitle>
        <HeldWriteDetails action={action} shown={shown} />
        <ConfirmationActions>
          <DecisionButton
            disabled={busy}
            label={t`Reject ${what}`}
            onPress={async () => {
              await decide(declineHeld(action), false);
            }}
            variant="outline"
          >
            <Trans>Reject</Trans>
          </DecisionButton>
          <DecisionButton
            describedBy={shown.unseen ? shown.unseenId : undefined}
            disabled={busy || shown.unseen}
            label={t`Confirm ${what}`}
            onPress={async () => {
              await decide(confirmHeld(action), true);
            }}
          >
            <Trans>Confirm</Trans>
          </DecisionButton>
        </ConfirmationActions>
      </Confirmation>
    </section>
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
  onConfirmed,
}: {
  chatId: string;
  call: HeldAppCall;
  /**
   * Told once a decision ended, with why it failed if it did
   * (`DecisionFailed`): deciding ends the hold either way, so the card
   * goes, and only the list it was in can keep saying why.
   */
  onDecided: (failed?: DecisionFailed) => void;
  /** Told once the person's confirmation went through. */
  onConfirmed: () => void;
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
    decision: (session: Session) => Promise<unknown>,
    confirming: boolean
  ): Promise<void> => {
    let reason: string | undefined;
    await run(decision, (failed) => {
      reason = failed;
    });
    onDecided(reason === undefined ? undefined : { what, reason });
    if (confirming && reason === undefined) {
      onConfirmed();
    }
    await router.invalidate();
  };
  return (
    <section aria-label={what}>
      <Confirmation approval={{ id: call.id }} state="approval-requested">
        <ConfirmationTitle>
          <ConfirmationRequest>
            <Trans>Waiting for you: {title}</Trans>
          </ConfirmationRequest>
        </ConfirmationTitle>
        <div {...stylex.props(styles.stack)}>
          <Badge variant="warning">
            <Trans>This uses something only you can read</Trans>
          </Badge>
          <Quiet>
            <Trans>On {where}</Trans>
          </Quiet>
          <Quiet>
            <Trans>
              Asked for <time dateTime={call.heldAt}>{asked}</time>
            </Trans>
          </Quiet>
          <ExactInput
            input={call.request}
            onOpen={() => {
              // Open from the start: nothing waits for it.
            }}
            shown={false}
          />
        </div>
        <ConfirmationActions>
          <DecisionButton
            disabled={busy}
            label={t`Reject ${what}`}
            onPress={async () => {
              await decide(async (session) => {
                await session.chats.declineHeldCall(chatId, call.id);
              }, false);
            }}
            variant="outline"
          >
            <Trans>Reject</Trans>
          </DecisionButton>
          <DecisionButton
            disabled={busy}
            label={t`Confirm ${what}`}
            onPress={async () => {
              await decide(async (session) => {
                await session.chats.confirmHeldCall(
                  chatId,
                  call.id,
                  call.requestHash
                );
              }, true);
            }}
          >
            <Trans>Confirm</Trans>
          </DecisionButton>
        </ConfirmationActions>
      </Confirmation>
    </section>
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
    <div {...stylex.props(styles.rejectAll)}>
      <Quiet>
        <Plural
          one="# change waits for you to confirm or reject it."
          other="# changes wait for you to confirm or reject them."
          value={count}
        />
      </Quiet>
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
  onConfirmed,
}: {
  chatId: string;
  version: number;
  onConfirmed: () => void;
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
    return <FailureLine>{held.message}</FailureLine>;
  }
  const count =
    held.state === "loading" ? 0 : held.actions.length + held.calls.length;
  if (held.state === "loading" || (count === 0 && failed === undefined)) {
    return null;
  }
  return (
    <section aria-label={t`Waiting for you`} {...stylex.props(styles.list2)}>
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
          onConfirmed={onConfirmed}
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
          onConfirmed={onConfirmed}
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
 * decision. `onConfirmed` is told each time a confirmation went through:
 * a rejection, or one that failed, tells it nothing.
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
