import type { SpeechSynthesis } from "@grasp-os/shared/voice";

import { models } from "./models.ts";
import type { SpeechCall } from "./models.ts";
import { platformAi } from "./platform-ai.ts";

// Speech synthesis as core implements it: Grasp's own speech feature,
// ElevenLabs's (platform-ai.ts), through the model gateway (models.ts),
// which judges every line by the deployment's rules, meters and audits
// it, and reaches ElevenLabs's EU host through connect with Grasp's own
// key. Without that key, every line is refused (`model.not_allowed`).

/** Who says lines, and why: the gateway's audit and rules go by it. */
export type SpeechCaller = Omit<
  SpeechCall,
  "model" | "text" | "voice" | "language"
>;

/**
 * The speech model, as the gateway names it: the quicker one for a line
 * only known as it is said (`quick`).
 */
export const speechModelOf = (quick = false): string => {
  const { speech } = platformAi;
  return `${speech.provider}/${quick ? speech.quickModel : speech.model}`;
};

/** Speech for `caller`: each line in the speech model, or the one the request names. */
export const platformSpeech = (
  env: Env,
  caller: SpeechCaller
): SpeechSynthesis => ({
  speak: async ({ text, voice, language, model }, signal) => {
    const named = model ?? speechModelOf();
    return await models(env).speak(
      { ...caller, model: named, text, voice, language },
      signal
    );
  },
});
