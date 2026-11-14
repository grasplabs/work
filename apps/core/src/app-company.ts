import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { isOpenToUsers } from "./app-access.ts";
import { holdingsOf, readableByEveryMember } from "./app-provenance.ts";
import { loadRelease } from "./app-releases.ts";
import { notRemoved, organizationId } from "./auth/auth.ts";
import {
  appMembers,
  apps,
  members,
  teamMembers,
  teams,
} from "./db/core/schema.ts";
import { viaProjectSql } from "./project-sql.ts";

// Whether everything code holds is the whole company's (GRA-1837,
// review rounds 1 and 2): what an App's action or a workflow's run writes
// to the Brain is read by every member, so it may write only what every
// member could already read. An App's data and what people type into it
// are tracked by nothing else, so every App it may hold data of must be
// the company's: everyone in the organization with a role in it, and
// every one of its tables readable by every one of them. Which those are
// is the provenance walk's (app-provenance.ts `holdingsOf`), closed over
// every grant that carries data to it, with every source it reaches
// readable by every member. Decided at each write, from each App's
// current version and whom it is shared with now; anything it can't read
// or place answers no.

/**
 * Whether every current member of the organization has a role in App
 * `app` now: an admin, its owner, or someone it is shared with as a
 * person, through a team they are in or through a project (sharing.ts
 * `rowsOf`). One statement, whatever the number of members: the first
 * member it doesn't reach answers no.
 */
const sharedWithEveryMember = async (
  env: Env,
  app: AppId,
  owner: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const unreached = await db
    .select({ userId: members.userId })
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        notRemoved(members.userId),
        ne(members.role, "admin"),
        ne(members.userId, owner),
        notExists(
          db
            .select({ one: sql`1` })
            .from(appMembers)
            .where(
              and(
                eq(appMembers.appId, app),
                or(
                  and(
                    eq(appMembers.memberType, "person"),
                    eq(appMembers.memberId, members.userId)
                  ),
                  and(
                    eq(appMembers.memberType, "team"),
                    inArray(
                      appMembers.memberId,
                      db
                        .select({ id: teamMembers.teamId })
                        .from(teamMembers)
                        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
                        .where(
                          and(
                            eq(teamMembers.userId, members.userId),
                            eq(teams.organizationId, organizationId)
                          )
                        )
                    )
                  ),
                  viaProjectSql(
                    appMembers.memberType,
                    appMembers.memberId,
                    members.userId
                  )
                )
              )
            )
        )
      )
    )
    .limit(1)
    .get();
  return unreached === undefined;
};

/**
 * Whether every member may read every table of `app`'s version
 * `version`: each read by the App's members (`appMembers`), and narrowed
 * by no row rule, unless one of its rules admits every role (`user`). A
 * table of owners' own rows, of builders' alone, read by nobody, or
 * narrowed to a person or a team, holds what not everyone may read.
 */
const tablesReadByEveryMember = async (
  env: Env,
  app: AppId,
  version: number
): Promise<boolean> => {
  const { app: manifest } = await loadRelease(env, app, version);
  return Object.values(manifest.schema.tables).every(
    ({ access, rules }) =>
      access.read === "appMembers" &&
      (rules?.read === undefined ||
        rules.read.some((rule) => rule.kind === "role" && rule.role === "user"))
  );
};

/**
 * Whether App `app` is the whole company's now: there, shared with every
 * member, and every table of its current version read by all of them.
 * One of no version (nothing published yet) can't be placed: no.
 */
const appIsTheCompanys = async (env: Env, app: AppId): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ owner: apps.ownerId, currentVersion: apps.currentVersion })
    .from(apps)
    .where(eq(apps.id, app))
    .get();
  if (row?.currentVersion === null || row?.currentVersion === undefined) {
    return false;
  }
  const [shared, tables] = await Promise.all([
    sharedWithEveryMember(env, app, row.owner),
    tablesReadByEveryMember(env, app, row.currentVersion),
  ]);
  return shared && tables;
};

/**
 * Whether everything `caller` holds now is the whole company's (above):
 * over everything the provenance walk reaches from it (app-provenance.ts
 * `holdingsOf`: the Apps and workflows whose data it may hold through
 * calls, starts, follows and events, both ways each grant carries data),
 * every source readable by every member, and every App among them the
 * company's (`appIsTheCompanys`). An App calling must also be live. No
 * for anything not read or not placed: an App the walk can't place, or a
 * walk past its caps, is an unresolved source.
 */
export const heldByTheWholeCompany = async (
  env: Env,
  caller: { readonly app: AppId } | { readonly workflow: string }
): Promise<boolean> => {
  try {
    if ("app" in caller) {
      const row = await drizzle(env.DB)
        .select({
          currentVersion: apps.currentVersion,
          archivedAt: apps.archivedAt,
        })
        .from(apps)
        .where(eq(apps.id, caller.app))
        .get();
      if (
        row === undefined ||
        !isOpenToUsers({
          currentVersion: row.currentVersion,
          archived: row.archivedAt !== null,
        })
      ) {
        return false;
      }
    }
    // Its sources and the Apps it reaches read Knowledge's collections
    // too (app-provenance.ts): that part leaves with Knowledge (GRA-1735).
    const { sources, apps: reached } = await holdingsOf(env, caller);
    if (!readableByEveryMember(sources)) {
      return false;
    }
    const each = await Promise.all(
      reached.map(
        async (app) => await appIsTheCompanys(env, appIdSchema.parse(app))
      )
    );
    return each.every(Boolean);
  } catch {
    // What can't be read can't be shown to be the company's.
    return false;
  }
};
