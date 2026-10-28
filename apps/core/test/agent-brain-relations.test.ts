import { createBrain } from "@grasp-os/brain/brain";
import { runLinking } from "@grasp-os/brain/entities";
import type { IndexStep } from "@grasp-os/brain/indexing";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { portsOf } from "../src/knowledge/ports.ts";
import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection } from "./knowledge.ts";
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
  answer: unknown,
  teams?: string[]
): Promise<string> => {
  const { id: collectionId } = await admin.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    ...(teams === undefined
      ? { access: "everyone" as const }
      : { access: "teams" as const, teams }),
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

/** A chat's code that explains how `query`'s first entity connects, as names. */
const explainRelations = (query: string) =>
  codeStep(
    `export default async (self, env) => { const [found] = await env.brain.entities({ query: ${JSON.stringify(query)} }); const { paths, truncated } = await env.brain.relationsExplain({ entityId: found.id }); return { paths: paths.map(({ relations, to }) => [...relations.map(({ evidence }) => evidence), to.name]), truncated }; };`
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
    expect(relations).toMatchObject({
      relations: [
        {
          subject: { name: "Anna" },
          predicate: "owns",
          object: { name: thing },
          validFrom: "2026-10-01",
          state: "observed",
          evidence: said,
          sourceRef: { kind: "document", collectionId },
        },
      ],
      truncated: false,
    });
  });

  it("explain how an entity connects, two relations out, each with its passage", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const thing = `Onboarding ${unique()}`;
    const owns = `Anna owns ${thing}.`;
    const uses = `${thing} uses Personio.`;
    const collectionId = await linkedHandbook(admin, `${owns}\n${uses}\n`, {
      entities: [
        { kind: "person", name: "Anna" },
        { kind: "process", name: thing },
        { kind: "tool", name: "Personio" },
      ],
      relations: [
        { subject: "Anna", predicate: "owns", object: thing, evidence: owns },
        {
          subject: thing,
          predicate: "uses",
          object: "Personio",
          evidence: uses,
        },
      ],
    });
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      explainRelations("Anna"),
      says("Anna owns onboarding, which uses Personio.")
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const chat = await newChat();
    await chat.ask("What does Anna touch?");

    // Its last: before it, the turn's own recall for the question.
    const results = await codeResults(stub, chat.chat.id);
    const explained = results.at(-1);

    expect(
      JSON.parse((explained?.text ?? "").replace(/^Returned:\n/u, ""))
    ).toStrictEqual({
      paths: [
        [owns, thing],
        [owns, uses, "Personio"],
      ],
      truncated: false,
    });
  });

  it("answer a person only from what they may read: a team's relation is none of another member's", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const team = await newTeam(admin, [admin]);
    const thing = `Payroll ${unique()}`;
    const said = `Bram owns ${thing}.`;
    await linkedHandbook(
      admin,
      said,
      {
        entities: [
          { kind: "person", name: "Bram" },
          { kind: "process", name: thing },
        ],
        relations: [
          { subject: "Bram", predicate: "owns", object: thing, evidence: said },
        ],
      },
      [team]
    );
    const [found] = await admin.api.knowledge.entities({ query: thing });
    const entityId = found?.id ?? "-";
    const forAdmin = await admin.api.knowledge.relations({ entityId });
    const forMember = await member.api.knowledge.relations({ entityId });
    const memberSees = await member.api.knowledge.entities({ query: thing });

    expect({
      admin: forAdmin.relations.map(({ subject, evidence }) => [
        subject.name,
        evidence,
      ]),
      member: forMember.relations,
      memberSees,
    }).toStrictEqual({
      admin: [["Bram", said]],
      member: [],
      memberSees: [],
    });
  });
});
