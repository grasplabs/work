// What the entity and recall tests share: the store, unique names and
// words, readers, and adding memories.
import type {
  Access,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";

import type { BrainStore } from "../src/store.ts";

export type Store = DurableObjectStub<BrainStore>;

export const shared = (): Store => env.BRAIN_STORE.getByName("brain");

export const unique = (name: string): string =>
  `${name}-${crypto.randomUUID()}`;

/** A word no other test holds: letters only, so it is one word. */
export const word = (): string =>
  `w${crypto.randomUUID().replaceAll("-", "").replaceAll(/\d/gu, "")}`.slice(
    0,
    14
  );

export const readerOf = (person: string, ...groups: string[]): Reader => ({
  person,
  groups,
});
export const audience = (group: string): Access => ({
  kind: "audience",
  group,
});

/** A memory about `about`, a system fact written by `writer`. */
export const fact = (
  about: string,
  statement: string,
  extra: Partial<NewMemory> = {},
  writer = "writer"
): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "system" },
  basis: { kind: "writer", writer },
  ...extra,
});

/** Adds `memories` about `entities`, readable as `access` says. */
export const remember = async (
  access: Access,
  entities: NewEntity[],
  memories: NewMemory[],
  reader?: Reader
) =>
  await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities,
    memories,
    ...(reader === undefined ? {} : { reader }),
  });
