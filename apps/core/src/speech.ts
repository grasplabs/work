import type { SpeechSynthesis } from "@grasp-os/shared/voice";

import { gatewaySettings, models } from "./models.ts";
import type { ModelsEnv, SpeechCall } from "./models.ts";

// Speech synthesis as core implements it (`elevenlabs-gateway`):
// ElevenLabs, through the model gateway (models.ts), which judges every
// line by the deployment's rules, charges it against the budgets and
// audits it. On plain workerd, with no AI binding, every line fails
// closed (`model.unconfigured`), as model calls do.

/** Who says lines, and why: the gateway's audit and rules go by it. */
export type SpeechCaller = Omit<
  SpeechCall,
  "model" | "text" | "voice" | "language"
>;

/**
 * The voice model a line is said in where the deployment allows none: the
 * gateway refuses it, so the line is refused, and audited, for what it is.
 */
const unallowedVoiceModel = "elevenlabs/eleven_v4";

/**
 * Speech for `caller`, through the deployment's AI Gateway: each line in
 * the voice model it names, or the first voice model the deployment
 * allows when it names none.
 */
export const gatewaySpeech = (
  env: ModelsEnv,
  caller: SpeechCaller
): SpeechSynthesis => ({
  speak: async ({ text, voice, language, model }, signal) => {
    const [allowed] = gatewaySettings(env).voices;
    const named = model ?? allowed ?? unallowedVoiceModel;
    return await models(env).speak(
      { ...caller, model: named, text, voice, language },
      signal
    );
  },
});
