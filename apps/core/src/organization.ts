import { actorOf } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import {
  organizationErrors,
  organizationNameSchema,
  organizationTimeZoneSchema,
} from "@grasp-os/shared/organization";
import type {
  Organization,
  OrganizationApi,
  OrganizationChanges,
} from "@grasp-os/shared/organization";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { defaultTimeZone } from "@grasp-os/shared/workflows";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { organizations } from "./db/core/schema.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The organization's own settings, as the prototype's Workspace section
// has them (`routes/settings/workspace.tsx`): its name and the time zone
// it works in, which its admins change, and where its data lives, which
// the deployment decides. Grasp staff are admins, but what the client is
// called and when its day starts are the client's to say.

/** The organization as stored, with what the deployment says about it. */
const readOrganization = async (env: Env): Promise<Organization> => {
  const [row] = await drizzle(env.DB)
    .select({ name: organizations.name, timeZone: organizations.timeZone })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return {
    name: row?.name ?? "",
    timeZone: row?.timeZone ?? defaultTimeZone,
    dataRegion: "eu",
    signInDomains: signInConfig(env)?.domains ?? [],
  };
};

const changesSchema = z
  .object({ name: z.unknown(), timeZone: z.unknown() })
  .partial();

/** `changes`, checked: each field given must be valid. */
const parseChanges = (
  changes: unknown
): { name?: string; timeZone?: string } => {
  const shape = changesSchema.safeParse(changes);
  if (!shape.success) {
    throw organizationErrors.create("organization.changes_invalid");
  }
  const { name, timeZone } = shape.data;
  const parsedName =
    name === undefined ? undefined : organizationNameSchema.safeParse(name);
  if (parsedName?.success === false) {
    throw organizationErrors.create("organization.name_invalid");
  }
  const parsedZone =
    timeZone === undefined
      ? undefined
      : organizationTimeZoneSchema.safeParse(timeZone);
  if (parsedZone?.success === false) {
    throw organizationErrors.create("organization.time_zone_invalid");
  }
  return {
    ...(parsedName === undefined ? {} : { name: parsedName.data }),
    ...(parsedZone === undefined ? {} : { timeZone: parsedZone.data }),
  };
};

/** Whether `userId` is an admin of the organization now. */
const stillAdmin = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${activeMember(userId, ["admin"])} AS admin`
  );
  return row.admin === 1;
};

/**
 * Changes the organization's name, time zone or both, in one batch: each
 * one statement that changes it only while it differs and the admin still
 * is one, followed by its audit event, recorded only when it changed. So
 * two admins saving the same value at once record one change. The events
 * record the time zone, never the name.
 */
const updateOrganization = async (
  env: Env,
  by: Identity,
  changes: unknown
): Promise<Organization> => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("organization.refused", { actor: by.userId });
    throw roleErrors.create("role.forbidden");
  }
  const { name, timeZone } = parseChanges(changes);
  const db = drizzle(env.DB);
  const admin = activeMember(by.userId, ["admin"]);
  const ofOrganization = eq(organizations.id, organizationId);
  const target = { type: "organization", id: organizationId };
  const renames =
    name === undefined
      ? []
      : ([
          db
            .update(organizations)
            .set({ name })
            .where(and(ofOrganization, ne(organizations.name, name), admin))
            .returning({ id: organizations.id }),
          outboxedIfChanged(db, {
            actor: actorOf(by),
            action: "organization.renamed",
            target,
          }),
        ] as const);
  const rezones =
    timeZone === undefined
      ? []
      : ([
          db
            .update(organizations)
            .set({ timeZone })
            .where(
              and(
                ofOrganization,
                sql`coalesce(${organizations.timeZone}, ${defaultTimeZone}) <> ${timeZone}`,
                admin
              )
            )
            .returning({ id: organizations.id }),
          outboxedIfChanged(db, {
            actor: actorOf(by),
            action: "organization.time_zone.updated",
            target,
            detail: { timeZone },
          }),
        ] as const);
  const [first, ...rest] = [...renames, ...rezones];
  if (first === undefined) {
    return await readOrganization(env);
  }
  const results = await auditedBatch(env, db, [first, ...rest]);
  const changed = results.some(
    (result) => Array.isArray(result) && result.length > 0
  );
  // Nothing changed: it already was so, or the admin stopped being one
  // since their session was checked.
  if (!(changed || (await stillAdmin(env, by.userId)))) {
    throw roleErrors.create("role.forbidden");
  }
  return await readOrganization(env);
};

/** A signed-in person's `organization`. */
export class OrganizationRpc extends CoreRpcTarget implements OrganizationApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async get(): Promise<Organization> {
    return await withPerson(
      this.#check,
      async () => await readOrganization(this.#env)
    );
  }

  async update(changes: OrganizationChanges): Promise<Organization> {
    return await withPerson(
      this.#check,
      async (person) => await updateOrganization(this.#env, person, changes)
    );
  }
}
