// Whether the composer round a part is out of use, so its slot actions dim with it.
import { createContext, useContext } from "react";

export const DisabledContext = createContext(false);

export const useComposerDisabled = () => useContext(DisabledContext);

// Whether a voice action stands alone in send's place (nothing written yet), so it is filled.
export const VoiceContext = createContext(false);

export const useVoiceAlone = () => useContext(VoiceContext);

// Opens the mention menu at the caret, one level in at a kind or at the kinds (the plus menu uses it).
export const MentionContext = createContext<
  ((kind: string | null) => void) | null
>(null);

export const useOpenMentions = () => useContext(MentionContext);
