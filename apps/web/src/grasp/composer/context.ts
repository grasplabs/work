// Whether the composer round a part is out of use, so its slot actions dim with it.
import { createContext, useContext } from "react";

export const DisabledContext = createContext(false);

export const useComposerDisabled = () => useContext(DisabledContext);

// Opens the mention menu at the caret, one level in at a kind or at the kinds (the plus menu uses it).
export const MentionContext = createContext<
  ((kind: string | null) => void) | null
>(null);

export const useOpenMentions = () => useContext(MentionContext);

/** A level the card's working edge follows, read at each frame: dictation's drawn level. */
export interface ComposerListener {
  read: () => number;
}

// Lets a dictation (voice.tsx) hand the card its level, so the dithered edge listens with it.
export const ListenContext = createContext<
  ((listener: ComposerListener | null) => void) | null
>(null);

export const useComposerListen = () => useContext(ListenContext);

// The one row stood tall (its text over the controls) as a takeover came: a dictation keeps that
// form, so the card never changes height for it (voice.tsx).
export const RowTallContext = createContext(false);

export const useComposerRowTall = () => useContext(RowTallContext);
