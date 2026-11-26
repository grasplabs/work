import type { SpeechSynthesis } from "@grasp-os/shared/voice";

import { models } from "./models.ts";
import type { SpeechCall } from "./models.ts";
import { platformAi } from "./platform-ai.ts";

// Speech synthesis as core implements it: Grasp's own speech feature,
// ElevenLabs for an interview's lines and for the admin's onboarding, each
// with its own voices (platform-ai.ts), through the model gateway
// (models.ts), which judges every line by the deployment's rules, meters
// and audits it, and reaches ElevenLabs, in the EU, through connect with
// Grasp's own key. Without that key, every line is refused (`model.not_allowed`).

/** Who says lines, and why: the gateway's audit and rules go by it. */
export type SpeechCaller = Omit<
  SpeechCall,
  "model" | "text" | "voice" | "language"
>;

/** Who a line is said to: someone in their interview, or an admin in their onboarding. */
export type SpeechAudience = "interview" | "onboarding";

/**
 * The speech model and voices a line to `audience` is said with: an
 * interview's in the voice of the agent that holds it live, so Stephen
 * sounds as one throughout.
 */
export const speechOf = (audience: SpeechAudience = "interview") =>
  audience === "onboarding" ? platformAi.onboardingSpeech : platformAi.speech;

/** The speech model, as the gateway names it. */
export const speechModelOf = (audience?: SpeechAudience): string => {
  const { provider, model } = speechOf(audience);
  return `${provider}/${model}`;
};

/** Speech for `caller`: each line in the speech model, or the one the request names. */
export const platformSpeech = (
  env: Env,
  caller: SpeechCaller
): SpeechSynthesis => ({
  speak: async ({ text, voice, language, model }, signal, onAudio) => {
    const named = model ?? speechModelOf();
    return await models(env).speak(
      { ...caller, model: named, text, voice, language },
      signal,
      onAudio
    );
  },
});
