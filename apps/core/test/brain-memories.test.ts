import {
  brainOf,
  entityAttributes,
  personalBrainOf,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { forgetFor, rememberFor } from "../src/brain-memories.ts";
import type { MemoryCaller } from "../src/brain-memories.ts";
import {
  erasePerson,
  forgetAs,
  memoryChoices,
  rememberAs,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
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
  return [...own.entities, ...shared.entities].map(({ id }) => id);
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

/** Of current memories, only which and what value. */
const values = (current: Awaited<ReturnType<typeof currentOf>>) =>
  current.map(({ id, value }) => ({ id, value }));

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

/** Where an audit event of a save and its undo stands: each attempt before its outcome. */
const orderOf = ({
  action,
  detail,
}: {
  action: string;
  detail?: Record<string, unknown>;
}): number =>
  (action === "brain.memory.remembered" ? 0 : 2) +
  (detail?.outcome === "attempted" ? 0 : 1);

/** A kind of entity that has `attribute`, as the Brain lists them. */
const kindOf = (attribute: string) => {
  const kind = memoryChoices.kinds.find((each) =>
    Object.hasOwn(entityAttributes[each], attribute)
  );
  if (kind === undefined) {
    throw new Error(`No kind has the attribute ${attribute}`);
  }
  return kind;
};

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

  it("brings their earlier word back when they undo the word that replaced it", async () => {
    const anna = await person();
    const name = `Acme ${unique()}`;
    const earlier = await rememberAs(env, anna, status(name, "Renewing"));
    const later = await rememberAs(env, anna, {
      ...status(name, "Churned"),
      about: { id: earlier.entity, kind: "customer" },
    });
    const replaced = await currentOf(anna, earlier.entity);
    const undone = await forgetAs(env, anna, later.memory);
    expect({
      replaced: values(replaced),
      undone,
      after: values(await currentOf(anna, earlier.entity)),
    }).toStrictEqual({
      replaced: [{ id: later.memory, value: "Churned" }],
      undone: "done",
      after: [{ id: earlier.memory, value: "Renewing" }],
    });
  });

  it("keeps a word the person undid out for good, in either order of undoing", async () => {
    const anna = await person();
    /** Saves A, then B over it, and undoes them in `order`: what each undo answered and what is current after. */
    const undoing = async (order: "earlier first" | "later first") => {
      const name = `Acme ${unique()}`;
      const earlier = await rememberAs(env, anna, status(name, "Renewing"));
      const later = await rememberAs(env, anna, {
        ...status(name, "Churned"),
        about: { id: earlier.entity, kind: "customer" },
      });
      const first = order === "earlier first" ? earlier : later;
      const second = order === "earlier first" ? later : earlier;
      const undone = [
        await forgetAs(env, anna, first.memory),
        await forgetAs(env, anna, second.memory),
      ];
      return { undone, after: values(await currentOf(anna, earlier.entity)) };
    };

    expect({
      earlierFirst: await undoing("earlier first"),
      laterFirst: await undoing("later first"),
    }).toStrictEqual({
      earlierFirst: { undone: ["done", "done"], after: [] },
      laterFirst: { undone: ["done", "done"], after: [] },
    });
  });

  it("saves every attribute the chat's tool offers, each with a value", async () => {
    const anna = await person();
    const saved = await Promise.all(
      memoryChoices.attributes.map(async (attribute) => {
        try {
          await rememberAs(env, anna, {
            change: crypto.randomUUID(),
            about: { kind: kindOf(attribute), names: [`Named ${unique()}`] },
            attribute,
            value: "Some value",
            type: "fact",
            statement: "Some value",
            quote: "Some value",
          });
          return [attribute, "saved"];
        } catch {
          return [attribute, "refused"];
        }
      })
    );
    expect(saved.filter(([, outcome]) => outcome !== "saved")).toStrictEqual(
      []
    );
  });

  it("refuses a memory of a type the Brain doesn't list, as its type rules out", async () => {
    const anna = await person();
    await expect(
      rememberAs(env, anna, {
        ...status("Acme", "Renewing"),
        // @ts-expect-error -- a type the Brain doesn't list
        type: "rumour",
      })
    ).rejects.toThrow("That isn't a valid request to the Brain.");
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
    // The outcomes come through core's outbox, after their attempts.
    const events = await vi.waitFor(
      async () => {
        const kept = await eventsOf(caller.actor);
        expect(kept).toHaveLength(4);
        return kept;
      },
      { timeout: 10_000 }
    );
    expect({
      events: events
        .toSorted((a, b) => orderOf(a) - orderOf(b))
        .map(({ action, detail }) => ({ action, detail })),
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

  it("audits a save to an erased own store as refused for that reason", async () => {
    const anna = await person();
    await Promise.allSettled([
      erasePerson(env, { personId: anna, reason: "person_erased" }),
    ]);
    await ageOwnErasure(anna);
    const caller = themselves(anna);
    const refused = await rememberFor(
      env,
      caller,
      status(`Acme ${unique()}`, "Renewing")
    ).then(
      () => "saved",
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "an error with no code"
    );
    const events = await vi.waitFor(
      async () => {
        const kept = await eventsOf(caller.actor);
        expect(kept).toHaveLength(2);
        return kept;
      },
      { timeout: 10_000 }
    );
    expect({
      refused,
      outcome: events
        .map(({ detail }) => detail)
        .find((detail) => detail?.outcome === "refused")?.reason,
    }).toStrictEqual({
      refused: "brain.source_erased",
      outcome: "brain.source_erased",
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
