import { agentIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import { z } from "zod";

import { appFor, editableApp } from "./apps.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import {
  addInstructionFile,
  instructionFileSchema,
  readInstructionFilesAs,
} from "./brain-next.ts";
import type { InstructionFile, InstructionFileVersion } from "./brain-next.ts";

// Instruction files (GRA-1771): what people write for every chat to start
// with, kept in the Brain (brain-next.ts). This file holds the two rules:
// which files a chat or run gets (`instructionFilesFor`), and who may
// write each (`saveInstructionFile`).
//
// Which files, by where the agent works, as today's memory has them:
//
// - a person's own chat: the company's, the acting agent's, the App's
//   when they work on one they build, and their own;
// - an agent in a direct message: the company's, the agent's and the
//   person's it talks with;
// - an agent in a shared channel: the company's and the agent's, never a
//   person's, which others there would read through the agent;
// - an AI step of a workflow: none, so a run does the same whoever's
//   files changed.
//
// Shared files first, so the part many chats share comes first and stays
// the same. Each is read as the context's person, so the Brain holds a
// person's file to its person too, whatever the rule above names.
//
// Who writes: a person their own file; an admin the company's and each
// agent's (as today's Memory collection); one of an App's builders its
// App's (as its code). Never an agent, whoever it acts for: a file an
// agent could write is an instruction a document it read could plant.

/** A person's ID, as a context or a writer names them. */
const personIdSchema = z.string().min(1);

/**
 * Where an agent works, as far as its instruction files go. `personId` is
 * the person the agent acts for: in a channel, only the reader the files
 * are read as.
 */
export const instructionContextSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ownChat"),
    personId: personIdSchema,
    agentId: agentIdSchema,
    appId: appIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("directMessage"),
    personId: personIdSchema,
    agentId: agentIdSchema,
  }),
  z.strictObject({
    kind: z.literal("sharedChannel"),
    personId: personIdSchema,
    agentId: agentIdSchema,
  }),
  z.strictObject({ kind: z.literal("workflowStep") }),
]);

/** Where an agent works, as far as its instruction files go. */
export type InstructionContext = z.input<typeof instructionContextSchema>;

/** The member `personId`, refused once they no longer are one. */
const memberNamed = async (env: Env, personId: string): Promise<Member> => {
  const member = await memberOf(env.DB, personId);
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return member;
};

/** The company's files, the same in every context that gets them. */
const companyFiles: InstructionFile[] = [
  { scope: "company", name: "instructions" },
  { scope: "company", name: "facts" },
];

/**
 * The instruction files `input` gets, as they are now, whole, in the
 * order above; a file never written is left out. Refused for a context
 * that isn't one, once its person is no longer a member, and, working on
 * an App, when they don't build it (`appFor`).
 */
export const instructionFilesFor = async (
  env: Env,
  input: InstructionContext
): Promise<InstructionFileVersion[]> => {
  const context = permissionErrors.parse(
    "permission.context_invalid",
    instructionContextSchema,
    input
  );
  if (context.kind === "workflowStep") {
    return [];
  }
  const { personId, agentId } = context;
  const agent: InstructionFile = { scope: "agent", agentId };
  const person: InstructionFile = { scope: "person", personId };
  switch (context.kind) {
    case "sharedChannel": {
      return await readInstructionFilesAs(env, personId, [
        ...companyFiles,
        agent,
      ]);
    }
    case "directMessage": {
      return await readInstructionFilesAs(env, personId, [
        ...companyFiles,
        agent,
        person,
      ]);
    }
    case "ownChat": {
      const app: InstructionFile[] = [];
      if (context.appId !== undefined) {
        // As today: an App's file is for those who build it.
        await appFor(
          env,
          await memberNamed(env, personId),
          context.appId,
          "builder"
        );
        app.push({ scope: "app", appId: context.appId });
      }
      return await readInstructionFilesAs(env, personId, [
        ...companyFiles,
        agent,
        ...app,
        person,
      ]);
    }
    default: {
      throw permissionErrors.create("permission.context_invalid");
    }
  }
};

/**
 * Who saves an instruction file: a person, signed in, or an agent acting
 * for one, which is always refused.
 */
const writerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), personId: personIdSchema }),
  z.strictObject({
    kind: z.literal("agent"),
    agentId: agentIdSchema,
    onBehalfOf: personIdSchema,
  }),
]);

/** Who saves an instruction file. */
export type InstructionWriter = z.input<typeof writerSchema>;

/** Refuses `member` writing `file`, unless the rule above lets them. */
const requireWriter = async (
  env: Env,
  member: Member,
  file: InstructionFile
): Promise<void> => {
  switch (file.scope) {
    case "person": {
      if (file.personId !== member.userId) {
        throw roleErrors.create("role.forbidden");
      }
      return;
    }
    case "company":
    case "agent": {
      requireAdmin(member);
      return;
    }
    case "app": {
      await editableApp(env, member, file.appId);
      return;
    }
    default: {
      throw roleErrors.create("role.forbidden");
    }
  }
};

/**
 * Saves `text` as the next version of the instruction file `file`, by
 * `writer`, once the rule above lets them: refused for an agent
 * (`permission.denied`), for someone no longer a member
 * (`permission.person_inactive`), and for a file not theirs to write
 * (`role.forbidden`, or the App's own refusals). Refused too over
 * `instructionsMaxLength` characters or with no text. `change` names this
 * save, minted before its first try, so a retry saves it once.
 */
export const saveInstructionFile = async (
  env: Env,
  by: InstructionWriter,
  saved: { file: InstructionFile; change: string; text: string }
): Promise<{ file: InstructionFile; version: number }> => {
  const writer = permissionErrors.parse("permission.invalid", writerSchema, by);
  const file = permissionErrors.parse(
    "permission.invalid",
    instructionFileSchema,
    saved.file
  );
  if (writer.kind !== "person") {
    throw permissionErrors.create("permission.denied", { action: "write" });
  }
  await requireWriter(env, await memberNamed(env, writer.personId), file);
  return await addInstructionFile(env, { ...saved, file });
};
