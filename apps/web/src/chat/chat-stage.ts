import type { ChatPlacement } from "./chat-layout.ts";

// What of Grasp's chat shows on a page (global-chat.tsx): its idle bar at
// the page's foot, or the chat itself in App shell's panels, docked or
// floating. App shell moves the chat between the two in one motion, the
// same card throughout, so a draft and a scroll stay; the bar comes and
// goes in the shell's dock.

export interface ChatStage {
  bar: boolean;
  card: boolean;
  /** Where the card is. */
  placement: ChatPlacement;
}

/** What shows: the chat open as laid out, or its bar. */
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
  /** Room beside the page to float over: not on a phone, where it is docked. */
  roomBeside: boolean;
  /** A place for the idle bar: not on Chat's own page, where the page asks. */
  barHere: boolean;
}): ChatStage =>
  available && open
    ? { bar: false, card: true, placement: roomBeside ? placement : "docked" }
    : { bar: available && barHere, card: false, placement };
