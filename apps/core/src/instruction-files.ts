import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
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
import { editableApp } from "./apps.ts";
import { appendAuditEvent } from "./audit-outbox.ts";
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
//   files changed;
// - a turn nobody asked for there and then (a wake-up, an event): as its
//   chat's, but never the person's own. What woke it steers it, and what
//   it hands on goes where that leads, so it holds none of their own
//   content, as it recalls none of their own store (workspace.ts,
//   `answersAlone`).
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
    unattended: z.literal(true).optional(),
  }),
  z.strictObject({
    conversation: z.literal("direct"),
    unattended: z.literal(true).optional(),
  }),
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

/**
 * Whether `member` may change the App `appId` now, as its builders change
 * it (`editableApp`, app-access.ts): their role in it, and, shared with
 * them, that they may read every source it holds; and that it isn't
 * archived. The App's file reaches a chat on the rule that lets it be
 * edited. Any other answer to that check is no; anything else still
 * fails the call.
 */
const buildsApp = async (
  env: Env,
  member: Member,
  appId: string
): Promise<boolean> => {
  try {
    await editableApp(env, member, appId);
    return true;
  } catch (error) {
    if (
      roleErrors.codeOf(error) === "role.forbidden" ||
      appErrors.codeOf(error) === "app.not_found" ||
      appErrors.codeOf(error) === "app.unreadable" ||
      appErrors.codeOf(error) === "app.archived"
    ) {
      return false;
    }
    throw error;
  }
};

/** The company's files, the same in every context that gets them. */
const companyFiles: InstructionFile[] = [
  { scope: "company", name: "instructions" },
  { scope: "company", name: "facts" },
];

/** The files `context` gets, read as `member`, in the order above. */
const filesOf = async (
  env: Env,
  member: Member,
  context: z.output<typeof instructionContextSchema>,
  { agent, person }: { agent: InstructionFile; person: InstructionFile }
): Promise<InstructionFileVersion[]> => {
  if (context.conversation === "channel") {
    return await readInstructionFilesAs(env, member, [...companyFiles, agent]);
  }
  // Theirs only in a turn they asked for (above).
  const own = context.unattended === true ? [] : [person];
  switch (context.conversation) {
    case "direct": {
      return await readInstructionFilesAs(env, member, [
        ...companyFiles,
        agent,
        ...own,
      ]);
    }
    case "own": {
      const { appId } = context;
      // An App's file is for those who may change it, while it isn't
      // archived. A chat about an App they no longer build, or one put
      // away, goes on without it, as with an App that has none: refusing
      // would end the chat over a file, and tell them it exists.
      if (appId === undefined || !(await buildsApp(env, member, appId))) {
        return await readInstructionFilesAs(env, member, [
          ...companyFiles,
          agent,
          ...own,
        ]);
      }
      return await readInstructionFilesAs(
        env,
        member,
        [...companyFiles, agent, { scope: "app", appId }, ...own],
        appId
      );
    }
    default: {
      throw permissionErrors.create("permission.context_invalid");
    }
  }
};

/**
 * The instruction files the agent `authority` gets in `context`, as they
 * are now, whole, in the order above; a file never written is left out.
 * The person is the one it acts for, the agent its own subject. A
 * workflow's AI step (`mode` "workflow") gets none and needs no context.
 * Refused with `permission.context_invalid` for code that isn't an agent,
 * and for a chat without a context or with one that isn't one; with
 * `permission.person_inactive` once the person is no longer a member.
 * Working on an App they don't build, its file is left out; in a turn
 * nobody asked for (`unattended`), the person's own.
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
  const read = await filesOf(env, member, context, { agent, person });
  // An emptied file is a version of its own, which nothing loads.
  return read.filter(({ text }) => text.trim() !== "");
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

/**
 * The signed-in person `by`, as a member now: refused with
 * `permission.denied` for any code's `Authority`, whoever it acts for, and
 * `permission.invalid` for anything that isn't a session's `Identity`.
 */
