import {
  brainOf,
  instructionsMaxLength,
  personalBrainOf,
  recallBudgetMax,
} from "@grasp-os/brain-next/contract";
import type { Authority } from "@grasp-os/shared/permissions";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addInstructionFile,
  erasePerson,
  readInstructionFilesAs,
  recallAs,
} from "../src/brain-next.ts";
import type { InstructionFile } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  instructionFileToEdit,
  instructionFilesFor,
  saveInstructionFile,
} from "../src/instruction-files.ts";
import type { InstructionContext } from "../src/instruction-files.ts";
import { outlook, requestGranted } from "./apps.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { keptAgent } from "./instruction-saves.ts";
import {
  auditedDuring,
  outcome,
  signedInApi,
  signedInWithRole,
  unique,
  whoami,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Instruction files (GRA-1771), from the threat model on the issue: a
// context gets a file its rule leaves out, above all a person's file in a
// shared channel or another person's chat; an agent gets another agent's
// file; a caller names someone else to get their file; someone writes a
// file that isn't theirs to write, an agent above all, which would let a
// document it read plant standing instructions; a file grows past its
// limit; recall returns a file, or fails on one; an App's file reaches
// someone outside the App; an ID is shaped to reach another scope's file;
// someone who left still reads or writes.

const idp = mockIdp();

/** Signing people in and creating Apps can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A member signed in with `role`, as core's session knows them. */
const member = async (
  role: "admin" | "builder" | "user"
): Promise<Identity> => {
  const { session } = await signedInWithRole(idp, role);
  return await whoami(session);
};

/** A builder with their API, to create Apps, and their identity. */
const builderWithApi = async () => {
  const builder = await signedInApi(idp, "builder");
  return { ...builder, identity: await whoami(builder.session) };
};

const newAgentId = () => `agent-${unique()}`;

/** The agent `agentId` acting for `personId`, in a chat. */
const agentFor = (agentId: string, personId: string): Authority =>
  actingFor({ type: "agent", agentId }, personId);

/** The agent `agentId` running a workflow's AI step for `personId`. */
const inWorkflow = (agentId: string, personId: string): Authority =>
  authoritySchema.parse({
    subject: { type: "agent", agentId },
    onBehalfOf: personId,
    mode: "workflow",
  });

/** The version of `file` now as `by` would read it to edit; 0 for none or unreadable. */
const versionNow = async (
  by: Identity | Authority,
  file: InstructionFile
): Promise<number> => {
  try {
    const now = await instructionFileToEdit(env, by, file);
    return now?.version ?? 0;
  } catch {
    return 0;
  }
};

/** Saves `text` to `file` as `by`, from its version now, with a change of its own. */
const save = async (
  by: Identity,
  file: InstructionFile,
  text: string
): Promise<number> => {
  const { version } = await saveInstructionFile(env, by, {
    file,
    change: crypto.randomUUID(),
    text,
    after: await versionNow(by, file),
  });
  return version;
};

/** How a save of `text` to `file` as `by` ends: "ok" or the refusal's code. */
const saveOutcome = async (
  by: Identity | Authority,
  file: InstructionFile,
  text = `x ${unique()}`
): Promise<string> => {
  const after = await versionNow(by, file);
  return await outcome(
    saveInstructionFile(env, by, {
      file,
      change: crypto.randomUUID(),
      text,
      after,
    })
  );
};

/** The texts `authority` gets in `context`, in order. */
const textsFor = async (
  authority: Authority,
  context?: InstructionContext
): Promise<string[]> => {
  const files = await instructionFilesFor(env, authority, context);
  return files.map(({ text }) => text);
};

/** Which of `markers` the files `authority` gets in `context` hold, in order. */
const markersFor = async (
  markers: Record<string, string>,
  authority: Authority,
  context?: InstructionContext
): Promise<string[]> => {
  const texts = await textsFor(authority, context);
  return texts.flatMap((text) =>
    Object.entries(markers).flatMap(([name, marker]) =>
      text === marker ? [name] : []
    )
  );
};

/** A personal connection of `ownerId`'s: their mailbox, which nobody else reads. */
const mailboxOf = async (ownerId: string): Promise<string> => {
  const id = `connection-mailbox-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
    )
    .bind(id, ownerId, now, now)
    .run();
  return id;
};

/** The Brain's store, read directly, as only these tests do. */
const store = () => env.BRAIN_STORE.getByName("brain");

describe("instruction files", setUpTime, () => {
  it("gives each context exactly its files, never another person's or agent's", async () => {
    const [admin, other, builder] = await Promise.all([
      member("admin"),
      member("user"),
      builderWithApi(),
    ]);
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const [agentId, otherAgentId] = await Promise.all([
      keptAgent(),
      keptAgent(),
    ]);
    const u = unique();
    const markers = {
      companyInstructions: `company instructions ${u}`,
      companyFacts: `company facts ${u}`,
      agent: `agent ${u}`,
      otherAgent: `other agent ${u}`,
      app: `app ${u}`,
      person: `person ${u}`,
      otherPerson: `other person ${u}`,
    };
    const personId = builder.userId;
    await save(
      admin,
      { scope: "company", name: "instructions" },
      markers.companyInstructions
    );
    await save(
      admin,
      { scope: "company", name: "facts" },
      markers.companyFacts
    );
    await save(admin, { scope: "agent", agentId }, markers.agent);
    await save(
      admin,
      { scope: "agent", agentId: otherAgentId },
      markers.otherAgent
    );
    await save(builder.identity, { scope: "app", appId }, markers.app);
    await save(builder.identity, { scope: "person", personId }, markers.person);
    await save(
      other,
      { scope: "person", personId: other.userId },
      markers.otherPerson
    );
    const asAgent = agentFor(agentId, personId);

    const got = {
      ownChat: await markersFor(markers, asAgent, { conversation: "own" }),
      ownChatOnApp: await markersFor(markers, asAgent, {
        conversation: "own",
        appId,
      }),
      directMessage: await markersFor(markers, asAgent, {
        conversation: "direct",
      }),
      sharedChannel: await markersFor(markers, asAgent, {
        conversation: "channel",
      }),
      workflowStep: await markersFor(markers, inWorkflow(agentId, personId)),
      otherPersonsChat: await markersFor(
        markers,
        agentFor(agentId, other.userId),
        { conversation: "own" }
      ),
      otherAgentsMessage: await markersFor(
        markers,
        agentFor(otherAgentId, personId),
        { conversation: "direct" }
      ),
    };
    expect(got).toStrictEqual({
      ownChat: ["companyInstructions", "companyFacts", "agent", "person"],
      ownChatOnApp: [
        "companyInstructions",
        "companyFacts",
        "agent",
        "app",
        "person",
      ],
      directMessage: ["companyInstructions", "companyFacts", "agent", "person"],
      sharedChannel: ["companyInstructions", "companyFacts", "agent"],
      workflowStep: [],
      otherPersonsChat: [
        "companyInstructions",
        "companyFacts",
        "agent",
        "otherPerson",
      ],
      otherAgentsMessage: [
        "companyInstructions",
        "companyFacts",
        "otherAgent",
        "person",
      ],
    });
    const files = await instructionFilesFor(env, asAgent, {
      conversation: "own",
      appId,
    });
    expect(files.map(({ file }) => file)).toStrictEqual([
      { scope: "company", name: "instructions" },
      { scope: "company", name: "facts" },
      { scope: "agent", agentId },
      { scope: "app", appId },
      { scope: "person", personId },
    ]);
  });

  it("gives a direct message only the file of the person the agent acts for, whatever the context holds", async () => {
    const [one, other] = await Promise.all([member("user"), member("user")]);
    const u = unique();
    await save(one, { scope: "person", personId: one.userId }, `one ${u}`);
    await save(
      other,
      { scope: "person", personId: other.userId },
      `other ${u}`
    );
    const asAgent = agentFor(newAgentId(), one.userId);

    await expect(
      textsFor(asAgent, { conversation: "direct" })
    ).resolves.not.toContain(`other ${u}`);
    // A context naming someone else is no context.
    const named = await outcome(
      instructionFilesFor(
        env,
        asAgent,
        // SAFETY: a call from outside TypeScript can send any shape.
        {
          conversation: "direct",
          personId: other.userId,
        } as InstructionContext
      )
    );
    expect(named).toBe("permission.context_invalid");
  });

  it("gives files only to an agent: an App or a workflow's own code gets none in a chat", async () => {
    const person = await member("user");
    const asApp = actingFor(
      { type: "app", appId: `app-${unique()}` },
      person.userId
    );
    await expect(
      outcome(instructionFilesFor(env, asApp, { conversation: "own" }))
    ).resolves.toBe("permission.context_invalid");
    // A chat needs its context: which kind of conversation it is.
    await expect(
      outcome(instructionFilesFor(env, agentFor(newAgentId(), person.userId)))
    ).resolves.toBe("permission.context_invalid");
  });

  it("skips a file never written, without an error", async () => {
    const person = await member("user");
    const asAgent = agentFor(newAgentId(), person.userId);
    const scopesNow = async (): Promise<string[]> => {
      const files = await instructionFilesFor(env, asAgent, {
        conversation: "direct",
      });
      return files.map(({ file }) => file.scope);
    };
    // The company's may have been written by another test; the agent's
    // and the person's never were.
    await expect(scopesNow()).resolves.not.toContain("agent");
    await expect(scopesNow()).resolves.not.toContain("person");

    await save(
      person,
      { scope: "person", personId: person.userId },
      `mine ${unique()}`
    );
    await expect(scopesNow()).resolves.toContain("person");
  });

  it("keeps every version, loads the newest, and saves a retried change once", async () => {
    const person = await member("user");
    const file: InstructionFile = { scope: "person", personId: person.userId };
    const change = crypto.randomUUID();
    const first = await saveInstructionFile(env, person, {
      file,
      change,
      text: "first",
      after: 0,
    });
    // Its answer lost, the same save again, from the same version.
    const retried = await saveInstructionFile(env, person, {
      file,
      change,
      text: "first",
      after: 0,
    });
    const second = await save(person, file, "second");

    expect([first.version, retried.version, second]).toStrictEqual([1, 1, 2]);
    const files = await instructionFilesFor(
      env,
      agentFor(newAgentId(), person.userId),
      { conversation: "own" }
    );
    expect(files.at(-1)).toMatchObject({ file, version: 2, text: "second" });
  });

  it("refuses a file over its limit at save, counted in UTF-16 units, and keeps the one before", async () => {
    const person = await member("user");
    const file: InstructionFile = { scope: "person", personId: person.userId };
    // "𝄞" is one character but two UTF-16 units, as today's limit counts.
    const astral = "𝄞";
    const atMost = astral.repeat(instructionsMaxLength / 2);

    await expect(saveOutcome(person, file, atMost)).resolves.toBe("ok");
    await expect(saveOutcome(person, file, `${atMost}a`)).resolves.toBe(
      "instructions.too_large"
    );
    await expect(saveOutcome(person, file, `${atMost}${astral}`)).resolves.toBe(
      "instructions.too_large"
    );
    // Counted as the prompt holds it too, its markup escaped: a few
    // thousand ampersands are several times as long there.
    await expect(
      saveOutcome(person, file, "&".repeat(instructionsMaxLength / 2))
    ).resolves.toBe("instructions.too_large");
    await expect(
      textsFor(agentFor(newAgentId(), person.userId), { conversation: "own" })
    ).resolves.toContain(atMost);
  });

  it("lets each file be written only by those who may: a person their own, admins the company's and agents', builders their App's", async () => {
    const [admin, user, otherUser, builder, otherBuilder] = await Promise.all([
      member("admin"),
      member("user"),
      member("user"),
      builderWithApi(),
      builderWithApi(),
    ]);
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const company: InstructionFile = { scope: "company", name: "instructions" };
    const agent: InstructionFile = {
      scope: "agent",
      agentId: await keptAgent(),
    };
    const app: InstructionFile = { scope: "app", appId };
    const own: InstructionFile = { scope: "person", personId: user.userId };

    const outcomes = {
      ownByPerson: await saveOutcome(user, own),
      ownByOtherPerson: await saveOutcome(otherUser, own),
      ownByAdmin: await saveOutcome(admin, own),
      companyByUser: await saveOutcome(user, company),
      companyByBuilder: await saveOutcome(builder.identity, company),
      companyByAdmin: await saveOutcome(admin, company),
      agentByUser: await saveOutcome(user, agent),
      agentByAdmin: await saveOutcome(admin, agent),
      appByItsBuilder: await saveOutcome(builder.identity, app),
      appByOtherBuilder: await saveOutcome(otherBuilder.identity, app),
    };
    expect(outcomes).toStrictEqual({
      ownByPerson: "ok",
      ownByOtherPerson: "role.forbidden",
      ownByAdmin: "role.forbidden",
      companyByUser: "role.forbidden",
      companyByBuilder: "role.forbidden",
      companyByAdmin: "ok",
      agentByUser: "role.forbidden",
      agentByAdmin: "ok",
      appByItsBuilder: "ok",
      appByOtherBuilder: "app.not_found",
    });
  });

  it("takes the writer's role from core's records, not from their session", async () => {
    const demoted = await member("admin");
    await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
      .bind(demoted.userId)
      .run();
    await expect(
      saveOutcome(demoted, { scope: "company", name: "facts" })
    ).resolves.toBe("role.forbidden");
  });

  it("never lets an agent write a file, whoever it acts for, its own person's included", async () => {
    const admin = await member("admin");
    const agentId = await keptAgent();
    const files: InstructionFile[] = [
      { scope: "company", name: "instructions" },
      { scope: "company", name: "facts" },
      { scope: "agent", agentId },
      { scope: "person", personId: admin.userId },
    ];
    for (const by of [
      agentFor(agentId, admin.userId),
      inWorkflow(agentId, admin.userId),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      const outcomes = await Promise.all(
        files.map(async (file) => await saveOutcome(by, file))
      );
      expect(outcomes).toStrictEqual(files.map(() => "permission.denied"));
    }
    // A person's identity with an agent's subject added is an agent's.
    await expect(
      saveOutcome(
        // SAFETY: a call from outside TypeScript can send any shape.
        {
          ...admin,
          subject: { type: "agent", agentId },
        } as Identity,
        { scope: "person", personId: admin.userId }
      )
    ).resolves.toBe("permission.denied");
  });

  it("takes only a whole session's identity as a writer", async () => {
    const person = await member("user");
    const own: InstructionFile = { scope: "person", personId: person.userId };
    const malformed: unknown[] = [
      { userId: person.userId },
      { ...person, userId: 42 },
      { ...person, role: "owner" },
      { ...person, extra: true },
      null,
      "someone",
    ];
    const outcomes = await Promise.all(
      malformed.map(
        async (by) =>
          // SAFETY: a call from outside TypeScript can send any shape.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          await saveOutcome(by as Identity, own)
      )
    );
    expect(outcomes).toStrictEqual(malformed.map(() => "permission.invalid"));
  });

  it("refuses someone who left: no reading and no writing", async () => {
    const person = await member("user");
    const file: InstructionFile = { scope: "person", personId: person.userId };
    await save(person, file, `mine ${unique()}`);
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(person.userId)
      .run();

    await expect(saveOutcome(person, file)).resolves.toBe(
      "permission.person_inactive"
    );
    await expect(
      outcome(
        instructionFilesFor(env, agentFor(newAgentId(), person.userId), {
          conversation: "own",
        })
      )
    ).resolves.toBe("permission.person_inactive");
  });

  it("gives an App's file only to a person who builds the App, leaves it out for anyone else, and holds it to the App in the Brain too", async () => {
    const [builder, outsider] = await Promise.all([
      builderWithApi(),
      builderWithApi(),
    ]);
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const marker = `app ${unique()}`;
    await save(builder.identity, { scope: "app", appId }, marker);
    const onApp = { conversation: "own", appId } as const;

    await expect(
      textsFor(agentFor(newAgentId(), builder.userId), onApp)
    ).resolves.toContain(marker);
    // Someone who doesn't build it gets what a chat without an App gets,
    // as with an App that has no file: no refusal that says it exists.
    await expect(
      textsFor(agentFor(newAgentId(), outsider.userId), onApp)
    ).resolves.not.toContain(marker);
    // A reader of the whole company, who passed no builder check, gets
    // nothing of it from the store itself.
    await expect(
      store().readCurrent({
        sources: [`instructions:app:${appId}`],
        reader: { person: outsider.userId, groups: ["company"] },
      })
    ).resolves.toStrictEqual([]);
  });

  it("leaves an App's file out for a builder it was shared with once the App holds data they can't read", async () => {
    const [owner, shared] = await Promise.all([
      builderWithApi(),
      builderWithApi(),
    ]);
    const { id: appId } = await owner.api.apps.create({ name: "Desk" });
    await owner.api.apps.members.add(appId, {
      type: "person",
      id: shared.userId,
      role: "builder",
    });
    const marker = `app ${unique()}`;
    await save(owner.identity, { scope: "app", appId }, marker);
    const onApp = { conversation: "own", appId } as const;
    const before = await textsFor(agentFor(newAgentId(), shared.userId), onApp);

    // The App is granted the owner's own mailbox, which the builder it is
    // shared with can't read: they no longer open the App, nor its file.
    await requestGranted(idp, owner, {
      ...outlook(appId, "MAIL"),
      object: {
        type: "connection",
        connectionId: await mailboxOf(owner.userId),
      },
    });
    const after = await textsFor(agentFor(newAgentId(), shared.userId), onApp);
    const ownerTexts = await textsFor(
      agentFor(newAgentId(), owner.userId),
      onApp
    );

    expect({
      before: before.includes(marker),
      after: after.includes(marker),
      opens: await outcome(shared.api.apps.get(appId)),
      owner: ownerTexts.includes(marker),
    }).toStrictEqual({
      before: true,
      after: false,
      opens: "app.unreadable",
      owner: true,
    });
  });

  it("leaves an archived App's file out, as its builders can't change it, and gives it again once it is restored", async () => {
    const builder = await builderWithApi();
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const marker = `app ${unique()}`;
    await save(builder.identity, { scope: "app", appId }, marker);
    const onApp = { conversation: "own", appId } as const;
    const loaded = async () => {
      const texts = await textsFor(
        agentFor(newAgentId(), builder.userId),
        onApp
      );
      return texts.includes(marker);
    };

    const before = await loaded();
    await builder.api.apps.archive(appId);
    const archived = await loaded();
    const edit = await outcome(
      builder.api.instructions.read({ scope: "app", appId })
    );
    await builder.api.apps.restore(appId);

    expect({ before, archived, edit, restored: await loaded() }).toStrictEqual({
      before: true,
      archived: false,
      edit: "app.archived",
      restored: true,
    });
  });

  it("never lets recall return an instruction file, shared or a person's", async () => {
    const admin = await member("admin");
    const word = `w${unique()}`;
    await save(admin, { scope: "person", personId: admin.userId }, word);
    await save(admin, { scope: "company", name: "facts" }, `${word} company`);
    await save(
      admin,
      { scope: "agent", agentId: await keptAgent() },
      `${word} agent`
    );

    await expect(
      recallAs(env, admin.userId, {
        personal: true,
        question: word,
        budget: { tokens: recallBudgetMax },
      })
    ).resolves.toStrictEqual({ items: [], notFound: [word], truncated: false });
  });

  it("keeps scopes apart however an ID is shaped", async () => {
    const [person, admin] = await Promise.all([
      member("user"),
      member("admin"),
    ]);
    const marker = `mine ${unique()}`;
    await save(person, { scope: "person", personId: person.userId }, marker);
    // Agents named to reach the person's file, written by an admin.
    const shaped = [
      `person:${person.userId}`,
      `:person:${person.userId}`,
      `../person/${person.userId}`,
    ];
    // No agent is kept under such an ID, so no admin saves one's file;
    // and were one written to the Brain, its key is its own.
    for (const agentId of shaped) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await expect(
        saveOutcome(admin, { scope: "agent", agentId })
      ).resolves.toBe("agent.unknown");
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await addInstructionFile(env, {
        file: { scope: "agent", agentId },
        change: crypto.randomUUID(),
        text: `agent ${agentId}`,
        after: 0,
      });
    }

    for (const agentId of shaped) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      const texts = await textsFor(agentFor(agentId, person.userId), {
        conversation: "channel",
      });
      expect(texts).not.toContain(marker);
      expect(texts).toContain(`agent ${agentId}`);
    }
    // A control character, which could split a key, is refused.
    for (const file of [
      { scope: "agent", agentId: `a\npe${person.userId}` },
      { scope: "person", personId: `${person.userId}\u0000` },
    ] satisfies InstructionFile[]) {
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      await expect(saveOutcome(admin, file)).resolves.toBe(
        "permission.invalid"
      );
    }
  });

  it("refuses a context that isn't one, whole", async () => {
    const { userId } = await member("user");
    const asAgent = agentFor(newAgentId(), userId);
    const malformed: unknown[] = [
      { conversation: "channel", appId: "app" },
      { conversation: "direct", appId: "app" },
      { conversation: "channel", people: ["someone"] },
      { conversation: "own", agentId: "another" },
      { conversation: "elsewhere" },
      {},
    ];
    const outcomes = await Promise.all(
      malformed.map(
        async (context) =>
          await outcome(
            // SAFETY: a call from outside TypeScript can send any shape.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            instructionFilesFor(env, asAgent, context as InstructionContext)
          )
      )
    );
    expect(outcomes).toStrictEqual(
      malformed.map(() => "permission.context_invalid")
    );
  });
});

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/** The version of `file` `api` reads to edit now; 0 for none or refused. */
const versionAs = async (api: Api, file: InstructionFile): Promise<number> => {
  try {
    const now = await api.instructions.read(file);
    return now?.version ?? 0;
  } catch {
    return 0;
  }
};

/** How `api`'s save of `text` to `file`, from its version now, ends: "ok" or the refusal's code. */
const saved = async (api: Api, file: InstructionFile, text: string) => {
  const after = await versionAs(api, file);
  return await outcome(
    api.instructions.save({ file, change: crypto.randomUUID(), text, after })
  );
};

/** How `api`'s read of `file` ends: "ok" or the refusal's code. */
const read = async (api: Api, file: InstructionFile) =>
  await outcome(api.instructions.read(file));

describe("instruction files, edited from a page", setUpTime, () => {
  it("lets a person read and save their own file, an admin the company's and an agent's, a builder their App's, and nobody anything else", async () => {
    const [admin, person, builder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const u = unique();
    const own = { scope: "person", personId: person.userId } as const;
    const company = { scope: "company", name: "instructions" } as const;
    const agent = { scope: "agent", agentId: await keptAgent() } as const;
    const app = { scope: "app", appId } as const;
    const saves = {
      own: await saved(person.api, own, `Mine ${u}`),
      company: await saved(admin.api, company, `Company ${u}`),
      agent: await saved(admin.api, agent, `Agent ${u}`),
      app: await saved(builder.api, app, `App ${u}`),
      companyByMember: await saved(person.api, company, "Planted"),
      agentByMember: await saved(person.api, agent, "Planted"),
      appByMember: await saved(person.api, app, "Planted"),
      someoneElsesByAdmin: await saved(admin.api, own, "Planted"),
      tooLarge: await saved(
        person.api,
        own,
        "x".repeat(instructionsMaxLength + 1)
      ),
    };
    const companyNow = await admin.api.instructions.read(company);
    const reads = {
      own: await person.api.instructions.read(own),
      // Other tests save the company's too: its text, whatever the version.
      company: companyNow?.text,
      app: await builder.api.instructions.read(app),
      neverWritten: await builder.api.instructions.read({
        scope: "person",
        personId: builder.userId,
      }),
      someoneElsesByAdmin: await read(admin.api, own),
      companyByMember: await read(person.api, company),
      appByMember: await read(person.api, app),
    };

    expect({ saves, reads }).toStrictEqual({
      saves: {
        own: "ok",
        company: "ok",
        agent: "ok",
        app: "ok",
        companyByMember: "role.forbidden",
        agentByMember: "role.forbidden",
        appByMember: "app.not_found",
        someoneElsesByAdmin: "role.forbidden",
        tooLarge: "instructions.too_large",
      },
      reads: {
        own: { version: 1, text: `Mine ${u}` },
        company: `Company ${u}`,
        app: { version: 1, text: `App ${u}` },
        neverWritten: null,
        someoneElsesByAdmin: "role.forbidden",
        companyByMember: "role.forbidden",
        appByMember: "app.not_found",
      },
    });
  });

  it("records each save, by whom and of which file and version, and never its text", async () => {
    const admin = await signedInApi(idp, "admin");
    const text = `Secret rule ${unique()}`;
    const file = { scope: "company", name: "facts" } as const;

    const events = await auditedDuring(async () => {
      await admin.api.instructions.save({
        file,
        change: crypto.randomUUID(),
        text,
        after: await versionAs(admin.api, file),
      });
    });
    const recorded = events.filter(
      ({ action }) => action === "instructions.saved"
    );

    expect({
      saved: recorded.map(({ actor, target, detail }) => ({
        actor,
        target,
        scope: detail.scope,
        numbered: typeof detail.version,
      })),
      carriesText: JSON.stringify(events).includes(text),
    }).toStrictEqual({
      saved: [
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "instructions", id: "company:facts" },
          scope: "company",
          numbered: "number",
        },
      ],
      carriesText: false,
    });
  });

  it("refuses a save made from a version someone has saved over since, and keeps theirs", async () => {
    const [ada, ben] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const file = { scope: "agent", agentId: await keptAgent() } as const;
    const first = await ada.api.instructions.save({
      file,
      change: crypto.randomUUID(),
      text: "First.",
      after: 0,
    });
    // Both open it at that version; Ada saves first.
    const adas = await outcome(
      ada.api.instructions.save({
        file,
        change: crypto.randomUUID(),
        text: "Ada's.",
        after: first.version,
      })
    );
    const bens = await outcome(
      ben.api.instructions.save({
        file,
        change: crypto.randomUUID(),
        text: "Ben's.",
        after: first.version,
      })
    );
    const now = await ben.api.instructions.read(file);

    expect({ adas, bens, now }).toStrictEqual({
      adas: "ok",
      bens: "instructions.changed",
      now: { version: first.version + 1, text: "Ada's." },
    });
  });

  it("empties a file with an empty save, keeping the version before, and loads nothing for it", async () => {
    const person = await signedInApi(idp, "user");
    const own = { scope: "person", personId: person.userId } as const;
    const marker = `Mine ${unique()}`;
    const first = await person.api.instructions.save({
      file: own,
      change: crypto.randomUUID(),
      text: marker,
      after: 0,
    });
    const emptied = await person.api.instructions.save({
      file: own,
      change: crypto.randomUUID(),
      text: "",
      after: first.version,
    });

    const loaded = await textsFor(agentFor(newAgentId(), person.userId), {
      conversation: "own",
    });

    expect({
      emptied: emptied.version,
      read: await person.api.instructions.read(own),
      loadsTheirs: loaded.some((text) => text === marker || text === ""),
    }).toStrictEqual({
      emptied: first.version + 1,
      read: { version: first.version + 1, text: "" },
      loadsTheirs: false,
    });
  });

  it("keeps no file for an agent the company doesn't have", async () => {
    const admin = await signedInApi(idp, "admin");
    const nobody = { scope: "agent", agentId: newAgentId() } as const;

    expect({
      save: await saved(admin.api, nobody, "Planted"),
      read: await read(admin.api, nobody),
    }).toStrictEqual({ save: "agent.unknown", read: "agent.unknown" });
  });

  it("saves only from a version the client names: refused without one, refused from a stale one, and a first save from none", async () => {
    const person = await signedInApi(idp, "user");
    const own = { scope: "person", personId: person.userId } as const;
    const sent = async (asked: Record<string, unknown>) =>
      await outcome(
        person.api.instructions.save(
          // SAFETY: as a client may send it: Cap'n Web checks no types.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          asked as never
        )
      );

    const withoutAfter = await sent({
      file: own,
      change: crypto.randomUUID(),
      text: "No version named.",
    });
    const first = await sent({
      file: own,
      change: crypto.randomUUID(),
      text: "First.",
      after: 0,
    });
    const second = await sent({
      file: own,
      change: crypto.randomUUID(),
      text: "Second.",
      after: 1,
    });
    const stale = await sent({
      file: own,
      change: crypto.randomUUID(),
      text: "From the first.",
      after: 1,
    });

    expect({
      withoutAfter,
      first,
      second,
      stale,
      now: await person.api.instructions.read(own),
    }).toStrictEqual({
      withoutAfter: "permission.invalid",
      first: "ok",
      second: "ok",
      stale: "instructions.changed",
      now: { version: 2, text: "Second." },
    });
  });

  it("keeps a person's own file in their own store alone, checks a save's version there, loads it in their chats alone, and erases it with them", async () => {
    const [person, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const file = { scope: "person", personId: person.userId } as const;
    const key = `instructions:person:${person.userId}`;
    const reader = { person: person.userId, groups: ["company"] };
    const namespace = inJurisdiction(env, env.BRAIN_STORE);
    const sent = async (text: string, after: number) =>
      await outcome(
        person.api.instructions.save({
          file,
          change: crypto.randomUUID(),
          text,
          after,
        })
      );
    const marker = `Mine ${unique()}`;

    const saves = {
      first: await sent("Mine.", 0),
      stale: await sent("From nothing.", 0),
      second: await sent(marker, 1),
    };
    const ownStore = await personalBrainOf(
      namespace,
      person.userId
    ).readCurrent({ sources: [key], reader });
    const sharedStore = await brainOf(namespace).readCurrent({
      sources: [key],
      reader,
    });
    const theirChat = await textsFor(agentFor(newAgentId(), person.userId), {
      conversation: "own",
    });
    const othersChat = await textsFor(agentFor(newAgentId(), other.userId), {
      conversation: "own",
    });
    const erasing = {
      personId: person.userId,
      reason: "person_erased",
    } as const;
    await Promise.allSettled([erasePerson(env, erasing)]);
    await ageOwnErasure(person.userId);
    const erased = await erasePerson(env, erasing);
    const afterErasure = await readInstructionFilesAs(
      env,
      { userId: person.userId },
      [file]
    );

    expect({
      saves,
      ownStore: ownStore.map(({ version, text }) => ({ version, text })),
      sharedStore,
      theirChat: theirChat.includes(marker),
      othersChat: othersChat.includes(marker),
      erased,
      afterErasure: afterErasure.map(({ text }) => text),
    }).toStrictEqual({
      saves: { first: "ok", stale: "instructions.changed", second: "ok" },
      ownStore: [{ version: 2, text: marker }],
      sharedStore: [],
      theirChat: true,
      othersChat: false,
      erased: "erased",
      afterErasure: [],
    });
  });
});
