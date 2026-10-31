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
// out; set but broken, every feature is off (fail closed). Each feature then goes through the model gateway (models.ts) with
// Grasp's own key for its provider, which connect holds.

/**
 * Each platform feature's provider and model: the `PLATFORM_AI` var, the
 * defaults while none is set. One that is set but isn't JSON, or doesn't
 * parse, is none at all: `undefined`, and every platform feature is
 * unavailable until it is fixed, never on a provider nobody chose. The
 * admin checks it before it deploys; core refuses it all the same.
 */
export const platformAi = (
  env: Pick<Env, "PLATFORM_AI">
): PlatformAi | undefined => {
  if (env.PLATFORM_AI === undefined) {
    return parsePlatformAi({});
  }
  const value = jsonVar(env.PLATFORM_AI);
  if (value === undefined) {
    log.error("platform_ai.invalid", { reason: "not_json" });
    return undefined;
  }
  const settings = parsePlatformAi(value);
  if (settings === undefined) {
    log.error("platform_ai.invalid", {
      reason: "schema",
      paths: (platformAiSchema.safeParse(value).error?.issues ?? [])
        .map(({ path }) => path.join("."))
        .join(" "),
    });
  }
  return settings;
};
