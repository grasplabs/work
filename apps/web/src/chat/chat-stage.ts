import { useState } from "react";

import type { ChatPlacement } from "./chat-layout.ts";

// What of Grasp's chat shows, step by step (global-chat.tsx): the idle bar,
// the room the chat docks into (the shell's right Panel), and the chat's
// card, docked or floating. When the layout changes (chat-layout.ts), the
// stage moves toward it in steps, each once the step before has finished
// moving (its `onOpenChangeComplete`): what goes, then what comes. Every
// part comes and goes the same way, reversed, in the same time, and a step
// that moves the room with the card starts the second a beat after the
// first (the kit's `delayed`) either way, so every change is one motion played forwards or backwards:
//
// - opening docked: the bar goes; the room opens, and the card comes in
//   after it; closing docked: the card goes, and the room closes after it;
//   the bar comes back;
// - floating, the same without the room;
// - docking or undocking: the card goes (and the room closes after it,
//   undocking); the room opens (docking) and the card comes in after it.

/** A part of the chat that moves, and says when it has. */
export type ChatPart = "bar" | "room" | "card";

export interface ChatStage {
  bar: boolean;
  room: boolean;
  card: boolean;
  /** Where the card is; it moves only while hidden. */
  placement: ChatPlacement;
}

/** Which parts move a beat after the other in this step (the kit's `delayed`). */
export type ChatDelays = Record<ChatPart, boolean>;

const noDelays: ChatDelays = { bar: false, room: false, card: false };

/** The stage once everything has moved: the chat open as laid out, or its bar. */
export const stageOf = ({
  available,
  open,
  placement,
  roomBeside,
  barHere,
}: {
  available: boolean;
  open: boolean;
  placement: ChatPlacement;
  /** Room beside the page to dock into: not on a phone. */
  roomBeside: boolean;
  /** A place for the idle bar: not on Chat's own page, where the page asks. */
  barHere: boolean;
}): ChatStage =>
  available && open
    ? {
        bar: false,
        room: placement === "docked" && roomBeside,
        card: true,
        placement,
      }
    : { bar: available && barHere, room: false, card: false, placement };

/** One step: the stage it shows, which parts move a beat later in it, and the part whose finishing ends it (none where nothing seen moves). */
interface Step {
  stage: ChatStage;
  delays: ChatDelays;
  waitFor: ChatPart | null;
}

/** The next step that takes something away, if anything goes. */
const goingStep = (stage: ChatStage, target: ChatStage): Step | undefined => {
  // It goes where it closes, or moves between docked and floating.
  const moves = stage.placement !== target.placement;
  const cardGoes = stage.card && (!target.card || moves);
  if (cardGoes) {
    // The room closes after it, where it no longer docks.
    const roomCloses = stage.room && !target.room;
    return {
      stage: { ...stage, card: false, room: stage.room && target.room },
      delays: { ...noDelays, room: roomCloses },
      waitFor: roomCloses ? "room" : "card",
    };
  }
  if (stage.room && !target.room) {
    return {
      stage: { ...stage, room: false },
      delays: noDelays,
      waitFor: "room",
    };
  }
  if (stage.bar && !target.bar) {
    return {
      stage: { ...stage, bar: false },
      delays: noDelays,
      waitFor: "bar",
    };
  }
  return undefined;
};

/** The next step that brings something in, once nothing goes. */
const comingStep = (stage: ChatStage, target: ChatStage): Step | undefined => {
  if (!stage.card && target.card) {
    // It comes in after the room opens, where it docks into one.
    const roomOpens = !stage.room && target.room;
    return {
      stage: {
        ...stage,
        card: true,
        room: target.room,
        placement: target.placement,
      },
      delays: { ...noDelays, card: roomOpens },
      waitFor: "card",
    };
  }
  if (!stage.room && target.room) {
    return {
      stage: { ...stage, room: true },
      delays: noDelays,
      waitFor: "room",
    };
  }
  if (!stage.bar && target.bar) {
    return { stage: { ...stage, bar: true }, delays: noDelays, waitFor: "bar" };
  }
  return undefined;
};

/**
 * The next step from `stage` toward `target`; none once there. The card
 * takes its new place unseen while hidden, which waits for nothing.
 */
export const nextStep = (
  stage: ChatStage,
  target: ChatStage
): Step | undefined =>
  goingStep(stage, target) ??
  comingStep(stage, target) ??
  (stage.placement === target.placement
    ? undefined
    : {
        stage: { ...stage, placement: target.placement },
        delays: noDelays,
        waitFor: null,
      });

/**
 * Whether the part a step waits for says when it has finished moving: only
 * the floating card does (ChatPanel). Docked the chat lives
 * in App shell's panels, and the idle bar in its dock (chat-bar.tsx), which
 * show and hide with no word when done, so a step waits for neither. The card a step takes away is where it was;
 * the one it brings, where it goes.
 */
const saysSettled = (
  part: ChatPart,
  from: ChatStage,
  to: ChatStage
): boolean => {
  if (part !== "card") {
    return false;
  }
  return (from.card ? from.placement : to.placement) === "floating";
};

/**
 * The stage, moving toward `target`, with which parts move a beat later in its
 * step; `settled` is what each part calls once it has finished moving, for
 * the next step to start.
 */
export const useChatStage = (
  target: ChatStage
): {
  stage: ChatStage;
  delays: ChatDelays;
  settled: (part: ChatPart) => void;
} => {
  // As the page loads, it shows as laid out, without moving.
  const [stage, setStage] = useState(target);
  const [delays, setDelays] = useState(noDelays);
  const [waiting, setWaiting] = useState<ChatPart | null>(null);
  if (waiting === null) {
    const next = nextStep(stage, target);
    if (next !== undefined) {
      setStage(next.stage);
      setDelays(next.delays);
      setWaiting(
        next.waitFor !== null && saysSettled(next.waitFor, stage, next.stage)
          ? next.waitFor
          : null
      );
    }
  }
  return {
    stage,
    delays,
    settled: (part) => {
      if (part === waiting) {
        setWaiting(null);
      }
    },
  };
};
