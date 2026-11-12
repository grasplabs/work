import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { forgetFor, rememberFor } from "../src/brain-memories.ts";
import type { MemoryCaller } from "../src/brain-memories.ts";
import { forgetAs, rememberAs } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { failingAuditLog } from "./failing-audit-log.ts";
import { mockIdp } from "./idp.ts";
import { eventsOf } from "./model-rules.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// A person's memories through core (GRA-1743, threat model on the
// issue): what is saved is the person's own word, theirs alone, in their
// own store; their new word on an attribute replaces their earlier one;
// forgetting retires only their own; and every call is audited, its
// attempt before anything is written.

const idp = mockIdp();

/** A member of the organization, signed in. */
const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** `personId` as the Brain's reader, in no team. */
const readerOf = (personId: string) => ({ person: personId, groups: [] });

/** What `personId` finds named `name`, in their own store and the shared one. */
const foundBy = async (personId: string, name: string) => {
  const ns = inJurisdiction(env, env.BRAIN_STORE);
  const reader = readerOf(personId);
  const [own, shared] = await Promise.all([
    personalBrainOf(ns, personId).findEntities({ reader, name }),
    brainOf(ns).findEntities({ reader, name }),
  ]);
  return [...own, ...shared].map(({ id }) => id);
};

/** The current memories about `entity` in `personId`'s own store. */
const currentOf = async (personId: string, entity: string) => {
  const { memories } = await personalBrainOf(
    inJurisdiction(env, env.BRAIN_STORE),
    personId
  ).readMemories({ entity, reader: readerOf(personId) });
  return memories.map(({ id, value, writer, speaker }) => ({
    id,
    value,
    writer,
    speaker,
  }));
};

/** A customer's status, in the person's own words. */
const status = (name: string, value: string) => ({
  change: crypto.randomUUID(),
  about: { kind: "customer" as const, names: [name] },
  attribute: "status" as const,
  value,
  type: "fact" as const,
  statement: `${name} is ${value}`,
  quote: `${name} is ${value}`,
});

/** The person themselves, as a caller of brain-memories.ts. */
const themselves = (personId: string): MemoryCaller => ({
  person: personId,
  actor: { type: "person", userId: personId },
});

describe("a person's memories", () => {
  it("keeps what is saved as the person's own word, readable by them alone", async () => {
    const [anna, ben] = await Promise.all([person(), person()]);
    const name = `Acme ${unique()}`;
    const { memory, entity } = await rememberAs(
      env,
      anna,
      status(name, "Renewing")
    );
    expect({
      hers: await foundBy(anna, name),
      his: await foundBy(ben, name),
      kept: await currentOf(anna, entity),
    }).toStrictEqual({
      hers: [entity],
      his: [],
      kept: [
        {
          id: memory,
          value: "Renewing",
          writer: anna,
          speaker: { kind: "internal", person: anna },
        },
      ],
    });
  });

  it("saves the same change once, and replaces their earlier word on an attribute", async () => {
    const anna = await person();
    const name = `Acme ${unique()}`;
    const first = status(name, "Renewing");
    const saved = await rememberAs(env, anna, first);
    const again = await rememberAs(env, anna, first);
    const newer = await rememberAs(env, anna, {
      ...status(name, "Churned"),
      about: { id: saved.entity, kind: "customer" },
    });
    expect({
      again,
      current: await currentOf(anna, saved.entity),
    }).toStrictEqual({
      again: saved,
      current: [
        {
          id: newer.memory,
          value: "Churned",
          writer: anna,
          speaker: { kind: "internal", person: anna },
        },
      ],
    });
  });

  it("forgets only the person's own memory, and a retry reads as done", async () => {
    const [anna, ben] = await Promise.all([person(), person()]);
    const saved = await rememberAs(
      env,
      anna,
      status(`Acme ${unique()}`, "Renewing")
    );
    const byHim = await forgetAs(env, ben, saved.memory);
    const current = await currentOf(anna, saved.entity);
    const before = current.length;
    const byHer = [
      await forgetAs(env, anna, saved.memory),
      await forgetAs(env, anna, saved.memory),
    ];
    expect({
      byHim,
      before,
      byHer,
      after: await currentOf(anna, saved.entity),
    }).toStrictEqual({
      byHim: "nothing",
      before: 1,
      byHer: ["done", "done"],
      after: [],
    });
  });

  it("refuses someone who is no longer a member", async () => {
    await expect(
      rememberAs(env, `gone-${crypto.randomUUID()}`, status("Acme", "Renewing"))
    ).rejects.toMatchObject({ code: "permission.person_inactive" });
  });
});

describe("a person's memories, for a caller", () => {
  it("audits each attempt before it writes and then its outcome, with ids only", async () => {
    const anna = await person();
    const caller = themselves(anna);
    const name = `Secretname ${unique()}`;
    const remembered = status(name, "Renewing");
    const saved = await rememberFor(env, caller, remembered);
    await forgetFor(env, caller, saved.memory);
    const events = await eventsOf(caller.actor);
    expect({
      events: events.map(({ action, detail }) => ({ action, detail })),
      named: JSON.stringify(events).includes("Secretname"),
    }).toStrictEqual({
      events: [
        {
          action: "brain.memory.remembered",
          detail: {
            onBehalfOf: anna,
            change: remembered.change,
            outcome: "attempted",
          },
        },
        {
          action: "brain.memory.remembered",
          detail: {
            onBehalfOf: anna,
            change: remembered.change,
            outcome: "done",
            memory: saved.memory,
            entity: saved.entity,
          },
        },
        {
          action: "brain.memory.forgotten",
          detail: {
            onBehalfOf: anna,
            memory: saved.memory,
            outcome: "attempted",
          },
        },
        {
          action: "brain.memory.forgotten",
          detail: {
            onBehalfOf: anna,
            memory: saved.memory,
            outcome: "done",
            result: "done",
          },
        },
      ],
      named: false,
    });
  });

  it("writes nothing when the audit log can't take the attempt", async () => {
    const anna = await person();
    const name = `Acme ${unique()}`;
    const refused = await rememberFor(
      { ...env, AUDIT_LOG: failingAuditLog() },
      themselves(anna),
      status(name, "Renewing")
    ).then(
      () => "saved",
      () => "refused"
    );
    expect({ refused, found: await foundBy(anna, name) }).toStrictEqual({
      refused: "refused",
      found: [],
    });
  });
});
