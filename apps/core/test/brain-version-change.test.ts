// What a version of a source changed, as the Sources page reads it
// (`session.brainSources.learned`, brain-next.ts `versionChangeAs`), for a
// source only its owner may read: kept in their own store, read from there
// for them alone, its memories and entities named as their own store's, so
// the page's links open them there. The threat model is on GRA-1991.
import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addSource } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { BrainSourcesRpc } from "../src/brain-sources-rpc.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { person } from "./sealed-apps.ts";

/** The Sources page's calls, signed in as `identity`. */
const sourcesAs = (identity: Awaited<ReturnType<typeof person>>) =>
  new BrainSourcesRpc(env, async () => await Promise.resolve(identity));

describe("what a person's own source's version changed", () => {
  it("reads it from their own store for them, naming its memories and entities as their own store's, and gives a colleague none", async () => {
    const owner = await person("user");
    const colleague = await person("user");
    const source: SourceRef = { producer: "capture", id: crypto.randomUUID() };
    const text = "Acme is Active. Acme renews in March.";
    await addSource(env, {
      source,
      change: crypto.randomUUID(),
      text,
      readers: { kind: "owner", personId: owner.userId },
    });
    // What extraction would draw from it, in their own store, theirs alone.
    await personalBrainOf(
      inJurisdiction(env, env.BRAIN_STORE),
      owner.userId
    ).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "owner", person: owner.userId },
      entities: [{ key: "c", kind: "customer", names: ["Acme"] }],
      memories: [
        {
          about: "c",
          type: "fact",
          attribute: "status",
          value: "Active",
          statement: "Acme is active",
          speaker: { kind: "system" },
          basis: {
            kind: "source",
            source: `${source.producer}:${source.id}`,
            version: 1,
            quote: "Acme is Active",
          },
        },
      ],
    });

    const learned = await sourcesAs(owner).learned(source, 1);
    expect({
      memories: learned?.memories.map(({ part, memory }) => ({
        part,
        store: memory.store,
        statement: memory.statement,
        source: memory.source,
      })),
      entities: learned?.entities.map(({ entity, name, firstSeen }) => ({
        store: entity.store,
        name,
        firstSeen,
      })),
      next: learned?.next,
    }).toStrictEqual({
      memories: [
        {
          part: "added",
          store: "own",
          statement: "Acme is active",
          source: { source, version: 1 },
        },
      ],
      entities: [{ store: "own", name: "Acme", firstSeen: true }],
      next: null,
    });
    await expect(sourcesAs(colleague).learned(source, 1)).resolves.toBeNull();
  });
});
