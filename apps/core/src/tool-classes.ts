import { actorOf } from "@grasp-os/shared/audit";
import {
  companyToolClassSchema,
  companyToolClasses,
  connectErrors,
  connectionErrors,
  defaultToolClassAudiences,
  toolClassAudienceSchema,
  toolClasses,
} from "@grasp-os/shared/connect";
import type {
  CompanyToolClass,
  ConnectionOwner,
  ToolClass,
  ToolClassAudience,
  ToolClassSetting,
} from "@grasp-os/shared/connect";
import type { PermissionObject, Authority } from "@grasp-os/shared/permissions";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  appPointers,
  appToolClasses,
  sharedMailboxPointers,
  teamMembers,
  teams,
  toolClassSettings,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { nativeToolClasses } from "./native-tool-classes.gen.ts";

// Which classes of tools a company turned on, and for whom (D11, D13 in
// GRA-699): the record an admin keeps, and the check core makes before it
// signs a call of the chat's agent for connect. A call of a class that is
// off for the person the agent acts for never reaches connect: refused
// here, with an error the agent reads (`connect.class_off`). The ways it
// can fail, which the tests start from: a class that is off reaches connect
// anyway; a tool nobody classed counts as a harmless one; a change of
// class leaves no trace, or is made by someone other than the company's own
// admins (staff included); a class on for some teams lets everyone in.
//
// It binds the chat's agent only, wherever it works (the web chat, a chat
// app), not Apps or workflows: their admins approve each binding, tool by
// tool, and gating them by class too would break the reads they do today.

type ConnectionObject = Extract<PermissionObject, { type: "connection" }>;

const toolClassSchema = z.enum(toolClasses);

/**
 * Each native tool's class, by its provider, then its name, read from the
 * generated table and checked: a value that isn't a class stops core from
 * loading rather than letting the tool through.
 */
export const nativeClasses: ReadonlyMap<
  string,
  ReadonlyMap<string, ToolClass>
> = new Map(
  Object.entries(nativeToolClasses).map(([provider, tools]) => [
    provider,
    new Map(
      Object.entries(tools).map(([tool, toolClass]) => [
        tool,
        toolClassSchema.parse(toolClass),
      ])
    ),
  ])
);

/** A stored row's teams: a JSON array of team IDs, or nothing it can read. */
export const storedTeamsSchema = z.array(z.string());

/** A stored row as the audience it records, or `undefined` if unreadable. */
export const audienceOf = (row: {
  who: string;
  teams: string;
}): ToolClassAudience | undefined => {
  let teamIds: unknown;
  try {
    teamIds = row.who === "teams" ? JSON.parse(row.teams) : undefined;
  } catch {
    return undefined;
  }
  const parsed = toolClassAudienceSchema.safeParse(
    row.who === "teams"
      ? { who: "teams", teams: storedTeamsSchema.safeParse(teamIds).data }
      : { who: row.who }
  );
  return parsed.success ? parsed.data : undefined;
};

/** Off, for a row that can't be read: never more than the admin chose. */
export const off: ToolClassAudience = { who: "nobody" };

/** Every class the company turns on or off, as it has them now. */
export const readToolClasses = async (
  env: Env
): Promise<ToolClassSetting[]> => {
  const rows = await drizzle(env.DB).select().from(toolClassSettings);
  const stored = new Map(rows.map((row) => [row.toolClass, row]));
  return companyToolClasses.map((toolClass) => {
    const row = stored.get(toolClass);
    if (row === undefined) {
      return {
        toolClass,
        audience: defaultToolClassAudiences[toolClass],
        changedBy: null,
        changedAt: null,
      };
    }
    return {
      toolClass,
      audience: audienceOf(row) ?? off,
      changedBy: row.changedBy,
      changedAt: row.changedAt.toISOString(),
    };
  });
};

/**
 * The classes on for anyone in the company now: what a suite's consent
 * asks the rights of (connect's provider-rights.ts).
 */
export const classesOn = async (env: Env): Promise<CompanyToolClass[]> => {
  const settings = await readToolClasses(env);
  return settings
    .filter(({ audience }) => audience.who !== "nobody")
    .map(({ toolClass }) => toolClass);
};

/** `audience` as stored: its `who`, and its teams sorted, each once. */
export const storedOf = (
  audience: ToolClassAudience
): { who: ToolClassAudience["who"]; teams: string } => ({
  who: audience.who,
  teams: JSON.stringify(
    audience.who === "teams" ? [...new Set(audience.teams)].toSorted() : []
  ),
});

/**
 * Whether the company points Stephen at a shared mailbox for anyone
 * (shared-mailboxes.ts): Microsoft 365 is then asked for shared
 * mailboxes' rights too.
 */
