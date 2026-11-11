import { instructionsMaxLength } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { recallAs } from "../src/brain-next.ts";
import type { InstructionFile } from "../src/brain-next.ts";
import {
  instructionFilesFor,
  saveInstructionFile,
} from "../src/instruction-files.ts";
import type {
  InstructionContext,
  InstructionWriter,
} from "../src/instruction-files.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// Instruction files (GRA-1771), from the threat model on the issue: a
// context gets a file its rule leaves out, above all a person's file in a
// shared channel or another person's chat; an agent gets another agent's
// file; someone writes a file that isn't theirs to write, an agent above
// all, which would let a document it read plant standing instructions; a
// file grows past its limit; recall returns a file to someone outside its
// scope; an ID is shaped to reach another scope's file; someone who left
// still reads or writes.

const idp = mockIdp();

/** Signing people in and creating Apps can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const memberWith = async (
  role: "admin" | "builder" | "user"
): Promise<string> => {
  const { userId } = await signedInWithRole(idp, role);
  return userId;
};

const newAgentId = () => `agent-${unique()}`;

const asPerson = (personId: string): InstructionWriter => ({
  kind: "person",
  personId,
});

/** Saves `text` to `file` as `by`, with a change of its own. */
const save = async (
  by: InstructionWriter,
  file: InstructionFile,
  text: string
): Promise<number> => {
  const { version } = await saveInstructionFile(env, by, {
    file,
    change: crypto.randomUUID(),
    text,
  });
  return version;
};

/** How a save of `text` to `file` as `by` ends: "ok" or the refusal. */
const saveOutcome = async (
  by: InstructionWriter,
  file: InstructionFile,
  text = `x ${unique()}`
): Promise<string> =>
  await outcome(
    saveInstructionFile(env, by, { file, change: crypto.randomUUID(), text })
  );

/** The texts `context` gets, in order. */
const textsFor = async (context: InstructionContext): Promise<string[]> => {
  const files = await instructionFilesFor(env, context);
  return files.map(({ text }) => text);
};

/** Which of `markers` the files of `context` hold, by name, in order. */
const markersFor = async (
  context: InstructionContext,
  markers: Record<string, string>
): Promise<string[]> => {
  const texts = await textsFor(context);
  return texts.flatMap((text) =>
    Object.entries(markers).flatMap(([name, marker]) =>
      text === marker ? [name] : []
    )
  );
};

