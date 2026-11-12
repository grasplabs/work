import { brainOf } from "@grasp-os/brain-next/contract";
import {
  authoritySchema,
  workContextSchema,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  correctFor,
  entityFor,
  findEntitiesFor,
  forgetFor,
  rememberFor,
} from "../src/brain-memories.ts";
import type { MemoryCaller } from "../src/brain-memories.ts";
import {
  correctAs,
  entityAs,
  findEntitiesAs,
  forgetAs,
  rememberAs,
} from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { mockIdp } from "./idp.ts";
import { eventsOf } from "./model-rules.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// A person's memories through core (GRA-1743, threat model on the
// issue): what is saved for a person is theirs alone, in their own
// store, whatever their chat or run read; the same writer's new word on
// the same attribute replaces their earlier one; forgetting retires only
// the caller's own; correcting confirms, and a fix outranks what it
// corrects; only a person's own chat reads their own store; and every
// call is audited with ids and counts only.

const idp = mockIdp();

/** A member of the organization, signed in. */
const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** A team with `members` in it, as core names it to the Brain. */
const teamOf = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId: id,
      userId,
      createdAt: new Date(),
    });
  }
  return id;
};

/** A customer named `name`, which no other test names. */
const customer = (name: string) => ({
  kind: "customer" as const,
  names: [name],
});

/** A memory of the person's own word about a customer's status. */
const status = (name: string, value: string) => ({
  change: crypto.randomUUID(),
  about: customer(name),
  attribute: "status",
  value,
  type: "fact" as const,
  statement: `${name} is ${value}`,
});

const own = { kind: "own" } as const;
const personal = { personal: true };
const shared = { personal: false };

/** The ids of `found`, in order. */
const idsOf = (found: readonly { id: string }[]) => found.map(({ id }) => id);

/** The person themselves, as a caller of brain-memories.ts. */
const themselves = (personId: string): MemoryCaller => ({
  person: personId,
  actor: { type: "person", userId: personId },
  word: own,
  personal: true,
});

describe("a person's memories", () => {
  it("keeps what is saved for a person readable by them alone, wherever they read it from", async () => {
    const [anna, ben] = await Promise.all([person(), person()]);
    await teamOf(anna, ben);
    const name = `Acme ${unique()}`;
    const { memory, entity } = await rememberAs(env, anna, own, {
      ...status(name, "Renewing"),
    });
    const [card, teammate, code] = await Promise.all([
      entityAs(env, anna, entity, personal),
      // Her teammate never sees it, by id or by name; nor does code acting
      // for her outside her own chat.
      Promise.all([
        entityAs(env, ben, entity, personal),
        findEntitiesAs(env, ben, { name }, personal),
      ]),
      Promise.all([
        entityAs(env, anna, entity, shared),
        findEntitiesAs(env, anna, { name }, shared),
      ]),
    ]);
    const found = await findEntitiesAs(env, anna, { name }, personal);
    expect({
      names: card?.entity.names,
      memories: card?.memories.map(({ id, writer, speaker }) => ({
        id,
        writer,
        speaker,
      })),
      found: idsOf(found),
      teammate,
      code,
    }).toStrictEqual({
      names: [name],
      memories: [
        {
          id: memory,
          writer: anna,
          speaker: { kind: "internal", person: anna },
        },
      ],
      found: [entity],
      teammate: [null, []],
      code: [null, []],
    });
  });

  it("saves the same change once, and replaces the same writer's earlier word on an attribute", async () => {
    const anna = await person();
    const name = `Acme ${unique()}`;
    const first = status(name, "Renewing");
    const saved = await rememberAs(env, anna, own, first);
    await expect(rememberAs(env, anna, own, first)).resolves.toStrictEqual(
      saved
    );
    const newer = await rememberAs(env, anna, own, {
      ...status(name, "Churned"),
      about: { id: saved.entity, kind: "customer" },
    });
    const card = await entityAs(env, anna, saved.entity, personal);
    expect(
      card?.memories.map(({ id, value }) => ({ id, value }))
    ).toStrictEqual([{ id: newer.memory, value: "Churned" }]);
  });

  it("takes a preference only as the person's own word", async () => {
    const anna = await person();
    const preference = {
      change: crypto.randomUUID(),
      about: { kind: "person" as const, names: ["Anna"] },
      attribute: "preference",
      value: "Short answers",
      type: "preference" as const,
      statement: "Anna wants short answers",
    };
    await expect(
      rememberAs(
        env,
        anna,
        { kind: "agent", agent: `app:${crypto.randomUUID()}` },
        preference
      )
    ).rejects.toThrow(/instruction or preference/u);
    const { memory } = await rememberAs(env, anna, own, preference);
    expect(memory).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("forgets only the caller's own memory, which stays out of what is current", async () => {
    const [anna, ben] = await Promise.all([person(), person()]);
    const saved = await rememberAs(env, anna, own, {
      ...status(`Acme ${unique()}`, "Renewing"),
    });
    const forget = async (personId: string, agent?: string) =>
      await forgetAs(env, personId, {
        memory: saved.memory,
        word: agent === undefined ? own : { kind: "agent", agent },
      });
    const current = async () => {
      const card = await entityAs(env, anna, saved.entity, personal);
      return card?.memories.length;
    };
    const byOthers = [
      await forget(ben),
      await forget(anna, `app:${crypto.randomUUID()}`),
    ];
    const before = await current();
    const byHer = [await forget(anna), await forget(anna)];
    expect({ byOthers, before, byHer, after: await current() }).toStrictEqual({
      byOthers: ["nothing", "nothing"],
      before: 1,
      // A retried forget never reads as not found.
      byHer: ["done", "done"],
      after: 0,
    });
  });

  it("puts a person's fix before what an App wrote for them, as confirmed by them", async () => {
    const anna = await person();
    const app = `app:${crypto.randomUUID()}`;
    const written = await rememberAs(
      env,
      anna,
      { kind: "agent", agent: app },
      {
        ...status(`Acme ${unique()}`, "Renewing"),
      }
    );
    const fix = {
      memory: written.memory,
      entity: written.entity,
      fix: {
        change: crypto.randomUUID(),
        statement: "Acme has churned",
        value: "Churned",
      },
    };
    // Code outside her own chat may not file a fix where only she reads.
    await expect(correctAs(env, anna, fix, shared)).resolves.toBeNull();
    const fixed = await correctAs(env, anna, fix, personal);
    expect(fixed).not.toBeNull();
    const card = await entityAs(env, anna, written.entity, personal);
    expect(
      card?.memories.map(({ id, value, writer, confirmed, contested }) => ({
        id,
        value,
        writer,
        by: confirmed?.by ?? null,
        contested,
      }))
    ).toStrictEqual([
      { id: fixed, value: "Churned", writer: anna, by: anna, contested: true },
      {
        id: written.memory,
        value: "Renewing",
        writer: app,
        by: null,
        contested: true,
      },
    ]);
  });

  it("confirms a shared memory only for someone who may read it", async () => {
    const [anna, ben] = await Promise.all([person(), person()]);
    const team = await teamOf(anna);
    const added = await brainOf(
      inJurisdiction(env, env.BRAIN_STORE)
    ).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: `team:${team}` },
      entities: [{ key: "c", kind: "customer", names: [`Acme ${unique()}`] }],
      memories: [
        {
          about: "c",
          attribute: "status",
          value: "Renewing",
          type: "fact",
          statement: "Acme is renewing",
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: `app:${crypto.randomUUID()}` },
        },
      ],
    });
    const memory = added.memories[0] ?? "";
    const entity = added.entities.c ?? "";
    await expect(
      correctAs(env, ben, { memory, entity }, personal)
    ).resolves.toBeNull();
    await expect(
      correctAs(env, anna, { memory, entity }, shared)
    ).resolves.toBe(memory);
    const card = await entityAs(env, anna, entity, shared);
    expect(card?.memories[0]?.confirmed?.by).toBe(anna);
    // A fix of a shared memory waits for the store to file it under that
    // memory's readers: nothing is saved.
    await expect(
      correctAs(
        env,
        anna,
        {
          memory,
          entity,
          fix: {
            change: crypto.randomUUID(),
            statement: "Churned",
            value: "Churned",
          },
        },
        personal
      )
    ).resolves.toBeNull();
  });

  it("refuses someone who is no longer a member", async () => {
    await expect(
      rememberAs(env, `gone-${crypto.randomUUID()}`, own, {
        ...status("Acme", "Renewing"),
      })
    ).rejects.toMatchObject({ code: "permission.person_inactive" });
  });
});

