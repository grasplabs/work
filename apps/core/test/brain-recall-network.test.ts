import { createBrain } from "@grasp-os/brain/brain";
import { runLinking } from "@grasp-os/brain/entities";
import type { IndexStep } from "@grasp-os/brain/indexing";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { portsOf } from "../src/knowledge/ports.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// A recall's network route through core (GRA-307): a person's recall, as
// Knowledge's RPC takes it, follows what its evidence names along the
// relations core's linking stored, under core's access predicate.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const once: IndexStep = { do: async (_name, _config, fn) => await fn() };

/** A relation as the faked model states it, by its passage. */
const stated = (subject: string, predicate: string, object: string) => ({
  subject,
  predicate,
  object,
  evidence: `${subject} ${predicate} ${object}.`,
});

describe("a person's recall through core", setUpTime, () => {
  it("follows its evidence along stored relations into another document they may read, with the path", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = `zq${unique()}`;
    const thing = `Onboarding ${unique()}`;
    const tool = `Personio ${unique()}`;
    const owns = stated("Anna", "owns", thing);
    const uses = stated(thing, "uses", tool);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const brain = createBrain(env.KNOWLEDGE, {
      ...portsOf(env),
      extractEntities: async (text: string) =>
        await Promise.resolve(
          text.includes(owns.evidence)
            ? {
                entities: [
                  { kind: "person", name: "Anna" },
                  { kind: "process", name: thing },
                ],
                relations: [owns],
              }
            : {
                entities: [
                  { kind: "process", name: thing },
                  { kind: "tool", name: tool },
                ],
                relations: [uses],
              }
        ),
    });
    for (const [path, text] of [
      ["team.md", `# Team\n${word}: ${owns.evidence}`],
      ["stack.md", `# Stack\n${uses.evidence}`],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each saved, then linked
      const saved = await admin.api.knowledge.saveDocument({
        collectionId,
        path,
        text,
        ifVersion: 0,
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await runLinking(brain, { source: `doc:${saved.id}`, version: 1 }, once);
    }

    const pack = await admin.api.knowledge.recall({
      query: word,
      network: { hops: 1 },
    });

    expect({
      policy: pack.retrievalPolicyVersion,
      routes: pack.coverage.queriedRoutes,
      added: pack.items.slice(1).map(({ statement }) => statement),
      paths: pack.network?.paths.map(({ seed, steps }) => [
        seed.name,
        ...steps.map(({ kind, predicate, sourceRef }) => [
          kind,
          predicate,
          sourceRef.kind === "document" ? sourceRef.collectionId : null,
        ]),
      ]),
    }).toStrictEqual({
      policy: "fulltext@3+traversal@1",
      routes: ["fulltext", "network"],
      added: [uses.evidence],
      paths: [[thing, ["typed_assertion", "uses", collectionId]]],
    });
  });
});
