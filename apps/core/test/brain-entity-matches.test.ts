import { runLinking, sourceKey } from "@grasp-os/brain/entities";
import type {
  EntityMatch,
  EntityMatchDecisionInput,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainOf } from "../src/knowledge/ports.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Entity matches across collections in core (GRA-1080): proposals and
// decisions over the RPC, as the signed-in person. Nothing links a
// source's entities in the background any more: each case links its
// documents as that job left them, through the Brain's own linking with
// an extractor that names what the text does. How it can
// fail, tried here at core's boundary (the Brain's own tests try every
// rule, packages/brain/test/entities.test.ts):
// - a member learns that a collection they can't read holds a name they
//   know (the probe #1203 closed), from a proposal or a refusal;
// - a decision is made by someone who can't read both sides, or without
//   evidence, or goes unaudited;
// - someone who reads both sides replaces another's decision without
//   being an admin.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/**
 * Links document `documentId`'s version 1 as the removed linking job did,
 * with an extractor that names `name` wherever the text does.
 */
const linked = async (documentId: string, name: string): Promise<void> => {
  const brain = brainOf(env);
  await runLinking(
    {
      ...brain,
      ports: {
        ...brain.ports,
        extractEntities: async (text) =>
          await Promise.resolve({
            entities: text.includes(name) ? [{ kind: "person", name }] : [],
          }),
      },
    },
    { source: sourceKey({ kind: "document", id: documentId }), version: 1 },
    { do: async (_name, _config, run) => await run() }
  );
};

describe("entity matches for the signed-in person", setUpTime, () => {
  it("proposes a match only to a person who reads both collections, and lets only them decide it, audited", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    // Reads both sides, but neither decided nor an admin.
    const colleague = await signedInApi(idp, "user");
    const name = `Rosa ${unique()}`;
    const { id: open } = await admin.api.knowledge.createCollection({
      name: `Sales ${unique()}`,
      access: "everyone",
    });
    // A team's the member isn't in: hidden from them.
    const board = await newTeam(admin, [admin, colleague]);
    const { id: hidden } = await admin.api.knowledge.createCollection({
      name: `Board ${unique()}`,
      access: "teams",
      teams: [board],
    });
    for (const [collectionId, text] of [
      [open, `# Calls\n${name} called about the order.`],
      [hidden, `# Notes\n${name} joins the board.`],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      const saved = await admin.api.knowledge.saveDocument({
        collectionId,
        path: "note.md",
        text,
        ifVersion: 0,
      });
      // oxlint-disable-next-line no-await-in-loop -- one link at a time
      await linked(saved.id, name);
    }
    const proof = await admin.api.knowledge.saveDocument({
      collectionId: hidden,
      path: "proof.md",
      text: "# Proof\nBoth notes are about one person.",
      ifVersion: 0,
    });
    const adminBrain: KnowledgeApi = admin.api.knowledge;
    const memberBrain: KnowledgeApi = member.api.knowledge;
    const hers = (matches: EntityMatch[]) =>
      matches.filter((match) => match.name === name);
    const [proposed] = hers(await adminBrain.entityMatches());
    if (proposed === undefined) {
      throw new Error("No match was proposed");
    }
    const [first = "", second = ""] = proposed.entities.map(({ id }) => id);
    const decision: EntityMatchDecisionInput = {
      entities: [first, second],
      decision: "same",
      evidence: { documentId: proof.id, version: 1 },
    };
    const byMember = await outcome(memberBrain.decideEntityMatch(decision));
    const memberSees = hers(await memberBrain.entityMatches());
    const decided = await adminBrain.decideEntityMatch(decision);
    const byColleague = await outcome(
      colleague.api.knowledge.decideEntityMatch({
        entities: [first, second],
        decision: "different",
      })
    );
    const events = await allEvents();

    expect({
      sides: proposed.entities
        .flatMap(({ collectionIds }) => collectionIds)
        .toSorted(),
      memberSees,
      byMember,
      decided: decided.decision,
      byColleague,
      left: hers(await adminBrain.entityMatches()),
      audited: events.filter(
        ({ action, target }) =>
          action === "brain.entity_match.decided" &&
          target?.id === [first, second].toSorted().join(":")
      ).length,
    }).toStrictEqual({
      sides: [open, hidden].toSorted(),
      // The board's Rosa is no side of anything the member sees, and
      // deciding on her is refused as for an entity that isn't there.
      memberSees: [],
      byMember: "brain.not_found",
      decided: "same",
      // Only the decider or an admin replaces a decision.
      byColleague: "brain.denied",
      left: [],
      audited: 1,
    });
  });
});
