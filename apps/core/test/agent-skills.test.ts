import { skillCapabilitySchema } from "@grasp-os/brain/contract";
import { selectSkill } from "@grasp-os/brain/skills";
import { connectionIdSchema } from "@grasp-os/shared/ids";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { brainOf } from "../src/knowledge/ports.ts";
import { capabilitiesOf } from "../src/knowledge/skill-capabilities.ts";
import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection } from "./knowledge.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// Skills for a chat's code (`env.brain.skillsSelect` / `skillsRead`,
// GRA-310), through the chat, as its agent uses them. The ways they could
// fail, tried here at core's boundary (the Brain's own tests try every
// rule, packages/brain/test/skills.test.ts):
// - an agent without the brain permission, or without read of the skills'
//   collection, selects or reads a skill;
// - a skill is selected whose required capability the agent doesn't hold,
//   or isn't for one it holds by a grant of the calling chat's alone; a
//   capability core names can't be required at all;
// - retiring a skill leaves it selectable, or changes what a pinned read
//   returns; a pinned read outlives the agent's read of the collection;
// - a selection goes unrecorded, or its record carries a skill's text.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A `SKILL.md` named `name`, with `manifest` in its frontmatter. */
const skillText = (name: string, manifest: string): string =>
  `---\nname: ${name}\ndescription: Handles ${name}.\n${manifest}\n---\n\n# ${name}\n\nCheck the order first, then refund.\n`;

/** Code that returns what `call` answered, or the message it was refused with. */
const calling = (call: string) =>
  codeStep(
    `export default async (self, env) => { try { return await ${call}; } catch (error) { return error.message; } };`
  );

/** What a code step returned, as JSON, or its text when it isn't. */
const returned = (text: string | undefined): unknown => {
  const body = (text ?? "").replace(/^Returned:\n/u, "");
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return body;
  }
};

const skillRefSchema = z.object({ name: z.string(), version: z.number() });

/** A selection, as far as a test reads it. */
const selectionSchema = z.object({
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("skill"), skill: skillRefSchema }),
    z.object({ kind: z.literal("none"), reason: z.string() }),
  ]),
});

/** A pinned read, as far as a test reads it. */
const readSchema = z.object({ skill: skillRefSchema, text: z.string() });

/** A selection's result, as a test compares it: the skill's name and version, or why none; what it was otherwise. */
const resultOf = (value: unknown) => {
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success) {
    return value;
  }
  const { result } = parsed.data;
  return result.kind === "skill"
    ? { skill: result.skill.name, version: result.skill.version }
    : { none: result.reason };
};

