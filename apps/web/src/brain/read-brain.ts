import type { Workspace } from "@grasp-os/shared/brain";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

/**
 * What the brain is built from (`buildBrain`), as core assembles it for
 * the signed-in person (`brain.read`): the onboarding for an admin and
 * the connections. Built into notes by the brain's layout as it loads
 * (routes/_shell.brain.tsx), in the person's language. Not sent once the
 * page was `left`.
 */
export const readBrain = async (
  core: Pick<CoreConnection, "withSession">,
  left?: AbortSignal
): Promise<Loaded<Workspace>> =>
  await loadFromCore(core, async (session) => await session.brain.read(), left);
