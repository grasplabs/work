import { createBrain } from "@grasp-os/brain/brain";
import { runLinking } from "@grasp-os/brain/entities";
import type { IndexStep } from "@grasp-os/brain/indexing";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { portsOf } from "../src/knowledge/ports.ts";
import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The Brain's entity and relation reads for a chat's code (GRA-306, the
// threat model of its second slice): read as the chat's agent acting for
// its person, through the same gate as a recall (the `brain` permission),
// only from collections the agent was granted that the person may read,
// listed by a name's start alone, and each relation with its passage. The
// model that extracted them is the one outside provider: faked.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const once: IndexStep = { do: async (_name, _config, fn) => await fn() };

/**
 * A handbook holding `text`, saved by `admin` and linked with `answer`, the
 * model's answer for it, as core's linking job does.
 */
const linkedHandbook = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  text: string,
  answer: unknown
): Promise<string> => {
  const { id: collectionId } = await admin.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  const saved = await admin.api.knowledge.saveDocument({
    collectionId,
    path: "owners.md",
    text,
    ifVersion: 0,
  });
  const brain = createBrain(env.KNOWLEDGE, {
    ...portsOf(env),
    extractEntities: async () => await Promise.resolve(answer),
  });
  await runLinking(brain, { source: `doc:${saved.id}`, version: 1 }, once);
  return collectionId;
};

/** A chat's code that lists `query`'s entities and reads the first's relations. */
const readRelations = (query: string) =>
  codeStep(
    `export default async (self, env) => { try { const [found] = await env.brain.entities({ query: ${JSON.stringify(query)} }); return await env.brain.relations({ entityId: found.id }); } catch (error) { return error.message; } };`
  );

/** A chat's code that lists every entity, naming no start. */
const listEverything = codeStep(
  "export default async (self, env) => { try { return await env.brain.entities({}); } catch (error) { return error.code ?? error.message; } };"
);

describe("a chat's entity and relation reads", setUpTime, () => {
  it("read what the chat's sources say, each with its passage, once the agent holds the brain permission", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const thing = `Onboarding ${unique()}`;
    const said = `Anna owns ${thing} from 2026-10-01.`;
    const collectionId = await linkedHandbook(admin, `# Owners\n${said}\n`, {
      entities: [
        { kind: "person", name: "Anna" },
        { kind: "process", name: thing },
      ],
      relations: [
        {
          subject: "Anna",
          predicate: "owns",
          object: thing,
          validFrom: "2026-10-01",
          evidence: said,
        },
      ],
    });
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      readRelations(thing),
      says("I can't read the brain."),
      readRelations(thing),
      says("Anna owns it."),
      listEverything,
      says("I need a name.")
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const before = await newChat();
    await before.ask("Who owns onboarding?");
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const after = await newChat();
    await after.ask("Who owns onboarding?");
    const listing = await newChat();
    await listing.ask("Who do you know?");

    const [refused] = await codeResults(stub, before.chat.id);
    const reads = await codeResults(stub, after.chat.id);
    const listings = await codeResults(stub, listing.chat.id);
    const relations: unknown = JSON.parse(
      (reads.at(-1)?.text ?? "").replace(/^Returned:\n/u, "")
    );

    expect({
      refused: refused?.text.includes("may not use that part of the Brain"),
      // No list of every name for a caller that isn't a person.
      listed: listings.at(-1)?.text,
    }).toStrictEqual({ refused: true, listed: "Returned:\nbrain.invalid" });
    expect(relations).toMatchObject([
      {
        subject: { name: "Anna" },
        predicate: "owns",
        object: { name: thing },
        validFrom: "2026-10-01",
        state: "observed",
        evidence: said,
        sourceRef: { kind: "document", collectionId },
      },
    ]);
  });
});
