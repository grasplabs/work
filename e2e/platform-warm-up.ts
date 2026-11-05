import { setTimeout as sleep } from "node:timers/promises";

import { modelScripts } from "./model-scripts.ts";
import { apiOf } from "./people.ts";
import type { Person } from "./people.ts";
import { e2eModel } from "./stack.ts";

// The stack's platform code (the compiler, the type checker and Ultracite's
// lint and format) runs in core's own process, where plain workerd runs
// every request on one thread (`SANDBOX_IN_PROCESS=unbounded`,
// apps/core/src/sandboxed.ts). The first write of an App loads each of
// them into an isolate of its own, which holds every other request of the
// stack for as long: about 2 s on a laptop, over 6 s on a CI runner. A test
// that reads a page meanwhile, its own or another worker's, gets no answer
// within the page's deadline (apps/web/src/core.ts) and shows Grasp as out
// of reach. A running deployment has them loaded, or builds elsewhere (on
// Cloudflare and on the on-prem sandbox host), so the stack loads them
// once, before any test, as an App's own chat writes an App. Warm, a write
// holds the stack for a fraction of a second.

/** How long the warm-up's turn may take: its write's cold builds, and more. */
const turnMs = 60_000;

/** How often the warm-up reads whether its turn ended. */
const pollMs = 250;

/**
 * Loads the stack's platform code before any test, as `builder` has a new
 * App's own chat write a tally (`modelScripts.buildsTally`'s first turn).
 * Fails when the turn doesn't end in time or wrote nothing, as then
 * nothing was loaded.
 */
export const warmPlatform = async (builder: Person): Promise<void> => {
  const { core, api } = apiOf(builder);
  try {
    const chat = await api.chats.newApp({
      name: `Platform warm-up ${crypto.randomUUID().slice(0, 8)}`,
      description: "Loads the platform's code before the tests.",
    });
    await api.chats.send(chat.id, {
      text: modelScripts.buildsTally.opener,
      model: e2eModel,
    });
    const until = Date.now() + turnMs;
    let { running } = await api.chats.summary(chat.id);
    while (running) {
      if (Date.now() > until) {
        throw new Error(
          `The platform's warm-up turn in chat ${chat.id} didn't end within ${turnMs} ms`
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- until the turn ends
      await sleep(pollMs);
      // oxlint-disable-next-line no-await-in-loop -- until the turn ends
      ({ running } = await api.chats.summary(chat.id));
    }
    const drafts = await api.chats.drafts(chat.id);
    if (!drafts.some(({ changed }) => changed.length > 0)) {
      throw new Error(
        `The platform's warm-up turn in chat ${chat.id} wrote no App files, so it loaded nothing`
      );
    }
  } finally {
    core[Symbol.dispose]();
  }
};
