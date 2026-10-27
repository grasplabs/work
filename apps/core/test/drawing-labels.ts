import { env } from "cloudflare:workers";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";

// The drawing's model knows people by neutral labels alone (`P2`), never
// their id (GRA-1084, src/onboarding/work-drawing.ts). The tests' fake
// drawings are written with people's ids, as the test knows them; this
// puts each id the label the prompt gave that person, found by what they
// agreed to, as a model reading the prompt would name them.

/** The marker the drawing's prompt lists people's facts after. */
const tellersMarker = "What each person who does it agreed to:";

/** Every string in a request's body. */
const stringsOf = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsOf);
  }
  return typeof value === "object" && value !== null
    ? Object.values(value).flatMap(stringsOf)
    : [];
};

/** Each label in a drawing's prompt, with the fact lines listed under it, sorted. */
const blocksOf = (prompt: string): Map<string, string> => {
  const blocks = new Map<string, string>();
  const [, listed = ""] = prompt.split(tellersMarker);
  for (const block of listed.split("\n## ").slice(1)) {
    const [heading = "", ...lines] = block.split("\n");
    const label = heading.split(",")[0]?.trim() ?? "";
    blocks.set(
      label,
      lines
        .filter((line) => line.startsWith("- "))
        .toSorted()
        .join("\n")
    );
  }
  return blocks;
};

/**
 * The label the prompt gave `person`, by what they agreed to, of those not
 * `taken` (people who agreed to the same are told apart by order alone);
 * none when it gave them none.
 */
const labelOf = async (
  blocks: ReadonlyMap<string, string>,
  person: string,
  taken: ReadonlySet<string>
): Promise<string | undefined> => {
  const input = await onboardingStore(env).drawInput(person);
  if (input === null) {
    return undefined;
  }
  const lines = input.facts
    .map(({ tag, record }) => `- (${tag}) ${record}`)
    .toSorted()
    .join("\n");
  return [...blocks].find(
    ([label, listed]) => listed === lines && !taken.has(label)
  )?.[0];
};

/** The people a drawing's answer names: in its `…by` lists and its numbers' `person`. */
const peopleIn = (value: unknown, key = ""): string[] => {
  if (typeof value === "string") {
    return key === "person" || key.endsWith("by") ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((each) => peopleIn(each, key));
  }
  return typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([name, each]) => peopleIn(each, name))
    : [];
};

/**
 * `reply`, when it answers a drawing's prompt, with every id of someone
 * the prompt lists put as the label it gave them; any other reply as it is.
 */
export const relabelled = async (
  reply: GatewayReply | undefined,
  body: unknown
): Promise<GatewayReply | undefined> => {
  if (reply === undefined || !("text" in reply)) {
    return reply;
  }
  const prompt = stringsOf(body).find((text) => text.includes(tellersMarker));
  if (prompt === undefined) {
    return reply;
  }
  const blocks = blocksOf(prompt);
  const ids = peopleIn(JSON.parse(reply.text));
  let { text } = reply;
  const taken = new Set<string>();
  for (const id of new Set(ids)) {
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    const label = await labelOf(blocks, id, taken);
    if (label !== undefined) {
      taken.add(label);
      text = text.replaceAll(`"${id}"`, `"${label}"`);
    }
  }
  return { ...reply, text };
};
