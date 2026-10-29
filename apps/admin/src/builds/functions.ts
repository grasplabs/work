/**
 * The integration builds' server functions, behind the Access check every
 * request passes (src/access.ts). Restarting and closing a build that
 * stopped for a person act as the verified staff member the request comes
 * from, audited, and answer a refusal as its code (`BuildErrorCode`),
 * which the page words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import {
  BuildError,
  buildAgentAvailable,
  closeBuild,
  restartBuild,
  stoppedBuilds,
} from "./builds.ts";
import type { BuildErrorCode } from "./builds.ts";

/** What restarting or closing a build answers: done, or why it was refused. */
export interface BuildActionResult {
  refused: BuildErrorCode | null;
}

/** Runs `task`, a refusal as its code. */
const refusable = async (
  task: () => Promise<unknown>
): Promise<BuildActionResult> => {
  try {
    await task();
    return { refused: null };
  } catch (error) {
    if (error instanceof BuildError) {
      return { refused: error.code };
    }
    throw error;
  }
};

const appSchema = z.object({ app: z.string().min(1) });

/** Every build that stopped for a person, for the Integrations page. */
export const fetchStoppedBuilds = createServerFn({ method: "GET" }).handler(
  async () => await stoppedBuilds(adminDatabase(env.DB))
);

/**
 * Starts a stopped build again. Refused (`agent_unavailable`) while
 * Grasp's build agent doesn't exist: its run would wait a day for a plan
 * nobody writes, then stop again.
 */
export const restartBuildFn = createServerFn({ method: "POST" })
  .validator(appSchema)
  .handler(
    async ({ data, context }): Promise<BuildActionResult> =>
      await refusable(async () => {
        if (!buildAgentAvailable) {
          throw new BuildError(
            "agent_unavailable",
            "Grasp's build agent doesn't exist yet"
          );
        }
        await restartBuild(env, context.staff, data.app);
      })
  );

/** Closes a stopped build, so its app shows as asked for again. */
export const closeBuildFn = createServerFn({ method: "POST" })
  .validator(appSchema)
  .handler(
    async ({ data, context }): Promise<BuildActionResult> =>
      await refusable(async () => {
        await closeBuild(env, context.staff, data.app);
      })
  );
