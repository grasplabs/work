import type { DockablePlacement } from "@grasp-os/ui/components/dockable-panel";
import { useState } from "react";

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
//   undocking); the room opens (docking) and the card comes in after it;
// - going full screen, or back beside the page: the card moves open, in
//   one step (DockablePanel), while the page's content fades (AppShellMain);
//   the room stays under it, so the page doesn't move as it glides;
// - opening full screen: the card comes in over the page, with no room.

/** A part of the chat that moves, and says when it has. */
export type ChatPart = "bar" | "room" | "card";

export interface ChatStage {
  bar: boolean;
  room: boolean;
  card: boolean;
  /** Where the card is; it moves only while hidden. */
  placement: DockablePlacement;
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
  placement: DockablePlacement;
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

/** Whether the card moves between `from` and `to` open, gliding: between docked and full screen. */
const glides = (from: DockablePlacement, to: DockablePlacement): boolean =>
  from !== "floating" && to !== "floating";

/** The next step that takes something away, if anything goes. */
const goingStep = (stage: ChatStage, target: ChatStage): Step | undefined => {
  // It goes where it closes, or moves to or from floating; between docked
  // and full screen it glides instead.
  const moves =
    stage.placement !== target.placement &&
    !glides(stage.placement, target.placement);
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

/**
 * The card gliding between beside the page and full screen, open, with the
 * room it needs beside the page opening as it goes; waits for the room
 * where it moves, and for nothing else.
 */
const glideStep = (stage: ChatStage, target: ChatStage): Step | undefined => {
  const gliding =
    stage.card &&
    target.card &&
    stage.placement !== target.placement &&
    glides(stage.placement, target.placement);
  if (!gliding) {
    return undefined;
  }
  return {
    stage: { ...stage, placement: target.placement, room: target.room },
    delays: noDelays,
    waitFor: stage.room === target.room ? null : "room",
  };
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
 * `target`, with the room left as it is under a card full screen that is
 * showing already: one that glided there from beside the page keeps its
 * room, so the page under it doesn't move, and one opened full screen
 * has none.
 */
const withRoomKept = (stage: ChatStage, target: ChatStage): ChatStage =>
  stage.card &&
  stage.placement !== "floating" &&
  target.placement === "fullscreen"
    ? { ...target, room: stage.room }
    : target;

/**
 * The next step from `stage` toward `target`; none once there. The card
 * takes its new place unseen while hidden, and gliding while open, which
 * waits for nothing.
 */
export const nextStep = (
  stage: ChatStage,
  target: ChatStage
): Step | undefined => {
  const wanted = withRoomKept(stage, target);
  return (
    goingStep(stage, wanted) ??
    glideStep(stage, wanted) ??
    comingStep(stage, wanted) ??
    (stage.placement === wanted.placement
      ? undefined
      : {
          stage: { ...stage, placement: wanted.placement },
          delays: noDelays,
          waitFor: null,
        })
  );
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
      setWaiting(next.waitFor);
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
