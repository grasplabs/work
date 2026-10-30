import { jsonVar } from "@grasp-os/shared/config";
import { log } from "@grasp-os/shared/log";
import {
  parsePlatformAi,
  platformAiSchema,
} from "@grasp-os/shared/platform-ai";
import type { PlatformAi } from "@grasp-os/shared/platform-ai";

// Which provider and model each of Grasp's own AI features uses
// (@grasp-os/shared/platform-ai): the `PLATFORM_AI` var, deployment config
// the admin sets, read on every use, OpenAI's defaults for what it leaves
// out. Each feature then goes through the model gateway (models.ts) with
// Grasp's own key for its provider, which connect holds.

/**
 * Each platform feature's provider and model: the `PLATFORM_AI` var, the
 * defaults while none is set. One that doesn't parse is none at all:
 * `undefined`, and every platform feature is unavailable until it is
 * fixed, never on a provider nobody chose.
 */
export const platformAi = (
  env: Pick<Env, "PLATFORM_AI">
): PlatformAi | undefined => {
  const value = env.PLATFORM_AI === undefined ? {} : jsonVar(env.PLATFORM_AI);
  const settings = parsePlatformAi(value);
  if (settings === undefined) {
    log.error("platform_ai.invalid", {
      paths: (platformAiSchema.safeParse(value).error?.issues ?? [])
        .map(({ path }) => path.join("."))
        .join(" "),
    });
  }
  return settings;
};
