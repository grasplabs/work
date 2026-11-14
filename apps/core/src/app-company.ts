import type { AppId } from "@grasp-os/shared/ids";
import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { isOpenToUsers } from "./app-access.ts";
import { readableByEveryMember, sourcesOf } from "./app-provenance.ts";
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

// Whether everything an App holds is the whole company's (GRA-1837,
// review round 1): what its code writes to the Brain is read by every
// member, so it may write only what every member could already read
// through the App. The App's data and what people type into it are its
// own and tracked by nothing else, so the App itself must be the
// company's: live, everyone in the organization with a role in it, every
// one of its tables readable by every one of them, and every source it
// may have read readable by every member (app-provenance.ts, which reads
// Knowledge's collections too: that part leaves with Knowledge, GRA-1735).
// Decided at each write, from the App's current version and whom it is
// shared with now; anything it can't read answers no.

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
 * Whether everything App `app` holds now is the whole company's (above):
 * false for an App that isn't there, isn't live, or anything not read.
 */
export const heldByTheWholeCompany = async (
  env: Env,
  app: AppId
): Promise<boolean> => {
  try {
    const row = await drizzle(env.DB)
      .select({
        owner: apps.ownerId,
        currentVersion: apps.currentVersion,
        archivedAt: apps.archivedAt,
      })
      .from(apps)
      .where(eq(apps.id, app))
      .get();
    if (
      row?.currentVersion === null ||
      row?.currentVersion === undefined ||
      !isOpenToUsers({
        currentVersion: row.currentVersion,
        archived: row.archivedAt !== null,
      })
    ) {
      return false;
    }
    const [shared, tables, sources] = await Promise.all([
      sharedWithEveryMember(env, app, row.owner),
      tablesReadByEveryMember(env, app, row.currentVersion),
      sourcesOf(env, app),
    ]);
    return shared && tables && readableByEveryMember(sources);
  } catch {
    // What can't be read can't be shown to be the company's.
    return false;
  }
};