describe("a chat's skills", setUpTime, () => {
  it("selects a skill only under the agent's grants, pins it, and reads that version after it is retired, until its read is revoked", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const knowledge: KnowledgeApi = admin.api.knowledge;
    const { id: collectionId } = await knowledge.createCollection({
      name: `Skills ${unique()}`,
      access: "everyone",
    });
    const refunds = await knowledge.saveDocument({
      collectionId,
      path: "refunds/SKILL.md",
      text: skillText("refunds", "tasks: [refund]"),
      ifVersion: 0,
    });
    await knowledge.saveDocument({
      collectionId,
      path: "payouts/SKILL.md",
      text: skillText(
        "payouts",
        "tasks: [payout]\nrequires: [connection:mail.send]"
      ),
      ifVersion: 0,
    });
    const select = (type: string) =>
      calling(`env.brain.skillsSelect({ task: { type: "${type}" } })`);
    const read = calling(
      `env.brain.skillsRead({ documentId: "${refunds.id}", version: 1 })`
    );
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      // Before any grant.
      select("refund"),
      says("No skills."),
      // Granted the brain and the collection.
      select("refund"),
      select("payout"),
      says("Selected."),
      // The skill retired since.
      select("refund"),
      read,
      says("Pinned."),
      // Its collection's read revoked.
      read,
      says("Gone.")
    );
    const ungranted = await newChat();
    await ungranted.ask("How do I refund?");

    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const collectionGrant = await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId)
    );
    const granted = await newChat();
    await granted.ask("How do I refund, and pay out?");

    await knowledge.saveDocument({
      collectionId,
      path: "refunds/SKILL.md",
      text: skillText("refunds", "tasks: [refund]\nstatus: retired"),
      ifVersion: 1,
    });
    const retired = await newChat();
    await retired.ask("And now?");

    await admin.api.permissions.revoke(collectionGrant);
    const revoked = await newChat();
    await revoked.ask("And now?");

    // Each turn under the brain grant recalls for its question first: the
    // last steps of each are this test's calls.
    const last = async (chatId: string, count: number) => {
      const results = await codeResults(stub, chatId);
      return results.slice(-count).map(({ text }) => returned(text));
    };
    const [before] = await last(ungranted.chat.id, 1);
    const [refund, payout] = await last(granted.chat.id, 2);
    const [afterRetiring, pinned] = await last(retired.chat.id, 2);
    const [afterRevoking] = await last(revoked.chat.id, 1);
    const pinnedRead = readSchema.parse(pinned);

    // Recorded by the Brain: what was selected, never the skill's text.
    const selections = await vi.waitFor(
      async () => {
        const all = await allEvents();
        const events = all.filter(
          ({ actor, action }) =>
            action === "knowledge.skill.select" &&
            actor.type === "agent" &&
            actor.agentId === agent.agentId
        );
        expect(events).toHaveLength(3);
        return events;
      },
      { timeout: 10_000, interval: 50 }
    );

    expect({
      before: typeof before === "string" && before.length > 0,
      refund: resultOf(refund),
      payout: resultOf(payout),
      afterRetiring: resultOf(afterRetiring),
      pinned: {
        version: pinnedRead.skill.version,
        retired: pinnedRead.text.includes("retired"),
      },
      afterRevoking,
      selections: selections.map(({ detail }) => ({
        result: detail.result,
        reason: detail.reason,
      })),
      texts: JSON.stringify(selections).includes("Check the order first"),
    }).toStrictEqual({
      before: true,
      refund: { skill: "refunds", version: 1 },
      payout: { none: "no_match" },
      afterRetiring: { none: "no_match" },
      pinned: { version: 1, retired: false },
      afterRevoking:
        "There's no such memory, source or receipt, or you can't see it.",
      selections: [
        { result: "skill", reason: null },
        { result: "none", reason: "no_match" },
        { result: "none", reason: "no_match" },
      ],
      texts: false,
    });
  });

  it("selects only skills in collections admins alone write: never a team's, which its members write", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const team = await newTeam(admin, [admin, member]);
    const { id: companyId } = await admin.api.knowledge.createCollection({
      name: `Company skills ${unique()}`,
      access: "everyone",
    });
    const { id: teamId } = await admin.api.knowledge.createCollection({
      name: `Team skills ${unique()}`,
      access: "teams",
      teams: [team],
    });
    await admin.api.knowledge.saveDocument({
      collectionId: companyId,
      path: "invoices/SKILL.md",
      text: skillText("invoices", "tasks: [invoice]"),
      ifVersion: 0,
    });
    // A member of the team writes their own, meant to take its place.
    await member.api.knowledge.saveDocument({
      collectionId: teamId,
      path: "invoices-fast/SKILL.md",
      text: skillText(
        "invoices-fast",
        "tasks: [invoice]\nreplaces: [invoices]\nstatus: accepted"
      ),
      ifVersion: 0,
    });
    const person = await member.api.whoami();

    const selection = await selectSkill(
      brainOf(env),
      { type: "person", person },
      { task: { type: "invoice" } }
    );

    expect({
      result: resultOf(selection),
      considered: selection.considered.map(({ skill, outcome }) => [
        skill.name,
        outcome,
      ]),
    }).toStrictEqual({
      result: { skill: "invoices", version: 1 },
      considered: [["invoices", "selected"]],
    });
  });

  it("counts a capability the agent holds by a grant of the calling chat alone, and only in that chat", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Skills ${unique()}`,
      access: "everyone",
    });
    await admin.api.knowledge.saveDocument({
      collectionId,
      path: "mailing/SKILL.md",
      text: skillText(
        "mailing",
        "tasks: [mail]\nrequires: [connection:MAIL_SEND]"
      ),
      ifVersion: 0,
    });
    const select = calling(
      `env.brain.skillsSelect({ task: { type: "mail" } })`
    );
    const { stub, agent, newChat } = await personalChatsOf(
      person.userId,
      select,
      says("In the granted chat."),
      select,
      says("In another.")
    );
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const granted = await newChat();
    // The person granted the agent their mail in this chat alone.
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_by, granted_at, chat_id) VALUES (?, 'agent', ?, 'connection', ?, '[\"MAIL_SEND\"]', 'MAIL', 'active', ?, ?, ?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        agent.agentId,
        crypto.randomUUID(),
        person.userId,
        Date.now(),
        person.userId,
        Date.now(),
        granted.chat.id
      )
      .run();
    await granted.ask("Send it.");
    const other = await newChat();
    await other.ask("Send it here.");

    const last = async (chatId: string) => {
      const results = await codeResults(stub, chatId);
      return returned(results.at(-1)?.text);
    };

    expect({
      granted: resultOf(await last(granted.chat.id)),
      other: resultOf(await last(other.chat.id)),
    }).toStrictEqual({
      granted: { skill: "mailing", version: 1 },
      other: { none: "no_match" },
    });
  });

  it("lets a manifest require every capability core names, at its longest", () => {
    const names = capabilitiesOf([
      {
        object: {
          type: "connection",
          connectionId: connectionIdSchema.parse("c".repeat(256)),
        },
        actions: [`A${"_".repeat(63)}`, "mail.send"],
      },
    ]);

    expect({
      count: names.length,
      rejected: names.filter(
        (name) => !skillCapabilitySchema.safeParse(name).success
      ),
    }).toStrictEqual({ count: 4, rejected: [] });
  });
});
