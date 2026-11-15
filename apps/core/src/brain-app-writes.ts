import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import type { MemberRole } from "@grasp-os/shared/subject-members";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { requireAppRole } from "./app-access.ts";
import {
  otherAppsReachedBy,
  readerOf,
  sourcesOf,
  unreadableBy,
} from "./app-provenance.ts";
import { loadRelease } from "./app-releases.ts";
import { findApp } from "./apps.ts";
import {
  appendAuditEvent,
  keepAuditEvent,
  keepEvent,
  uuidFromHash,
} from "./audit-outbox.ts";
import { memberOf } from "./auth/identity.ts";
import {
  forgetForAppAs,
  isCodeWriteRequest,
  rememberForAppAs,
} from "./brain-next.ts";
import type { CodeWriteOperation } from "./brain-next.ts";
import { authorize } from "./permissions.ts";
import type { InvocationOrigin } from "./resource-adapter.ts";

// What an App's code writes to the Brain (GRA-1883, threat model on the
// issue): `ctx.brain.remember` and `ctx.brain.forget`, in the App's own
// word (`app:<id>`), read only through that App's own code by whoever
// uses it when it reads (brain-next.ts `appUsersGroup`). A write may say
// only what everyone who uses the App could read already, so it is
// refused, before anything is written, unless all of this holds at the
// write (`writeRefusal`):
//
// - It comes from a person's own call on the App's page, or a function
//   that call runs nested (`InvocationOrigin`). An agent's call holds
//   what its chat read, which only its person may; Code Mode's too; a
//   workflow's step what its run was started with. Each is refused by
//   name. A visitor's or a guest's call never reaches the Brain: it binds
//   nothing, and an App that holds the Brain answers no visitor
//   (app-provenance.ts `recallsTheBrain`).
// - The person it is for uses the App now, as `requireAppRole` decides
//   from their membership read now, never the call's own roles.
// - Every table of the version the call runs on (never the App's current
//   one: a publish during the call changes nothing it read) is read by
//   everyone who uses the App: a page can hand on, as an argument, any
//   row its person read, so which rows a call read can't be told apart.
//   A table nobody reads holds nothing a call read. One only builders
//   read refuses a call for someone who builds the App (admins build
//   every App), and only them: no one else's call could read it.
// - Everything the App can reach is everyone's in the company: no
//   personal connection, no collection not everyone reads, no team's part
//   of the Brain, no other App, nothing that can't be placed
//   (app-provenance.ts). A grant counts once given, revoked or not: the
//   App may still hold what it read.
//
// Audited with ids, counts and codes alone, never what a memory says: an
// attempt before anything is written (a write the log can't take writes
// nothing), then its outcome. A `done` is one event per change, its ID
// from the change and its time the one the store recorded (when the
// memory was learned, when it was retired), so a call made again, or a
// write asked again after a lost reply, keeps the same event, whole.

/** Who writes, as core resolved them: the App's binding's caller. */
export interface AppWriteCaller {
  readonly app: AppId;
  readonly origin: InvocationOrigin;
  readonly authority: Authority;
  readonly context: WorkContext;
  readonly permissionId: PermissionId;
  readonly actor: AuditActor;
  /** The request's own key: the same each time the same call is made again. */
  readonly key: string;
}

