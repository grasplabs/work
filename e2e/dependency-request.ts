import { setTimeout as sleep } from "node:timers/promises";

/**
 * A chat whose agent asked for an App's npm packages, for the e2e stack.
 */
import { modelScripts } from "./model-scripts.ts";
import type { apiOf } from "./people.ts";
import { e2eModel } from "./stack.ts";

/** How long the chat's turn may take. */
const turnMs = 30_000;

/** How often the turn's end is read. */
const pollMs = 250;

/**
 * A chat named `title` whose agent asked for packages
 * (`modelScripts.asksPackages`), once its turn ended: where the request
 * it left waits, as a request is only ever asked for in a turn.
 */
export const chatAskingForPackages = async (
  api: ReturnType<typeof apiOf>["api"],
  title: string
): Promise<{ id: string }> => {
  const chat = await api.chats.create(title);
  await api.chats.send(chat.id, {
    text: modelScripts.asksPackages.opener,
    model: e2eModel,
  });
  const until = Date.now() + turnMs;
  let { running } = await api.chats.summary(chat.id);
  while (running) {
    if (Date.now() > until) {
      throw new Error(`The turn in chat ${chat.id} didn't end in time`);
    }
    // oxlint-disable-next-line no-await-in-loop -- until the turn ends
    await sleep(pollMs);
    // oxlint-disable-next-line no-await-in-loop -- until the turn ends
    ({ running } = await api.chats.summary(chat.id));
  }
  return { id: chat.id };
};
