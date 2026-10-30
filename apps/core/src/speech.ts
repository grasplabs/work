import { modelErrors } from "@grasp-os/shared/models";
import type { SpeechSynthesis } from "@grasp-os/shared/voice";

import { models } from "./models.ts";
import type { SpeechCall } from "./models.ts";
import { platformAi } from "./platform-ai.ts";

// Speech synthesis as core implements it: Grasp's own speech feature
// (@grasp-os/shared/platform-ai), ElevenLabs in the model the platform's
// settings name, through the model gateway (models.ts), which judges
// every line by the deployment's rules, meters and audits it, and reaches
// ElevenLabs through connect with Grasp's own key. Without that key, or
// with settings that don't parse, every line fails closed
// (`model.not_allowed`, `model.unconfigured`).

/** Who says lines, and why: the gateway's audit and rules go by it. */
export type SpeechCaller = Omit<
  SpeechCall,
  "model" | "text" | "voice" | "language"
>;

/**
 * The speech model the platform's settings name, as the gateway names it:
 * the quicker one for a line only known as it is said (`quick`).
 */
export const speechModelOf = (env: Env, quick = false): string | undefined => {
  const speech = platformAi(env)?.speech;
  if (speech === undefined) {
    return undefined;
  }
  return `${speech.provider}/${quick ? speech.quickModel : speech.model}`;
};

/**
 * Speech for `caller`: each line in the speech model the platform's
 * settings name, or the one the request names.
 */
export const platformSpeech = (
  env: Env,
  caller: SpeechCaller
): SpeechSynthesis => ({
  speak: async ({ text, voice, language, model }, signal) => {
    const named = model ?? speechModelOf(env);
    if (named === undefined) {
      throw modelErrors.create("model.unconfigured");
    }
    return await models(env).speak(
      { ...caller, model: named, text, voice, language },
      signal
    );
  },
});