/** The role in App `app` that member `personId` has now, as `requireAppRole` decides it: none for no role, or no longer a member. */
const appRoleNow = async (
  env: Env,
  personId: string,
  app: AppId
): Promise<MemberRole | undefined> => {
  const member = await memberOf(env.DB, personId);
  if (member === undefined) {
    return undefined;
  }
  try {
    return await requireAppRole(env, member, await findApp(env, app), "user");
  } catch (error) {
    if (isExpectedError(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The App whose users' memories App `app`'s code reads for `origin`'s
 * call for member `personId` (brain-next.ts `appUsersGroup`): `app`, only
 * for a person's own call on its page while they use it now; none for any
 * other, which reads what everyone in the company may read alone. An
 * agent's, Code Mode's or a workflow's call would hand what it read on to
 * a chat or a run, where people read who may not use the App.
 */
export const appUsersReadBy = async (
  env: Env,
  {
    app,
    origin,
    personId,
  }: { app: AppId; origin: InvocationOrigin; personId: string }
): Promise<AppId | undefined> =>
  origin === "page" && (await appRoleNow(env, personId, app)) !== undefined
    ? app
    : undefined;

/** Who reads a table of a version, of its users: everyone, its builders, fewer, or nobody. */
type TableReaders = "everyone" | "builders" | "fewer" | "nobody";

/** A table's access and row rules, as a release holds them. */
interface TableAccess {
  readonly access: { readonly read: string };
  readonly rules?: {
    readonly read?: readonly {
      readonly kind: string;
      readonly role?: string;
    }[];
  };
}

/**
 * Who of an App's users reads `table`, as its store enforces its access
 * (runtime table-access.ts): a row reaches whoever any of its rules
 * admits, so a rule admitting the role `user` reaches everyone the mode
 * does.
 */
const readersOf = ({ access, rules }: TableAccess): TableReaders => {
  const read = rules?.read;
  if (access.read === "none") {
    return "nobody";
  }
  if (access.read === "owner") {
    return "fewer";
  }
  const byRole = (role: string) =>
    read?.some((rule) => rule.kind === "role" && rule.role === role) === true;
  const onlyRoles = read?.every((rule) => rule.kind === "role") !== false;
  if (access.read === "appMembers") {
    if (read === undefined || byRole("user")) {
      return "everyone";
    }
    return onlyRoles ? "builders" : "fewer";
  }
  if (access.read === "appBuilders") {
    return read === undefined || byRole("user") || onlyRoles
      ? "builders"
      : "fewer";
  }
  return "fewer";
};

/** What `reachable` names first that not everyone may read, as a refusal names it. */
const unreadableReachOf = (
  unreadable: readonly string[]
): "connection" | "collection" | "team_brain" | "unresolved" | undefined => {
  const [first] = unreadable;
  if (first === undefined) {
    return undefined;
  }
  if (first.startsWith("connection:")) {
    return "connection";
  }
  if (first.startsWith("collection:")) {
    return "collection";
  }
  return first.startsWith("brain:") ? "team_brain" : "unresolved";
};

/**
 * Why `caller`'s write may not be made (see the header), as the function
 * host passes it on to App code; undefined when it may.
 */
const writeRefusal = async (
  env: Env,
  caller: AppWriteCaller
): Promise<Error | undefined> => {
  const { app, origin, authority } = caller;
  if (origin !== "page") {
    return functionErrors.create("permission.brain_write_caller", {
      caller: origin,
    });
  }
  const role = await appRoleNow(env, authority.onBehalfOf, app);
  if (role === undefined) {
    return functionErrors.create("permission.brain_write_not_user");
  }
  // The version the call runs on, as the host set it: never the App's
  // current one.
  const version = authority.appVersion;
  if (version === undefined) {
    throw new Error("An App's call names no version");
  }
  const release = await loadRelease(env, app, version);
  for (const [table, access] of Object.entries(release.app.schema.tables)) {
    const readers = readersOf(access);
    if (readers === "fewer") {
      return functionErrors.create("permission.brain_write_table", { table });
    }
    if (readers === "builders" && role === "builder") {
      return functionErrors.create("permission.brain_write_builders_table", {
        table,
      });
    }
  }
  const [sources, others] = await Promise.all([
    sourcesOf(env, app),
    otherAppsReachedBy(env, app),
  ]);
  // As someone in no team, who isn't an admin, reads: what everyone may.
  const reach = unreadableReachOf(
    unreadableBy(sources, readerOf("", [], "user"))
  );
  if (reach !== undefined) {
    return functionErrors.create("permission.brain_write_reach", { reach });
  }
  if (others.length > 0) {
    return functionErrors.create("permission.brain_write_reach", {
      reach: "app",
    });
  }
  return undefined;
};

/** The audit action of each write. */
const actions: Readonly<Record<CodeWriteOperation, string>> = {
  remember: "brain.memory.remembered",
  forget: "brain.memory.forgotten",
};

/** An id as the audit log may name it: a well-formed one, never what code sent instead. */
const idOf = (value: unknown): string | null => {
  const id = z.uuid().safeParse(value);
  return id.success ? id.data : null;
};

/** What the audit may name of a request: the memory it forgets, by id. */
const askedOf = (
  operation: CodeWriteOperation,
  input: unknown
): Record<string, string | null> =>
  operation === "forget"
    ? {
        memory: idOf(
          typeof input === "object" && input !== null
            ? Reflect.get(input, "memory")
            : undefined
        ),
      }
    : {};

/** `error` in the function host's words: a request the Brain refused as one it isn't. */
const inHostWords = (error: unknown): unknown => {
  if (!isExpectedError(error)) {
    return error;
  }
  if (error.code === "brain.request_invalid") {
    return functionErrors.create("permission.invalid_args");
  }
  return error.code === "permission.person_inactive"
    ? functionErrors.create("permission.unavailable")
    : error;
};

/**
 * `write` once, and once more when its reply was lost (an error no rule
 * of the Brain's gave): the same change, so what landed, never what the
 * first reply said.
 */
const landed = async <T>(write: () => Promise<T>): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    return await write();
  }
};

/** What a write answers App code, its outcome's details, and the store's time for it. */
interface Written {
  answer: Json;
  detail: Record<string, string | boolean | null>;
  /** When the store recorded what the change did: its `done`'s time. */
  at?: Date;
}

/** Makes `operation` for `caller`, checked already, under `change`. */
const writeFor = async (
  env: Env,
  caller: AppWriteCaller,
  operation: CodeWriteOperation,
  input: unknown,
  change: string
): Promise<Written> => {
  const person = caller.authority.onBehalfOf;
  if (operation === "remember") {
    const { memory, entity, learnedAt } = await landed(
      async () =>
        await rememberForAppAs(env, person, { app: caller.app, change }, input)
    );
    return {
      answer: { memory, entity },
      detail: { memory, entity },
      at: learnedAt,
    };
  }
  const retired = await landed(
    async () => await forgetForAppAs(env, person, caller.app, input)
  );
  return retired === null
    ? { answer: false, detail: { result: "nothing" } }
    : { answer: true, detail: { result: "done" }, at: retired.retiredAt };
};

/**
 * `ctx.brain.remember` and `ctx.brain.forget` for App `caller.app`'s code
 * (above): refused as `permission.invalid_args` for input that isn't a
 * request (an id the App's code may not see among them, as one nobody
 * holds), `permission.denied` without the grant to read the Brain, one of
 * the `permission.brain_write_*` codes when its code may not write now,
 * and `permission.unavailable` once the person is no longer a member.
 * Audited before it writes and after.
 */
export const appWriteFor = async (
  env: Env,
  caller: AppWriteCaller,
  operation: CodeWriteOperation,
  input: unknown
): Promise<Json> => {
  const action = actions[operation];
  const entry = (
    detail: Record<string, string | number | boolean | null>
  ): AuditEntry => ({
    actor: caller.actor,
    action,
    target: { type: "app", id: caller.app },
    detail: { onBehalfOf: caller.authority.onBehalfOf, ...detail },
  });
  const asked = askedOf(operation, input);
  // One change per call and person: the same when the call is made again.
  const change = `app:${caller.app}/${await sha256Hex(
    JSON.stringify([caller.authority.onBehalfOf, caller.key])
  )}`;
  try {
    // The input first, as a recall's: a caller with no grant and bad
    // input is refused alike by both.
    if (!isCodeWriteRequest(operation, input)) {
      throw functionErrors.create("permission.invalid_args");
    }
    await authorize(
      env,
      caller.authority,
      { type: "platform" },
      "brain",
      caller.permissionId,
      caller.context
    );
    const refusal = await writeRefusal(env, caller);
    if (refusal !== undefined) {
      throw refusal;
    }
  } catch (error) {
    const refused = inHostWords(error);
    await appendAuditEvent(
      env,
      entry({
        ...asked,
        outcome: "refused",
        reason: isExpectedError(refused) ? refused.code : "internal.unexpected",
      })
    );
    throw refused;
  }
  // Kept before anything is written: a write the log can't take writes
  // nothing.
  await appendAuditEvent(env, entry({ ...asked, outcome: "attempted" }));
  const db = drizzle(env.DB);
  let done: Written;
  try {
    done = await writeFor(env, caller, operation, input, change);
  } catch (error) {
    const refused = inHostWords(error);
    await keepAuditEvent(
      env,
      db,
      entry({
        ...asked,
        outcome: "refused",
        reason: isExpectedError(refused) ? refused.code : "internal.unexpected",
      })
    );
    throw refused;
  }
  const outcome = entry({ ...asked, outcome: "done", ...done.detail });
  if (done.at === undefined) {
    // Nothing changed (none of the App's to forget): one outcome a call.
    await keepAuditEvent(env, db, outcome);
    return done.answer;
  }
  // One `done` per change, whole: its ID from the change, its time what
  // the store recorded, the rest the change's too, so the same call made
  // again, after the first was drained, is the event the log holds.
  await keepEvent(env, db, {
    ...createAuditEvent(outcome, "core"),
    id: uuidFromHash(await sha256Hex(JSON.stringify([action, change]))),
    at: done.at.toISOString(),
  });
  return done.answer;
};
