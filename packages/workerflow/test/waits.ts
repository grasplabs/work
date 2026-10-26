// What the wait tests (waits*.test.ts, inboxes.test.ts) share.
import type { InstanceEvent } from "../src/instance.ts";
import { workflow } from "./helpers.ts";
import { effectsOf } from "./outside.ts";

/** Far enough ahead that no alarm the test holds back fires on its own. */
export const heldBackMs = 60 * 60 * 1000;

export const instance = async (definition: string, id: string) =>
  await workflow(definition).get(id);

export const send = async (
  definition: string,
  id: string,
  event: InstanceEvent
): Promise<void> => {
  const run = await instance(definition, id);
  await run.sendEvent(event);
};

export const statusOf = async (definition: string, id: string) => {
  const run = await instance(definition, id);
  return await run.status();
};

export const labels = (id: string): string[] =>
  effectsOf(id).map((effect) => effect.label);

/** What the definition's own code did outside any step. */
export const witnessed = (id: string): string[] =>
  effectsOf(id)
    .filter((effect) => effect.attempt === 0)
    .map((effect) => effect.label);