const signedInMember = async (
  env: Env,
  by: Identity | Authority,
  action: "read" | "write"
): Promise<Member> => {
  if (typeof by === "object" && by !== null && "subject" in by) {
    throw permissionErrors.create("permission.denied", { action });
  }
  const person = permissionErrors.parse(
    "permission.invalid",
    identitySchema,
    by
  );
  return await memberNamed(env, person.userId);
};

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
      // Only one of the company's agents has a file: none is kept under
      // an ID nobody made, or one an admin deleted.
      const agent = await readAgent(env, file.agentId);
      if (agent === undefined) {
        throw agentErrors.create("agent.unknown");
      }
      // Never a person's own agent's (agents.ts): what it is told is its
      // owner's to say, in its instructions, and an admin who learnt its
      // ID from the audit log tells it nothing.
      if (agent.ownerId !== null) {
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
 * The version a save was edited from, which every save names: 0 for a
 * file never written.
 */
const afterSchema = z.int().min(0);

/** The file's own ID in the audit log: its scope and whose it is. */
const instructionFileId = (file: InstructionFile): string => {
  switch (file.scope) {
    case "company": {
      return `company:${file.name}`;
    }
    case "person": {
      return `person:${file.personId}`;
    }
    case "app": {
      return `app:${file.appId}`;
    }
    case "agent": {
      return `agent:${file.agentId}`;
    }
    default: {
      throw new Error("Unknown instruction file");
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
 * write; `agent.unknown` for an agent the company doesn't have;
 * `instructions.too_large` over `instructionsMaxLength` UTF-16 units;
 * `instructions.changed` once `after`, the version it was edited from
 * (0 for none), is no longer the current one; `permission.invalid` for an
 * `Identity` or file that isn't one, or a save that names no `after`. Empty text empties the file, which
 * then loads nowhere. `change` names this save, minted before its first
 * try, so a retry saves it once.
 *
 * A person's route passes the session's `Identity` as the RPC layer built
 * it, never one assembled by code acting for someone: code passes its own
 * `Authority`, and is refused.
 */
export const saveInstructionFile = async (
  env: Env,
  by: Identity | Authority,
  saved: { file: InstructionFile; change: string; text: string; after: number }
): Promise<{ file: InstructionFile; version: number }> => {
  const file = instructionFileOf(saved.file);
  // Required here, whatever the caller's types said: a client's save
  // without it would skip the store's check and overwrite a newer save.
  const after = permissionErrors.parse(
    "permission.invalid",
    afterSchema,
    Reflect.get(saved, "after")
  );
  const member = await signedInMember(env, by, "write");
  await requireWriter(env, member, file);
  const added = await addInstructionFile(env, { ...saved, file, after });
  // Recorded once the version is there, so an entry never reads as a
  // save that wasn't made. One the log can't take fails the call, and the
  // version it saved stays unrecorded unless the same save (the same
  // change) is tried again, which records it then. Which file and
  // version, never its text.
  await appendAuditEvent(env, {
    actor: actorOf(member),
    action: "instructions.saved",
    target: { type: "instructions", id: instructionFileId(file) },
    detail: { scope: file.scope, version: added.version },
  });
  return added;
};

/**
 * The instruction file `file` as it is now, for the signed-in person `by`
 * to edit: only one they may write (the rule above), so this reads no
 * file its saving wouldn't let them change. `null` while it was never
 * written. Refused as `saveInstructionFile` refuses.
 */
export const instructionFileToEdit = async (
  env: Env,
  by: Identity | Authority,
  input: unknown
): Promise<{ version: number; text: string } | null> => {
  const file = instructionFileOf(input);
  const member = await signedInMember(env, by, "read");
  await requireWriter(env, member, file);
  // An App's file is read as one of its builders, which `requireWriter`
  // has just checked.
  const [found] = await readInstructionFilesAs(
    env,
    member,
    [file],
    file.scope === "app" ? file.appId : undefined
  );
  return found === undefined
    ? null
    : { version: found.version, text: found.text };
};