export const anyMailboxPointed = async (env: Env): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ mailbox: sharedMailboxPointers.mailbox })
    .from(sharedMailboxPointers)
    .where(ne(sharedMailboxPointers.who, "nobody"))
    .limit(1)
    .get();
  return row !== undefined;
};

/**
 * Turns `toolClass` on for everyone or some teams, or off. Admins only, and
 * never Grasp staff, who are admins but never decide what a client's
 * agent may do; every change is audited, and one that changes nothing
 * records nothing. Throws `connection.invalid` for a class or audience that
 * isn't one, or a team the company doesn't have.
 */
export const setToolClass = async (
  env: Env,
  identity: Identity,
  toolClass: unknown,
  audience: unknown
): Promise<void> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const parsedClass = companyToolClassSchema.safeParse(toolClass);
  const parsedAudience = toolClassAudienceSchema.safeParse(audience);
  if (!(parsedClass.success && parsedAudience.success)) {
    throw connectionErrors.create("connection.invalid");
  }
  const stored = storedOf(parsedAudience.data);
  const teamIds = storedTeamsSchema.parse(JSON.parse(stored.teams));
  const db = drizzle(env.DB);
  if (teamIds.length > 0) {
    const known = await db
      .select({ id: teams.id })
      .from(teams)
      .where(inList(teams.id, teamIds));
    if (known.length !== teamIds.length) {
      throw connectionErrors.create("connection.invalid");
    }
  }
  const settings = await readToolClasses(env);
  const current = settings.find(
    (setting) => setting.toolClass === parsedClass.data
  );
  if (
    current !== undefined &&
    current.changedBy === null &&
    JSON.stringify(storedOf(current.audience)) === JSON.stringify(stored)
  ) {
    // Setting the default it has: nothing changes, so nothing is recorded.
    return;
  }
  const detail: Record<string, string> = {
    toolClass: parsedClass.data,
    who: stored.who,
  };
  for (const [index, team] of teamIds.entries()) {
    detail[`team${index + 1}`] = team;
  }
  await auditedBatch(env, db, [
    db
      .insert(toolClassSettings)
      .values({
        toolClass: parsedClass.data,
        ...stored,
        changedBy: identity.userId,
        changedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: toolClassSettings.toolClass,
        set: {
          ...stored,
          changedBy: identity.userId,
          changedAt: new Date(),
        },
        // Only a different audience is a change: the same one again leaves
        // the row, and so the log, as it was.
        setWhere: or(
          sql`${toolClassSettings.who} IS NOT ${stored.who}`,
          sql`${toolClassSettings.teams} IS NOT ${stored.teams}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "connection.class.changed",
      target: { type: "tool_class", id: parsedClass.data },
      detail,
    }),
  ]);
  if (stored.who !== "nobody") {
    // A class on for anyone asks the grants that lack its rights to be
    // given again (GRA-717): its own rights, not every class's, so a grant
    // made before them isn't asked again for a class that was on already.
    // Asked even when nothing changed here, so an admin who sets it again
    // after a failure here gets it done.
    await env.CONNECT.requireClassRights({
      classes: [parsedClass.data],
      sharedMailbox: await anyMailboxPointed(env),
    });
  }
};

/** The audience `toolClass` has now: its row's, or the default. */
const audienceNow = async (
  env: Env,
  toolClass: CompanyToolClass
): Promise<ToolClassAudience> => {
  const row = await drizzle(env.DB)
    .select({ who: toolClassSettings.who, teams: toolClassSettings.teams })
    .from(toolClassSettings)
    .where(eq(toolClassSettings.toolClass, toolClass))
    .get();
  if (row === undefined) {
    return defaultToolClassAudiences[toolClass];
  }
  return audienceOf(row) ?? off;
};

/**
 * For whom `app` narrows `toolClass` now: `undefined` while it has it as
 * the class is, off for a row that can't be read.
 */
const appAudienceNow = async (
  env: Env,
  app: string,
  toolClass: CompanyToolClass
): Promise<ToolClassAudience | undefined> => {
  const row = await drizzle(env.DB)
    .select({ who: appToolClasses.who, teams: appToolClasses.teams })
    .from(appToolClasses)
    .where(
      and(eq(appToolClasses.app, app), eq(appToolClasses.toolClass, toolClass))
    )
    .get();
  if (row === undefined || row.who === "asClass") {
    return undefined;
  }
  return audienceOf(row) ?? off;
};

/** Whether `audience` takes in the person `userId`. */
export const takesIn = async (
  env: Env,
  audience: ToolClassAudience,
  userId: string
): Promise<boolean> => {
  if (audience.who !== "teams") {
    return audience.who === "everyone";
  }
  const membership = await drizzle(env.DB)
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        inList(teamMembers.teamId, audience.teams)
      )
    )
    .get();
  return membership !== undefined;
};

/**
 * What core signs into the capability of a call it let through: for a read
 * in a company app pointed at within some resources, those resources.
 */
export interface ClassedCall {
  resources?: string[];
}

/**
 * The pointer at the company app `connectionId` that takes in the person
 * `userId` (app-pointers.ts), if there is one: the resources it names.
 */
export const appPointerFor = async (
  env: Env,
  connectionId: string,
  userId: string
): Promise<{ resources: string[] } | undefined> => {
  const row = await drizzle(env.DB)
    .select()
    .from(appPointers)
    .where(eq(appPointers.connectionId, connectionId))
    .get();
  const audience = row === undefined ? undefined : audienceOf(row);
  if (
    row === undefined ||
    audience === undefined ||
    !(await takesIn(env, audience, userId))
  ) {
    return undefined;
  }
  let resources: unknown;
  try {
    resources = JSON.parse(row.resources);
  } catch {
    // Unreadable: no pointer, never more than the admin chose.
    return undefined;
  }
  const parsed = storedTeamsSchema.safeParse(resources);
  return parsed.success ? { resources: parsed.data } : undefined;
};

/**
 * Refuses the chat's agent's call of a company app's tool (a Composio
 * one) whose class is off for its person: by the class connect takes the
 * tool to be (`ConnectionOwner.toolClasses`), `connect.class_unknown` for
 * one it doesn't offer. Reading there is Read company, which an admin
 * turns on app by app, by pointing the agent at it (`appPointerFor`):
 * `connect.app_not_pointed` without a pointer for its person. The rest
 * follow the company's classes.
 */
const requireAppClassOn = async (
  env: Env,
  authority: Authority,
  owner: ConnectionOwner,
  action: string
): Promise<ClassedCall> => {
  const toolClass =
    owner.toolClasses !== undefined && Object.hasOwn(owner.toolClasses, action)
      ? owner.toolClasses[action]
      : undefined;
  if (toolClass === undefined) {
    throw connectErrors.create("connect.class_unknown");
  }
  if (toolClass === "read-company") {
    const pointer = await appPointerFor(env, owner.id, authority.onBehalfOf);
    if (pointer === undefined) {
      throw connectErrors.create("connect.app_not_pointed");
    }
    return pointer.resources.length === 0
      ? {}
      : { resources: pointer.resources };
  }
  const audience = await audienceNow(env, toolClass);
  if (!(await takesIn(env, audience, authority.onBehalfOf))) {
    throw connectErrors.create("connect.class_off");
  }
  return {};
};

/** A mail tool's class in its person's own mailbox. */
const inOwnMailbox: Readonly<Record<CompanyToolClass, CompanyToolClass>> = {
  "read-own": "read-own",
  "read-company": "read-own",
  "change-own": "change-own",
  "change-company": "change-own",
  "reach-others": "reach-others",
};

/**
 * Refuses a call of the chat's agent whose class is off for the person it
 * acts for, before core signs anything for connect: `connect.class_off`.
 * A native tool missing from the generated table, or classed `never`, is
 * refused whatever the company turned on (`connect.class_unknown`,
 * `connect.class_off`); a connection connect doesn't know, with
 * `connect.connection_not_found`. Apps and workflows aren't gated.
 */
export const requireToolClassOn = async (
  env: Env,
  authority: Authority,
  connection: ConnectionObject,
  action: string
): Promise<ClassedCall> => {
  if (authority.subject.type !== "agent") {
    return {};
  }
  const [owner] = await env.CONNECT.connectionOwners([connection.connectionId]);
  if (owner === undefined) {
    throw connectErrors.create("connect.connection_not_found");
  }
  if (owner.source === "composio") {
    return await requireAppClassOn(env, authority, owner, action);
  }
  const toolClass = nativeClasses.get(owner.provider)?.get(action);
  if (toolClass === undefined) {
    throw connectErrors.create("connect.class_unknown");
  }
  if (toolClass === "never") {
    throw connectErrors.create("connect.class_off");
  }
  // A Microsoft 365 mail tool takes any mailbox the account may open: the
  // mailbox it reaches is checked in connect, which knows it (its own, or
  // one the company pointed the agent at: shared-mailboxes.ts), so here
  // it has the class it has in the person's own mailbox.
  const mailTool = owner.provider === "microsoft" && action.startsWith("mail.");
  const audience = await audienceNow(
    env,
    mailTool ? inOwnMailbox[toolClass] : toolClass
  );
  if (!(await takesIn(env, audience, authority.onBehalfOf))) {
    throw connectErrors.create("connect.class_off");
  }
  // An app only narrows its classes (Settings › Stephen, stephen-reach.ts).
  const narrowed = await appAudienceNow(env, owner.provider, toolClass);
  if (
    narrowed !== undefined &&
    !(await takesIn(env, narrowed, authority.onBehalfOf))
  ) {
    throw connectErrors.create("connect.class_off");
  }
  return {};
};