describe("a person's memories, for a caller", () => {
  it("audits each call with ids and counts, never what a memory says", async () => {
    const anna = await person();
    const caller = themselves(anna);
    const name = `Secretname ${unique()}`;
    const saved = await rememberFor(env, caller, status(name, "Renewing"));
    await entityFor(env, caller, saved.entity);
    await findEntitiesFor(env, caller, { name });
    await correctFor(env, caller, {
      memory: saved.memory,
      entity: saved.entity,
    });
    await expect(forgetFor(env, caller, saved.memory)).resolves.toBe("done");
    const events = await eventsOf(caller.actor);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "brain.memory.remembered",
      "brain.entity.read",
      "brain.entity.read",
      "brain.memory.corrected",
      "brain.memory.forgotten",
    ]);
    expect(events.map(({ detail }) => detail)).toStrictEqual([
      { onBehalfOf: anna, memory: saved.memory, entity: saved.entity },
      { onBehalfOf: anna, entities: 1, memories: 1 },
      { onBehalfOf: anna, entities: 1 },
      { onBehalfOf: anna, memory: saved.memory, fixed: false },
      { onBehalfOf: anna, memory: saved.memory, outcome: "done" },
    ]);
    expect(JSON.stringify(events)).not.toContain("Secretname");
  });

  it("refuses, and audits, a write in an agent's word and a read by code without the grant", async () => {
    const anna = await person();
    const agentId = `agent-${crypto.randomUUID()}`;
    const actor = { type: "agent", agentId, onBehalfOf: anna } as const;
    const code: MemoryCaller = {
      person: anna,
      actor,
      word: { kind: "agent", agent: `app:${crypto.randomUUID()}` },
      personal: false,
      code: {
        authority: authoritySchema.parse({
          subject: { type: "agent", agentId },
          onBehalfOf: anna,
          mode: "interactive",
        }),
        context: workContextSchema.parse({
          type: "app",
          appId: crypto.randomUUID(),
        }),
        permissionId: null,
      },
    };
    await expect(
      rememberFor(env, code, status(`Acme ${unique()}`, "Renewing"))
    ).rejects.toMatchObject({ code: "permission.denied" });
    await expect(
      findEntitiesFor(env, code, { kind: "customer" })
    ).rejects.toMatchObject({ code: "permission.denied" });
    const events = await eventsOf(actor);
    expect(
      events.map(({ action, detail }) => ({ action, detail }))
    ).toStrictEqual([
      {
        action: "brain.memory.remembered",
        detail: { onBehalfOf: anna, refused: "permission.denied" },
      },
      {
        action: "brain.entity.read",
        detail: { onBehalfOf: anna, refused: "permission.denied" },
      },
    ]);
  });
});
