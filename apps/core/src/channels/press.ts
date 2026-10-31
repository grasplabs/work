import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson, PendingAction } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ActionEvent, StateAdapter } from "chat";

import { signInConfig } from "../auth/config.ts";
import {
  confirmPendingAction,
  declinePendingAction,
} from "../pending-actions.ts";
import { appLocale } from "./answer.ts";
import {
  cancelAction,
  confirmAction,
  heldWritesCard,
  pressOf,
} from "./cards.tsx";
import type {
  HeldWriteView,
  Press,
  PressOutcome,
  WriteState,
} from "./cards.tsx";
import { memberOf, viewOf } from "./held.ts";
import { pressedChanges } from "./stephen-requests.ts";
import { say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// A press on a card of held writes (cards.tsx `heldWritesCard`), on a chat
// platform: D2, "a verified Teams press confirms exactly the held writes
// on its card, once". The press is the person's yes, for exactly what the
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
// Every decision is connect's to record, by the person, `via` the
// platform. Still to settle before merge, with Nick: D2 itself (GRA-699),
// the threat model's ids (GRA-700), and the seam with GRA-620's one
// decision path for held writes and unknown outcomes.

/** How long a card is remembered as pressed: past any write's life. */
const pressedTtlMs = 30 * 24 * 60 * 60 * 1000;

/** A press on a card, as the door hands it on, from a verified member. */
export interface CardPress {
  platform: "teams";
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
const sayThere = async (
  event: ActionEvent,
  line: "alreadyAnswered" | "changedSince" | "removed",
  locale: ChannelLocale
): Promise<void> => {
  try {
    await event.adapter.postMessage(event.threadId, say(line, locale));
  } catch (error) {
    log.warn("channel.line_failed", errorFields(error));
  }
};

/**
 * The card's writes as connect still holds them for the person, each with
 * the hash the card showed, in the card's order; null when any isn't:
 * gone, decided, another's, or changed.
 */
const stillAsShown = async (
  env: Env,
  person: ConnectionPerson,
  press: Press
): Promise<PendingAction[] | null> => {
  const held: PendingAction[] = [];
  for (const { id, inputHash } of press) {
    // oxlint-disable-next-line no-await-in-loop -- in the card's order
    const found = await env.CONNECT.pendingAction({ person, id });
    if (found?.inputHash !== inputHash) {
      return null;
    }
    held.push(found);
  }
  return held;
};

/** How a confirmed write that failed ended, as its card shows it. */
const failedAs = (
  error: unknown
): { state: WriteState; outcome: PressOutcome } => {
  const code = connectErrors.codeOf(error);
  if (code === "connect.outcome_unknown") {
    return { state: "unknown", outcome: "unknownOutcome" };
  }
  if (code === "connect.pending_changed") {
    return { state: "skipped", outcome: "changedSince" };
  }
  return { state: "failed", outcome: "stopped" };
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
    `press:${platform}:${event.threadId}:${event.messageId}`,
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
  const held = await stillAsShown(env, person, press);
  const origin = signInConfig(env)?.origin ?? "";
  if (held === null) {
    log.info("channel.press_refused", { platform, reason: "changed" });
    await sayThere(event, "changedSince", locale);
    return;
  }
  const [firstWrite] = held;
  const chatId =
    firstWrite?.context.type === "chat" ? firstWrite.context.chatId : "";
  const openUrl = `${origin}/?chat=${encodeURIComponent(chatId)}`;
  const writes: HeldWriteView[] = held.map(viewOf);
  const shown = (outcome?: PressOutcome) => ({
    locale,
    writes,
    openUrl,
    ...(outcome === undefined ? {} : { outcome }),
  });
  if (!confirming) {
    for (const write of writes) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, each recorded
        await declinePendingAction(env, identity, write.id, platform);
      } catch (error) {
        log.warn("channel.decline_failed", errorFields(error));
      }
      write.state = "skipped";
    }
    await editCard(event, shown("cancelled"));
    return;
  }
  for (const [index, write] of writes.entries()) {
    write.state = "running";
    // oxlint-disable-next-line no-await-in-loop -- the card ticks as each runs
    await editCard(event, shown());
    try {
      // oxlint-disable-next-line no-await-in-loop -- in order, stopping at a failure
      await confirmPendingAction(
        env,
        identity,
        write.id,
        write.inputHash,
        platform
      );
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
      // request with the answer that showed it, never a second.
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await pressedChanges(env, {
        userId,
        writeId: write.id,
        action: held[index]?.action ?? "",
      });
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await editCard(event, shown(outcome));
      return;
    }
  }
  await editCard(event, shown("allDone"));
};
