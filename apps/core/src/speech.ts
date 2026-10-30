import { modelErrors } from "@grasp-os/shared/models";
import type { SpeechSynthesis } from "@grasp-os/shared/voice";

import { models } from "./models.ts";
import type { ModelsEnv, SpeechCall } from "./models.ts";
import { platformAi } from "./platform-ai.ts";

// Speech synthesis as core implements it: Grasp's own speech feature
// (@grasp-os/shared/platform-ai), the provider and model the platform's
// settings name, OpenAI's by default, through the model gateway
// (models.ts), which judges every line by the deployment's rules, charges
// it against the budgets and audits it, and reaches the provider through
// connect with Grasp's own key. Without that key, or with settings that
// don't parse, every line fails closed (`model.not_allowed`,
// `model.unconfigured`).

/** Who says lines, and why: the gateway's audit and rules go by it. */
export type SpeechCaller = Omit<
  SpeechCall,
  "model" | "text" | "voice" | "language" | "instructions"
>;

/** The speech model the platform's settings name, as the gateway names it. */
export const speechModelOf = (env: ModelsEnv): string | undefined => {
  const speech = platformAi(env)?.speech;
  return speech === undefined
    ? undefined
    : `${speech.provider}/${speech.model}`;
};

/**
 * Speech for `caller`: each line in the speech model the platform's
 * settings name, or the one the request names.
 */
export const platformSpeech = (
  env: ModelsEnv,
  caller: SpeechCaller
): SpeechSynthesis => ({
  speak: async ({ text, voice, language, model, instructions }, signal) => {
    const named = model ?? speechModelOf(env);
    if (named === undefined) {
      throw modelErrors.create("model.unconfigured");
    }
    return await models(env).speak(
      {
        ...caller,
        model: named,
        text,
        voice,
        language,
        ...(instructions === undefined ? {} : { instructions }),
      },
      signal
    );
  },
});