describe("instruction files", setUpTime, () => {
  it("gives each context exactly its files, never another person's or agent's", async () => {
    const [admin, other] = await Promise.all([
      memberWith("admin"),
      memberWith("user"),
    ]);
    const builder = await signedInApi(idp, "builder");
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const [agentId, otherAgentId] = [newAgentId(), newAgentId()];
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
    await save(
      asPerson(admin),
      { scope: "company", name: "instructions" },
      markers.companyInstructions
    );
    await save(
      asPerson(admin),
      { scope: "company", name: "facts" },
      markers.companyFacts
    );
    await save(asPerson(admin), { scope: "agent", agentId }, markers.agent);
    await save(
      asPerson(admin),
      { scope: "agent", agentId: otherAgentId },
      markers.otherAgent
    );
    await save(asPerson(builder.userId), { scope: "app", appId }, markers.app);
    await save(
      asPerson(builder.userId),
      { scope: "person", personId: builder.userId },
      markers.person
    );
    await save(
      asPerson(other),
      { scope: "person", personId: other },
      markers.otherPerson
    );
    const personId = builder.userId;

    const got = {
      ownChat: await markersFor(
        { kind: "ownChat", personId, agentId },
        markers
      ),
      ownChatOnApp: await markersFor(
        { kind: "ownChat", personId, agentId, appId },
        markers
      ),
      directMessage: await markersFor(
        { kind: "directMessage", personId, agentId },
        markers
      ),
      sharedChannel: await markersFor(
        { kind: "sharedChannel", personId, agentId },
        markers
      ),
      workflowStep: await markersFor({ kind: "workflowStep" }, markers),
      otherPersonsChat: await markersFor(
        { kind: "ownChat", personId: other, agentId },
        markers
      ),
      otherAgentsMessage: await markersFor(
        { kind: "directMessage", personId, agentId: otherAgentId },
        markers
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
    const files = await instructionFilesFor(env, {
      kind: "ownChat",
      personId,
      agentId,
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

  it("skips a file never written, without an error", async () => {
    const personId = await memberWith("user");
    const agentId = newAgentId();
    const files = await instructionFilesFor(env, {
      kind: "directMessage",
      personId,
      agentId,
    });
    // The company's may have been written by another test; the agent's
    // and the person's never were.
    expect(files.map(({ file }) => file.scope)).not.toContain("agent");
    expect(files.map(({ file }) => file.scope)).not.toContain("person");

    await save(
      asPerson(personId),
      { scope: "person", personId },
      `mine ${unique()}`
    );
    const after = await instructionFilesFor(env, {
      kind: "directMessage",
      personId,
      agentId,
    });
    expect(after.at(-1)?.file).toStrictEqual({ scope: "person", personId });
  });

  it("keeps every version, loads the newest, and saves a retried change once", async () => {
    const personId = await memberWith("user");
    const file: InstructionFile = { scope: "person", personId };
    const change = crypto.randomUUID();
    const first = await saveInstructionFile(env, asPerson(personId), {
      file,
      change,
      text: "first",
    });
    const retried = await saveInstructionFile(env, asPerson(personId), {
      file,
      change,
      text: "first",
    });
    const second = await save(asPerson(personId), file, "second");

    expect([first.version, retried.version, second]).toStrictEqual([1, 1, 2]);
    const files = await instructionFilesFor(env, {
      kind: "ownChat",
      personId,
      agentId: newAgentId(),
    });
    expect(files.at(-1)).toMatchObject({ file, version: 2, text: "second" });
  });

  it("refuses a file over its limit at save, and keeps the one before", async () => {
    const personId = await memberWith("user");
    const file: InstructionFile = { scope: "person", personId };
    const atMost = "a".repeat(instructionsMaxLength);

    await expect(saveOutcome(asPerson(personId), file, atMost)).resolves.toBe(
      "ok"
    );
    await expect(
      saveOutcome(asPerson(personId), file, `${atMost}a`)
    ).resolves.toMatch(/^Error: Refused/u);
    await expect(
      saveOutcome(asPerson(personId), file, " \n ")
    ).resolves.toMatch(/^Error: Refused/u);
    await expect(
      textsFor({ kind: "ownChat", personId, agentId: newAgentId() })
    ).resolves.toContain(atMost);
  });

  it("lets each file be written only by those who may: a person their own, admins the company's and agents', builders their App's", async () => {
    const [admin, member, otherMember] = await Promise.all([
      memberWith("admin"),
      memberWith("user"),
      memberWith("user"),
    ]);
    const [builder, notBuilder] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const company: InstructionFile = {
      scope: "company",
      name: "instructions",
    };
    const agent: InstructionFile = {
      scope: "agent",
      agentId: newAgentId(),
    };
    const app: InstructionFile = { scope: "app", appId };
    const own: InstructionFile = { scope: "person", personId: member };

    const outcomes = {
      ownByPerson: await saveOutcome(asPerson(member), own),
      ownByOtherPerson: await saveOutcome(asPerson(otherMember), own),
      ownByAdmin: await saveOutcome(asPerson(admin), own),
      companyByMember: await saveOutcome(asPerson(member), company),
      companyByBuilder: await saveOutcome(asPerson(builder.userId), company),
      companyByAdmin: await saveOutcome(asPerson(admin), company),
      agentByMember: await saveOutcome(asPerson(member), agent),
      agentByAdmin: await saveOutcome(asPerson(admin), agent),
      appByItsBuilder: await saveOutcome(asPerson(builder.userId), app),
      appByOtherBuilder: await saveOutcome(asPerson(notBuilder.userId), app),
    };
    expect(outcomes).toStrictEqual({
      ownByPerson: "ok",
      ownByOtherPerson: "role.forbidden",
      ownByAdmin: "role.forbidden",
      companyByMember: "role.forbidden",
      companyByBuilder: "role.forbidden",
      companyByAdmin: "ok",
      agentByMember: "role.forbidden",
      agentByAdmin: "ok",
      appByItsBuilder: "ok",
      appByOtherBuilder: "app.not_found",
    });
  });

  it("never lets an agent write a file, whoever it acts for", async () => {
    const admin = await memberWith("admin");
    const agentId = newAgentId();
    const asAgent: InstructionWriter = {
      kind: "agent",
      agentId,
      onBehalfOf: admin,
    };
    const files: InstructionFile[] = [
      { scope: "company", name: "instructions" },
      { scope: "company", name: "facts" },
      { scope: "agent", agentId },
      { scope: "person", personId: admin },
    ];
    const outcomes = await Promise.all(
      files.map(async (file) => await saveOutcome(asAgent, file))
    );
    expect(outcomes).toStrictEqual(files.map(() => "permission.denied"));
    // An agent passed off as a person by a stray field is refused whole.
    await expect(
      saveOutcome(
        // SAFETY: a call from outside TypeScript can send any shape.
        { kind: "person", personId: admin, agentId } as InstructionWriter,
        { scope: "person", personId: admin }
      )
    ).resolves.toBe("permission.invalid");
  });

  it("refuses someone who left: no reading and no writing", async () => {
    const personId = await memberWith("user");
    const file: InstructionFile = { scope: "person", personId };
    await save(asPerson(personId), file, `mine ${unique()}`);
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();

    await expect(saveOutcome(asPerson(personId), file)).resolves.toBe(
      "permission.person_inactive"
    );
    await expect(
      outcome(
        instructionFilesFor(env, {
          kind: "ownChat",
          personId,
          agentId: newAgentId(),
        })
      )
    ).resolves.toBe("permission.person_inactive");
  });

  it("gives an App's file only to a person who builds the App", async () => {
    const [builder, outsider] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    const marker = `app ${unique()}`;
    await save(asPerson(builder.userId), { scope: "app", appId }, marker);
    const onApp = (personId: string): InstructionContext => ({
      kind: "ownChat",
      personId,
      agentId: newAgentId(),
      appId,
    });

    await expect(textsFor(onApp(builder.userId))).resolves.toContain(marker);
    await expect(
      outcome(instructionFilesFor(env, onApp(outsider.userId)))
    ).resolves.not.toBe("ok");
  });

  it("never lets recall return an instruction file, to its own person either", async () => {
    const personId = await memberWith("admin");
    const word = `w${unique()}`;
    await save(asPerson(personId), { scope: "person", personId }, word);
    await save(
      asPerson(personId),
      { scope: "company", name: "facts" },
      `${word} company`
    );
    await save(
      asPerson(personId),
      { scope: "agent", agentId: newAgentId() },
      `${word} agent`
    );

    await expect(recallAs(env, personId, word)).resolves.toStrictEqual({
      chunks: [],
    });
  });

  it("keeps scopes apart however an ID is shaped", async () => {
    const [personId, admin] = await Promise.all([
      memberWith("user"),
      memberWith("admin"),
    ]);
    const marker = `mine ${unique()}`;
    await save(asPerson(personId), { scope: "person", personId }, marker);
    // Agents named to reach the person's file, written by an admin.
    const shaped = [
      `person:${personId}`,
      `:person:${personId}`,
      `../person/${personId}`,
    ];
    for (const agentId of shaped) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await save(
        asPerson(admin),
        { scope: "agent", agentId },
        `agent ${agentId}`
      );
    }

    for (const agentId of shaped) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      const texts = await textsFor({
        kind: "sharedChannel",
        personId,
        agentId,
      });
      expect(texts).not.toContain(marker);
      expect(texts).toContain(`agent ${agentId}`);
    }
  });

  it("refuses a context that isn't one, whole", async () => {
    const personId = await memberWith("user");
    const agentId = newAgentId();
    const malformed: unknown[] = [
      { kind: "sharedChannel", personId, agentId, appId: "app" },
      { kind: "sharedChannel", personId, agentId, people: [personId] },
      { kind: "directMessage", personId: "", agentId },
      { kind: "ownChat", personId },
      { kind: "workflowStep", personId },
      { kind: "elsewhere", personId, agentId },
    ];
    const outcomes = await Promise.all(
      malformed.map(
        async (context) =>
          await outcome(
            // SAFETY: a call from outside TypeScript can send any shape.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            instructionFilesFor(env, context as InstructionContext)
          )
      )
    );
    expect(outcomes).toStrictEqual(
      malformed.map(() => "permission.context_invalid")
    );
  });
});
