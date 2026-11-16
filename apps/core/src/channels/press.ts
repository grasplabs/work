import { agentErrors } from "@grasp-os/shared/agent";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson, PendingAction } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ActionEvent, StateAdapter } from "chat";

import { confirmHeldAppCall, declineHeldAppCall } from "../held-app-calls.ts";
import {
  confirmPendingAction,
  declinePendingAction,
} from "../pending-actions.ts";
import { appLocale } from "./answer.ts";
import {
  cancelAction,
  confirmAction,
  confirmableOn,
  heldWritesCard,
  pressOf,
  wholeAlone,
} from "./cards.tsx";
import type {
  HeldWriteView,
  Press,
  PressOutcome,
  WriteState,
} from "./cards.tsx";
import {
  appViewOf,
  heldAppCallsIn,
  inertView,
  memberOf,
  viewOf,
} from "./held.ts";
import { pressedChanges } from "./stephen-requests.ts";
import { say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// A press on a card of held writes (cards.tsx `heldWritesCard`), on a chat
// platform (Teams, and Slack the same way): D2, "a verified Teams press
// confirms exactly the held writes on its card, once". The press is the person's yes, for exactly what the
// card showed and nothing else; Cancel is their no.
//
// What could go wrong, and what stops each. Each names the threat model's
// id once it has one (GRA-700: `[GRA-700 P?]` until then).
//
// - [GRA-700 P?] A press anyone could forge or send for someone else. A
//   press comes through the door like a message (door.ts): signed by the
//   platform for the client's bot, from the client's tenant, in the
//   sender's own private chat, from a member known by the id the platform
//   verified. `userId` is that member; nothing in the press names who
//   presses.
// - [GRA-700 P?] Another person's card. A held write waits for one person
//   (`onBehalfOf`), and connect finds, and confirms, only that person's own
//   (`pendingAction`, `confirmAction`): another's ids run nothing.
// - [GRA-700 P?] A press that runs more, or other, than the card showed.
//   The press carries the card's writes' ids and input hashes; every one
//   must still be held, with that very hash, before any runs, and connect
//   checks the hash again as it takes each (`connect.pending_changed`).
//   Nothing outside the press's list runs.
// - [GRA-700 P?] A second press, or the platform sending the press again.
//   The door takes each activity once (its id), and a card is pressed once
//   (`pressed`, by the card's message): a second press, Confirm or Cancel,
//   runs nothing and says so. Connect takes each held write at most once
//   besides.
// - [GRA-700 P?] A write that changed, went or was decided elsewhere since
//   the card showed it (in Grasp's own app, or by a drop). Then nothing on
//   the card runs: the card says it changed, and the person asks again.
// - [GRA-700 P?] A failure part way. The writes run in the card's order and
//   stop at the first that fails, or whose outcome is unknown: the rest
//   stay held, nothing after runs, and the card says so.
// - [GRA-700 P?] The platform giving up and resending. The door answers at
//   once; the writes run after, as the request's background work, and the
//   card is edited in place as each ends.
//
// A write to an App held in the chat (held-app-calls.ts, GRA-1929; its
// threat model is on the issue) is on the same card and decided by the
// same press, through the functions Grasp's own chat decides one by: the
// press names its chat, which must be the presser's own, come through this
// platform, and hold it still waiting with the hash the card showed; it is
// decided once, in the Workspace's write that takes it, with its person's
// authority checked again as it runs.
//
// Every decision on a connection's write is connect's to record, by the
// person, `via` the platform; one on a write to an App the chat's
// Workspace's, as in Grasp. Still to settle before merge, with Nick: D2 itself (GRA-699),
// the threat model's ids (GRA-700), and the seam with GRA-620's one
// decision path for held writes and unknown outcomes.

/** How long a card is remembered as pressed: past any write's life. */
export const pressedTtlMs = 30 * 24 * 60 * 60 * 1000;

/** What marks a card pressed, by its message: one press runs, once. */
export const pressedKey = (
  platform: string,
  { threadId, messageId }: Pick<ActionEvent, "threadId" | "messageId">
): string => `press:${platform}:${threadId}:${messageId}`;

/** A press on a card, as the door hands it on, from a verified member. */
export interface CardPress {
  platform: "teams" | "slack";
  /** The member who pressed, as the door verified them. */
  userId: string;
  event: ActionEvent;
  state: StateAdapter;
}

/** The card as it stands, edited in place. */
const editCard = async (
  event: ActionEvent,
  card: Parameters<typeof heldWritesCard>[0]
): Promise<void> => {
  try {
    await event.adapter.editMessage(
      event.threadId,
      event.messageId,
      heldWritesCard(card)
    );
  } catch (error) {
    log.warn("channel.card_edit_failed", errorFields(error));
  }
};

/** Says one line where the card was pressed. */
export const sayThere = async (
  event: ActionEvent,
  line:
    | "alreadyAnswered"
    | "cardTooLong"
    | "changedSince"
    | "heldLater"
    | "removed"
    | "undoFailed",
  locale: ChannelLocale
): Promise<void> => {
  try {
    await event.adapter.postMessage(event.threadId, say(line, locale));
  } catch (error) {
    log.warn("channel.line_failed", errorFields(error));
  }
};

/** A write the card showed, as it is still held: connect's, or one to an App. */
type StillHeld = { view: HeldWriteView; at: number } & (
  | { held: PendingAction }
  | { chatId: string }
);

/**
 * The card's writes as they are still held for the person, each with the
 * hash the card showed, in the card's order, as the card shows them on
 * `platform` in `locale`; null when any isn't: gone, decided, lapsed,
 * another's, from another channel, or changed.
 */
const stillAsShown = async (
  env: Env,
  { userId, person }: { userId: string; person: ConnectionPerson },
  press: Press,
  { platform, locale }: { platform: string; locale: ChannelLocale }
): Promise<StillHeld[] | null> => {
  const held: StillHeld[] = [];
  for (const { id, inputHash, chatId } of press) {
    if (chatId === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- in the card's order
      const found = await env.CONNECT.pendingAction({ person, id });
      if (found?.inputHash !== inputHash) {
        return null;
      }
      held.push({
        held: found,
        view: inertView(platform, viewOf(found)),
        at: Date.parse(found.requestedAt),
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- in the card's order
    const calls = await heldAppCallsIn(env, userId, chatId, platform);
    const call = calls.find((each) => each.id === id);
    if (call?.requestHash !== inputHash) {
      return null;
    }
    held.push({
      chatId,
      view: inertView(platform, appViewOf(chatId, call, locale)),
      at: Date.parse(call.heldAt),
    });
  }
  return held;
};

/**
 * Why a Confirm on `held` (a press's writes, as held now) can't run, or
 * null when it can. A card to confirm carries the prefix, in the order
 * asked, of its turn's writes that lay out whole together
 * (cards.tsx `heldWritesCards`); a press can't name the turn it is of, so
 * its writes are held to what such a prefix guarantees:
 * - they lay out whole together on one card, measured as a card to
 *   confirm is (`confirmableOn`), else `cardTooLong`;
 * - they are of one chat, and no write to an App of that chat that still
 *   waits, asked before the last of them, is left out, unless no card can
 *   show it whole (it can never be confirmed): else `heldLater`. So no
 *   write runs ahead of a write to an App asked before it that could still
 *   be confirmed. A connection's write is listed only by the turn that
 *   held it, so a later turn's press can't leave one out.
 */
const notConfirmable = async (
  env: Env,
  userId: string,
  held: readonly StillHeld[],
  card: { platform: string; locale: ChannelLocale }
): Promise<"cardTooLong" | "heldLater" | null> => {
  const writes = held.map(({ view }) => view);
  if (!confirmableOn({ ...card, writes })) {
    return "cardTooLong";
  }
  const chats = new Set(
    held.map((write) => {
      if ("chatId" in write) {
        return write.chatId;
      }
      const { context } = write.held;
      return context.type === "chat" ? context.chatId : null;
    })
  );
  const [chatId] = chats;
  if (chats.size !== 1 || chatId === undefined || chatId === null) {
    return "heldLater";
  }
  const last = Math.max(...held.map(({ at }) => at));
  const named = new Set(writes.map(({ id }) => id));
  const waiting = await heldAppCallsIn(env, userId, chatId, card.platform);
  const leftOut = waiting.some(
    (call) =>
      Date.parse(call.heldAt) < last &&
      !named.has(call.id) &&
      wholeAlone(
        card,
        inertView(card.platform, appViewOf(chatId, call, card.locale))
      )
  );
  return leftOut ? "heldLater" : null;
};

/** How a confirmed write that failed ended, as its card shows it. */
const failedAs = (
  error: unknown
): { state: WriteState; outcome: PressOutcome } => {
  const code = connectErrors.codeOf(error);
  if (code === "connect.outcome_unknown") {
    return { state: "unknown", outcome: "unknownOutcome" };
  }
  if (
    code === "connect.pending_changed" ||
    agentErrors.codeOf(error) === "agent.held_call_not_found"
  ) {
    return { state: "skipped", outcome: "changedSince" };
  }
  return { state: "failed", outcome: "stopped" };
};

/** Confirms, or with `confirm` false declines, one write of the card, as `identity`, `via` `platform`. */
const decide = async (
  env: Env,
  identity: Identity,
  platform: string,
  write: StillHeld,
  confirm: boolean
): Promise<void> => {
  const { id, inputHash } = write.view;
  if ("chatId" in write) {
    const where = { chatId: write.chatId, via: platform };
    await (confirm
      ? confirmHeldAppCall(env, identity, where, id, inputHash)
      : declineHeldAppCall(env, identity, where, id));
    return;
  }
  await (confirm
    ? confirmPendingAction(env, identity, id, inputHash, platform)
    : declinePendingAction(env, identity, id, platform));
};

/**
 * Runs a press on a card of held writes: Confirm runs exactly the card's
 * writes, in order, once, stopping at the first that fails; Cancel
 * declines them. Anything else, or a card pressed before, runs nothing.
 */
export const pressCard = async (
  env: Env,
  { platform, userId, event, state }: CardPress
): Promise<void> => {
  const press = pressOf(event.value);
  const confirming = event.actionId === confirmAction;
  if (press === null || (!confirming && event.actionId !== cancelAction)) {
    return;
  }
  const locale = appLocale(event.raw);
  const first = await state.setIfNotExists(
    pressedKey(platform, event),
    true,
    pressedTtlMs
  );
  if (!first) {
    await sayThere(event, "alreadyAnswered", locale);
    return;
  }
  const member = await memberOf(env, userId);
  if (member === null) {
    await sayThere(event, "removed", locale);
    return;
  }
  const { identity, person } = member;
  const held = await stillAsShown(env, { userId, person }, press, {
    platform,
    locale,
  });
  if (held === null) {
    log.info("channel.press_refused", { platform, reason: "changed" });
    await sayThere(event, "changedSince", locale);
    return;
  }
  // As the card showed them, what the model wrote inert (held.ts).
  const writes: HeldWriteView[] = held.map(({ view }) => view);
  // Confirm only what a card to confirm could carry (`notConfirmable`): a
  // press sent with a card's writes that has Cancel alone runs nothing.
  const refused = confirming
    ? await notConfirmable(env, userId, held, { platform, locale })
    : null;
  if (refused !== null) {
    log.info("channel.press_refused", { platform, reason: refused });
    await sayThere(event, refused, locale);
    return;
  }
  const shown = (outcome?: PressOutcome) => ({
    locale,
    platform,
    writes,
    ...(outcome === undefined ? {} : { outcome }),
  });
  if (!confirming) {
    for (const write of held) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, each recorded
        await decide(env, identity, platform, write, false);
      } catch (error) {
        log.warn("channel.decline_failed", errorFields(error));
      }
      write.view.state = "skipped";
    }
    await editCard(event, shown("cancelled"));
    return;
  }
  for (const [index, write] of writes.entries()) {
    const still = held[index];
    if (still === undefined) {
      break;
    }
    write.state = "running";
    // oxlint-disable-next-line no-await-in-loop -- the card ticks as each runs
    await editCard(event, shown());
    try {
      // oxlint-disable-next-line no-await-in-loop -- in order, stopping at a failure
      await decide(env, identity, platform, still, true);
      write.state = "done";
    } catch (error) {
      const { state: ended, outcome } = failedAs(error);
      write.state = ended;
      for (const rest of writes.slice(index + 1)) {
        rest.state = "skipped";
      }
      log.warn("channel.press_stopped", {
        platform,
        outcome,
        ...errorFields(error),
      });
      // The request the card is for keeps that its change didn't work: one
      // request with the answer that showed it, never a second. A
      // connection's change, which its tools name by action; a write to an
      // App is counted as the App's look-up (stephen-requests.ts).
      if ("held" in still) {
        // oxlint-disable-next-line no-await-in-loop -- once, then out
        await pressedChanges(env, {
          userId,
          writeId: write.id,
          action: still.held.action,
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await editCard(event, shown(outcome));
      return;
    }
  }
  await editCard(event, shown("allDone"));
};
