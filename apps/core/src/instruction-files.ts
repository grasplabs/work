import { appIdSchema, identifierSchema } from "@grasp-os/shared/ids";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { requireAdmin, roleErrors, roleSchema } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { readAgent } from "./agents.ts";
import { appFor, editableApp } from "./apps.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import {
  addInstructionFile,
  instructionFileOf,
  readInstructionFilesAs,
} from "./brain-next.ts";
import type { InstructionFile, InstructionFileVersion } from "./brain-next.ts";

// Instruction files (GRA-1771): what people write for every chat to start
// with, kept in the Brain (brain-next.ts). This file holds the two rules:
// which files a chat or run gets (`instructionFilesFor`), and who may
// write each (`saveInstructionFile`). Neither takes anyone on the
// caller's word: loading takes the agent's verified `Authority`, saving a
// signed-in person's `Identity`, and the role and membership behind both
// are read from core's records at each call.
//
// Which files, by where the agent works, as today's memory has them:
//
// - a person's own chat: the company's, the acting agent's, the App's
//   when they work on one they build, and their own;
// - an agent in a direct message: the company's, the agent's and the
//   person's it acts for;
// - an agent in a shared channel: the company's and the agent's, never a
//   person's, which others there would read through the agent;
// - an AI step of a workflow: none, so a run does the same whoever's
//   files changed.
//
// Shared files first, so the part many chats share comes first and stays
// the same.
//
// Who writes: a person their own file; an admin the company's and each
// agent's (as today's Memory collection); one of an App's builders its
// App's (as its code). Never code (an agent, App or workflow), whoever it
// acts for: a file an agent could write is an instruction a document it
// read could plant.

/**
 * Where an agent works in a chat, beyond who it is and whom it acts for
 * (its `Authority`): which kind of conversation, and in a person's own
 * chat the App they work on. The kind is vouched for by the chat's host,
 * which knows whether the chat is shared on its platform, as it does for
 * today's memory (workspace.ts); an `Authority` doesn't carry it. The App
 * is checked here: its file is given only to one of its builders.
 */
const instructionContextSchema = z.discriminatedUnion("conversation", [
  z.strictObject({
    conversation: z.literal("own"),
    appId: appIdSchema.optional(),
  }),
  z.strictObject({ conversation: z.literal("direct") }),
  z.strictObject({ conversation: z.literal("channel") }),
]);

/** Where an agent works in a chat, beyond its `Authority`. */
export type InstructionContext = z.input<typeof instructionContextSchema>;

/** The member `userId`, from core's records: refused once they no longer are one. */
const memberNamed = async (env: Env, userId: string): Promise<Member> => {
  const member = await memberOf(env.DB, userId);
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
 * The instruction files the agent `authority` gets in `context`, as they
 * are now, whole, in the order above; a file never written is left out.
 * The person is the one it acts for, the agent its own subject. A
 * workflow's AI step (`mode` "workflow") gets none and needs no context.
 * Refused with `permission.context_invalid` for code that isn't an agent,
 * and for a chat without a context or with one that isn't one; with
 * `permission.person_inactive` once the person is no longer a member;
 * and, working on an App, when they don't build it (`appFor`).
 */
export const instructionFilesFor = async (
  env: Env,
  by: Authority,
  input?: InstructionContext
): Promise<InstructionFileVersion[]> => {
  const authority = permissionErrors.parse(
    "permission.context_invalid",
    authoritySchema,
    by
  );
  if (authority.mode === "workflow") {
    return [];
  }
  if (authority.subject.type !== "agent") {
    // An App serves many people, and would carry one person's file to
    // the others.
    throw permissionErrors.create("permission.context_invalid");
  }
  const context = permissionErrors.parse(
    "permission.context_invalid",
    instructionContextSchema,
    input
  );
  const member = await memberNamed(env, authority.onBehalfOf);
  const agent: InstructionFile = {
    scope: "agent",
    agentId: authority.subject.agentId,
  };
  const person: InstructionFile = { scope: "person", personId: member.userId };
  switch (context.conversation) {
    case "channel": {
      return await readInstructionFilesAs(env, member, [
        ...companyFiles,
        agent,
      ]);
    }
    case "direct": {
      return await readInstructionFilesAs(env, member, [
        ...companyFiles,
        agent,
        person,
      ]);
    }
    case "own": {
      const { appId } = context;
      if (appId === undefined) {
        return await readInstructionFilesAs(env, member, [
          ...companyFiles,
          agent,
          person,
        ]);
      }
      // As today: an App's file is for those who build it.
      await appFor(env, member, appId, "builder");
      return await readInstructionFilesAs(
        env,
        member,
        [...companyFiles, agent, { scope: "app", appId }, person],
        appId
      );
    }
    default: {
      throw permissionErrors.create("permission.context_invalid");
    }
  }
};

/**
 * A signed-in person's session, as the RPC layer builds an `Identity`:
 * checked whole, so nothing else passes for one. Their role and
 * membership are read from core's records, not from here.
 */
const identitySchema = z.strictObject({
  userId: identifierSchema,
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  teams: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  staff: z.boolean(),
  onboardingOnly: z.literal(true).optional(),
  expiresAt: z.string(),
}) satisfies z.ZodType<Identity>;

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
    case "company": {
      requireAdmin(member);
      return;
    }
    case "agent": {
      requireAdmin(member);
      // Never a person's own agent's (agents.ts): what it is told is its
      // owner's to say, in its instructions, and an admin who learnt its
      // ID from the audit log tells it nothing.
      const agent = await readAgent(env, file.agentId);
      if (agent !== undefined && agent.ownerId !== null) {
        throw roleErrors.create("role.forbidden");
      }
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
 * Saves `text` as the next version of the instruction file `file`, by the
 * signed-in person `by`, once the rule above lets them, with their role
 * read from core's records now. Refused with `permission.denied` for any
 * code's `Authority` (an agent's, an App's, a workflow's), whoever it
 * acts for; `permission.person_inactive` for someone no longer a member;
 * `role.forbidden` (or the App's own refusals) for a file not theirs to
 * write; `instructions.too_large` over `instructionsMaxLength` UTF-16
 * units; `permission.invalid` for an `Identity` or file that isn't one.
 * `change` names this save, minted before its first try, so a retry saves
 * it once.
 *
 * A person's route passes the session's `Identity` as the RPC layer built
 * it, never one assembled by code acting for someone: code passes its own
 * `Authority`, and is refused.
 */
export const saveInstructionFile = async (
  env: Env,
  by: Identity | Authority,
  saved: { file: InstructionFile; change: string; text: string }
): Promise<{ file: InstructionFile; version: number }> => {
  if (typeof by === "object" && by !== null && "subject" in by) {
    throw permissionErrors.create("permission.denied", { action: "write" });
  }
  const person = permissionErrors.parse(
    "permission.invalid",
    identitySchema,
    by
  );
  const file = instructionFileOf(saved.file);
  await requireWriter(env, await memberNamed(env, person.userId), file);
  return await addInstructionFile(env, { ...saved, file });
};
