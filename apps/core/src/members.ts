import type { AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import {
  disconnectPersonalMaxOwners,
  oauthFlowLifetimeMs,
} from "@grasp-os/shared/connect";
import type { CodedError } from "@grasp-os/shared/errors";
import { appIdSchema, identifierSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { memberErrors } from "@grasp-os/shared/members";
import type { Invitation, Member, MembersApi } from "@grasp-os/shared/members";
import {
  canBuild,
  isAdmin,
  roleErrors,
  roleSchema,
} from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  accessMayHaveDropped,
  appsSharedWithAnyone,
  withRetries,
} from "./access-revocations.ts";
import { appsFoundBy } from "./app-access.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  activeAdminExists,
  activeMember,
  currentMembership,
  isRemoved,
  notRemoved,
  openInvitationAt,
  organizationId,
} from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { teamsOf } from "./auth/identity.ts";
import { revokeChatPermissions } from "./chat-connections.ts";
import { personOf } from "./connections.ts";
import {
  apps,
  invitations,
  memberRemovals,
  members,
  notifications,
  sessions,
  teamMembers,
  users,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Offboarding (threat model ID4): an admin removes someone from the
// organization, or ends their sessions. Sessions are rows Better Auth reads
// on every request, and every `/rpc` call reads the session again
// (`identify`), so deleting them fails the person's next call and closes
// the connection it came over. A removal also records the removal marker,
// which keeps them out of every sign-in after (`ensureMember`), and makes
// whatever still acts for them (App and agent stubs, and so workflow runs,
// decision Q10) fail with `permission.person_inactive`, since each call
// checks the person is still a member.
//
// Only the client's own admins offboard: Grasp staff are no members, and
// who works for the client is the client's decision.
//
// The organization always keeps an admin: every change of a membership or
// a role is one conditional statement here that also requires the admin
// making it still to be one. Better Auth's member routes are off
// (`routes.ts`), since they read, then write.

/** Logs a refusal, IDs only, and hands back the error to throw. */
const refusal = (by: Identity, error: CodedError): CodedError => {
  log.warn("member.refused", { actor: by.userId, reason: error.code });
  return error;
};

/**
 * Refuses anyone but a member who is an admin: `requireAdmin`
 * (@grasp-os/shared/roles), but also refusing Grasp staff, and logged.
 */
const requireMemberAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
};

/**
 * The person an admin names, as the client sent it: never the admin
 * themselves, so nobody locks themselves out, and so every removal leaves
 * the admin who made it, keeping the organization from losing its last
 * admin.
 */
const targetOf = (by: Identity, userId: unknown): string => {
  const parsed = identifierSchema.safeParse(userId);
  if (!parsed.success) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  if (parsed.data === by.userId) {
    throw refusal(by, memberErrors.create("member.self"));
  }
  return parsed.data;
};

/** The current membership of `userId`, read now. */
const membershipOf = async (
  env: Env,
  userId: string
): Promise<{ id: string; role: string } | undefined> => {
  const [membership] = await drizzle(env.DB)
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(currentMembership(userId));
  return membership;
};

/**
 * The Apps `userId` has a role in as a member in role `role`, with the
 * teams they are in now (app-access.ts): what removing them or lowering
 * their role can take away, for those Apps' hosts to tell their open
 * screens (access-revocations.ts). Read before the change.
 */
const appsReachedBy = async (
  env: Env,
  userId: string,
  role: string
): Promise<AppId[]> => {
  const known = roleSchema.safeParse(role);
  if (!known.success) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({ id: apps.id })
    .from(apps)
    .where(
      appsFoundBy(env, {
        userId,
        role: known.data,
        teams: await teamsOf(env.DB, userId),
      })
    );
  return rows.map(({ id }) => appIdSchema.parse(id));
};

/**
 * `appsReachedBy`, read before a change, or `undefined` when that read
 * fails: the change goes ahead all the same, and `tellReached` makes up
 * for it.
 */
const appsReachedBefore = async (
  env: Env,
  userId: string,
  role: string
): Promise<AppId[] | undefined> => {
  try {
    return await appsReachedBy(env, userId, role);
  } catch (error) {
    log.error("app.access_revocation_failed", errorFields(error));
    return undefined;
  }
};

/**
 * Tells the Apps `reached` before the change, and those `userId` reaches
 * in role `role` now (an App shared with them while it ran), that their
 * role there may have dropped. Never throws: the change has committed,
 * and what follows it must still run; a second look that fails tells
 * the first look's Apps all the same. When the first look failed
 * (`undefined`), every App shared with anyone is told too: a removal
 * deletes the person's teams, so the look after it can't find the Apps
 * they reached through them.
 */
const tellReached = async (
  env: Env,
  reached: readonly AppId[] | undefined,
  userId: string,
  role: string
): Promise<void> => {
  const looks = await Promise.allSettled([
    withRetries(async () => await appsReachedBy(env, userId, role)),
    reached === undefined
      ? withRetries(async () => await appsSharedWithAnyone(env))
      : Promise.resolve([]),
  ]);
  const found: AppId[] = [...(reached ?? [])];
  for (const look of looks) {
    if (look.status === "fulfilled") {
      found.push(...look.value);
    } else {
      log.error("app.access_revocation_failed", errorFields(look.reason));
    }
  }
  await accessMayHaveDropped(env, found, [userId]);
};

/** Whether going from role `from` to `to` can take a role in an App away. */
const lowers = (from: string, to: Role): boolean =>
  (isAdmin(from) && !isAdmin(to)) || (canBuild(from) && !canBuild(to));

/** That `userId` is an admin of the organization now, as a SQL condition. */
const isActiveAdmin = (userId: string): SQL => activeMember(userId, ["admin"]);

/** Whether `userId` is an admin of the organization now. */
const stillAdmin = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${isActiveAdmin(userId)} AS admin`
  );
  return row.admin === 1;
};

const memberEntry = (
  by: Identity,
  action: "member.removed" | "member.sessions.revoked",
  memberId: string,
  userId: string
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "member", id: memberId },
  detail: { userId },
});

/** The organization's members, by name. For admins. */
const listMembers = async (env: Env, by: Identity): Promise<Member[]> => {
  requireMemberAdmin(by);
  const rows = await drizzle(env.DB)
    .select({
      userId: members.userId,
      name: users.name,
      email: users.email,
      role: members.role,
      joinedAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, organizationId),
        notRemoved(members.userId)
      )
    )
    .orderBy(asc(users.name), asc(users.id));
  return rows.flatMap(({ role, joinedAt, ...member }) => {
    // A role that isn't ours gives no access, so it isn't listed as one.
    const parsed = roleSchema.safeParse(role);
    return parsed.success
      ? [{ ...member, role: parsed.data, joinedAt: joinedAt.toISOString() }]
      : [];
  });
};

/**
 * Records that `userId` is removed and deletes their membership, their team
 * memberships, every session and notification they have, with the audit
 * event, in one
 * batch. The marker goes in only while they are a member and the admin
 * still is one, checked in the same statement, so a removal racing any
 * other change of membership or role (see `setMemberRole`) never leaves
 * the organization without an admin: the admin making it is never the one
 * removed. Everything after it runs only once the marker is there.
 * Returns whether this call removed them.
 */
const recordRemoval = async (
  env: Env,
  by: Identity,
  userId: string,
  memberId: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const removed = sql`NOT ${notRemoved(userId)}`;
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(memberRemovals)
      .select(
        sql`SELECT ${organizationId}, ${userId}, ${Date.now()}, NULL
          WHERE ${activeMember(userId)} AND ${isActiveAdmin(by.userId)}`
      )
      .onConflictDoNothing()
      .returning({ userId: memberRemovals.userId }),
    outboxedIfChanged(db, memberEntry(by, "member.removed", memberId, userId)),
    db.delete(teamMembers).where(and(eq(teamMembers.userId, userId), removed)),
    db
      .delete(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          eq(members.userId, userId),
          removed
        )
      ),
    db.delete(sessions).where(and(eq(sessions.userId, userId), removed)),
    db
      .delete(notifications)
      .where(and(eq(notifications.personId, userId), removed)),
  ]);
  return inserted.length > 0;
};

/**
 * Records that connect completed disconnecting `userIds`, so the cron
 * trigger stops retrying them once a flow can no longer finish
 * (`retryDisconnects`).
 */
const markDisconnected = async (
  env: Env,
  userIds: readonly string[]
): Promise<void> => {
  await drizzle(env.DB)
    .update(memberRemovals)
    .set({ disconnectedAt: new Date() })
    .where(
      and(
        eq(memberRemovals.organizationId, organizationId),
        inList(memberRemovals.userId, userIds),
        isNull(memberRemovals.disconnectedAt)
      )
    );
};

/**
 * Disconnects the personal connections of someone removed, in connect,
 * which revokes each grant at its provider where it can, deletes the
 * tokens and spends their open OAuth flows. Their connections take no
 * calls for them anyway (they are no longer a member); this takes the
 * tokens out of the vault. First, what their chats' agent was granted or
 * asked for in their chats is revoked, audited (chat-connections.ts):
 * none of it holds for them anyway. What fails here, the cron trigger
 * retries (`retryDisconnects`), both parts: they are done only once both
 * are.
 */
const disconnectPersonal = async (
  env: Env,
  by: Identity,
  userId: string
): Promise<number> => {
  try {
    await revokeChatPermissions(
      env,
      { requestedBy: userId },
      { userId: by.userId, actor: actorOf(by) },
      "person_removed"
    );
    const { disconnected } = await env.CONNECT.disconnectPersonal({
      person: await personOf(env, by),
      ownerUserIds: [userId],
    });
    await markDisconnected(env, [userId]);
    return disconnected;
  } catch (error) {
    log.error("member.disconnect_failed", errorFields(error));
    throw memberErrors.create("member.connections_pending");
  }
};

/**
 * Removes `userId` from the organization for good (see `recordRemoval`),
 * then revokes what their chats' agent was granted or asked for there and
 * disconnects their personal connections (`disconnectPersonal`). Removing someone already
 * removed only does the second part again, so a removal whose disconnect
 * failed can also be finished by trying again.
 */
const removeMember = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<{ connectionsDisconnected: number }> => {
  requireMemberAdmin(by);
  const target = targetOf(by, userId);
  const membership = await membershipOf(env, target);
  if (membership) {
    const removedNow = await recordRemoval(env, by, target, membership.id);
    // Someone else's removal of them may have landed first; otherwise the
    // admin stopped being one since their session was checked.
    if (!(removedNow || (await isRemoved(env, target)))) {
      throw refusal(by, roleErrors.create("role.forbidden"));
    }
    if (removedNow) {
      // Every App shared with anyone, not only those a look before found:
      // the removal deletes their teams, one joined meanwhile included,
      // so no look before or after it finds every App they reached.
      await tellReached(env, undefined, target, membership.role);
    }
  } else if (!(await isRemoved(env, target))) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  return {
    connectionsDisconnected: await disconnectPersonal(env, by, target),
  };
};

/**
 * Ends every session of the member `userId`: their next call fails and
 * its connection closes. They stay a member and may sign in again. The
 * sessions go only while the admin still is one, checked in the same
 * statement as the delete.
 */
const revokeMemberSessions = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const target = targetOf(by, userId);
  const membership = await membershipOf(env, target);
  if (!membership) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  const db = drizzle(env.DB);
  const [ended] = await auditedBatch(env, db, [
    db
      .delete(sessions)
      .where(and(eq(sessions.userId, target), isActiveAdmin(by.userId)))
      .returning({ id: sessions.id }),
    outboxedIfChanged(
      db,
      memberEntry(by, "member.sessions.revoked", membership.id, target)
    ),
  ]);
  // Nothing ended: they had no session, or the admin no longer is one.
  if (ended.length === 0 && !(await stillAdmin(env, by.userId))) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
};

/**
 * Gives the member `userId` `role`, the admin themselves included. One
 * conditional update: it changes the role only while it still is the one
 * read here, so the event records the role it replaced, while the admin
 * still is one and, unless the new role is admin, while someone other than
 * `userId` is an admin too. Every change of membership or role goes through
 * a statement like it (`recordRemoval`), so however they race, the
 * organization keeps an admin. When another admin changed the role in
 * between, it changes nothing and says so: the admin sees the new role and
 * can try again.
 */
const setMemberRole = async (
  env: Env,
  by: Identity,
  userId: unknown,
  role: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const target = identifierSchema.safeParse(userId);
  const parsedRole = roleSchema.safeParse(role);
  if (!parsedRole.success) {
    throw refusal(by, memberErrors.create("member.role_invalid"));
  }
  const membership = target.success
    ? await membershipOf(env, target.data)
    : undefined;
  if (!(target.success && membership)) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  const newRole = parsedRole.data;
  if (membership.role === newRole) {
    return;
  }
  const reached = lowers(membership.role, newRole)
    ? await appsReachedBefore(env, target.data, membership.role)
    : [];
  const db = drizzle(env.DB);
  const keepsAnAdmin =
    newRole === "admin" ? sql`1` : activeAdminExists(target.data);
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(members)
      .set({ role: newRole })
      .where(
        and(
          currentMembership(target.data),
          eq(members.role, membership.role),
          isActiveAdmin(by.userId),
          keepsAnAdmin
        )
      )
      .returning({ id: members.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "member.role.updated",
      target: { type: "member", id: membership.id },
      detail: {
        userId: target.data,
        previousRole: membership.role,
        role: newRole,
      },
    }),
  ]);
  if (changed) {
    if (lowers(membership.role, newRole)) {
      await tellReached(env, reached, target.data, membership.role);
    }
    return;
  }
  const now = await membershipOf(env, target.data);
  if (!now) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  if (!(await stillAdmin(env, by.userId))) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
  if (now.role !== membership.role) {
    throw refusal(by, memberErrors.create("member.role_changed"));
  }
  throw refusal(by, memberErrors.create("member.last_admin"));
};

/** Most `disconnectPersonal` batches the cron trigger has in flight at once. */
const disconnectBatchesAtOnce = 4;

/**
 * Disconnects what is still connected for removed people: everyone whose
 * disconnect hasn't completed yet, however long ago they were removed and
 * however many there are, and everyone removed within the last OAuth flow
 * lifetime, completed or not. A flow the person took back before the
 * removal (taking it needs their session) can still finish into a
 * connection after their disconnect completed; the flow's lifetime bounds
 * that with room to spare. First it revokes what their chats' agent was
 * granted or asked for (as the system), as `disconnectPersonal` does, so
 * a removal whose revoke failed ends revoked too. When nobody is pending,
 * it doesn't call connect at all. The cron trigger calls it.
 */
export const retryDisconnects = async (env: Env): Promise<void> => {
  const pending = await drizzle(env.DB)
    .select({ userId: memberRemovals.userId })
    .from(memberRemovals)
    .where(
      and(
        eq(memberRemovals.organizationId, organizationId),
        or(
          isNull(memberRemovals.disconnectedAt),
          gt(
            memberRemovals.removedAt,
            new Date(Date.now() - oauthFlowLifetimeMs)
          )
        )
      )
    )
    .orderBy(asc(memberRemovals.removedAt), asc(memberRemovals.userId));
  const batches: string[][] = [];
  for (
    let start = 0;
    start < pending.length;
    start += disconnectPersonalMaxOwners
  ) {
    batches.push(
      pending
        .slice(start, start + disconnectPersonalMaxOwners)
        .map(({ userId }) => userId)
    );
  }
  // Each batch on its own, so one that fails doesn't hold up the rest; it
  // is tried again on the next run. A few at a time, from one shared list,
  // so a long backlog doesn't send connect every batch at once.
  const queue = batches.values();
  const disconnectNext = async (): Promise<void> => {
    for (const ownerUserIds of queue) {
      try {
        // Each person's revoke on its own: one that fails leaves that
        // person pending for the next run, and holds up nobody else.
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time per lane
        const revokes = await Promise.allSettled(
          ownerUserIds.map(
            async (requestedBy) =>
              await revokeChatPermissions(
                env,
                { requestedBy },
                { userId: null, actor: { type: "system" } },
                "person_removed"
              )
          )
        );
        const revoked = ownerUserIds.filter((_, index) => {
          const settled = revokes[index];
          if (settled?.status === "rejected") {
            log.error("member.revoke_failed", errorFields(settled.reason));
          }
          return settled?.status === "fulfilled";
        });
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time per lane
        await env.CONNECT.disconnectPersonal({ person: null, ownerUserIds });
        if (revoked.length > 0) {
          // oxlint-disable-next-line no-await-in-loop -- one batch at a time per lane
          await markDisconnected(env, revoked);
        }
      } catch (error) {
        log.error("member.disconnect_failed", errorFields(error));
      }
    }
  };
  await Promise.all(
    Array.from({ length: disconnectBatchesAtOnce }, disconnectNext)
  );
};

// Invitations: people join by signing in through the organization's IdP,
// as users, so an invitation is an admin naming the role someone gets on
// that first sign-in (`ensureMember`, auth.ts). Grasp sends no email.
// They live in Better Auth's `invitations` table, whose routes stay off
// (routes.ts): each change here is one conditional statement, audited,
// that also requires the admin making it still to be one. Events carry
// the invitation's ID and role, never the address.

/** How long an invitation can be taken up: after that, they join as users. */
const invitationLifetimeMs = 30 * 24 * 60 * 60 * 1000;

const inviteEmailSchema = z.email().max(254).toLowerCase();

/** The lowercased domain of `email`, as sign-in reads it (claims.ts). */
const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1);

/** That an account with `email` holds a membership now, as SQL. */
const isMemberEmail = (email: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${members} JOIN ${users} ON ${users.id} = ${members.userId}
  WHERE ${members.organizationId} = ${organizationId}
    AND lower(${users.email}) = ${email}
)`;

/** That an admin removed an account with `email`, as SQL. */
const isRemovedEmail = (email: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${memberRemovals}
    JOIN ${users} ON ${users.id} = ${memberRemovals.userId}
  WHERE ${memberRemovals.organizationId} = ${organizationId}
    AND lower(${users.email}) = ${email}
)`;

/** That `email` has an open invitation at `now` (`openInvitationAt`), as SQL. */
const isInvitedEmail = (email: string, now: Date): SQL => sql`EXISTS (
  SELECT 1 FROM ${invitations}
  WHERE ${invitations.email} = ${email} AND ${openInvitationAt(now.getTime())}
)`;

/** The organization's open invitations, newest first. For admins. */
const listInvitations = async (
  env: Env,
  by: Identity
): Promise<Invitation[]> => {
  requireMemberAdmin(by);
  const rows = await drizzle(env.DB)
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      invitedBy: users.name,
      invitedAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(openInvitationAt(Date.now()))
    .orderBy(desc(invitations.createdAt), asc(invitations.id));
  return rows.flatMap(({ role, invitedAt, expiresAt, ...invitation }) => {
    const parsed = roleSchema.safeParse(role);
    return parsed.success
      ? [
          {
            ...invitation,
            role: parsed.data,
            invitedAt: invitedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
        ]
      : [];
  });
};

/** Why an invitation of `email` went in nowhere, read after the fact. */
const inviteRefusal = async (
  env: Env,
  email: string,
  now: Date
): Promise<CodedError> => {
  const row = await drizzle(env.DB).get<{
    member: number;
    removed: number;
    invited: number;
  }>(
    sql`SELECT ${isMemberEmail(email)} AS member,
      ${isRemovedEmail(email)} AS removed,
      ${isInvitedEmail(email, now)} AS invited`
  );
  if (row.removed === 1) {
    return memberErrors.create("member.invite_removed");
  }
  if (row.member === 1) {
    return memberErrors.create("member.invite_member");
  }
  if (row.invited === 1) {
    return memberErrors.create("member.invite_pending");
  }
  return roleErrors.create("role.forbidden");
};

/**
 * Invites `email` as `role`. One statement puts it in, and only while
 * nobody with that address is a member or removed, nobody invited them
 * already, and the admin still is one, so two admins inviting the same
 * person at once make one invitation.
 */
const inviteMember = async (
  env: Env,
  by: Identity,
  email: unknown,
  role: unknown
): Promise<Invitation> => {
  requireMemberAdmin(by);
  const parsedRole = roleSchema.safeParse(role);
  if (!parsedRole.success) {
    throw refusal(by, memberErrors.create("member.role_invalid"));
  }
  const address = inviteEmailSchema.safeParse(
    typeof email === "string" ? email.trim() : email
  );
  const domains = signInConfig(env)?.domains ?? [];
  if (!(address.success && domains.includes(domainOf(address.data)))) {
    throw refusal(by, memberErrors.create("member.invite_email"));
  }
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(invitations)
      .select(
        sql`SELECT ${id}, ${organizationId}, ${address.data}, ${parsedRole.data},
          NULL, 'pending', ${expiresAt.getTime()}, ${now.getTime()}, ${by.userId}
          WHERE NOT ${isMemberEmail(address.data)}
            AND NOT ${isRemovedEmail(address.data)}
            AND NOT ${isInvitedEmail(address.data, now)}
            AND ${isActiveAdmin(by.userId)}`
      )
      .returning({ id: invitations.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "member.invited",
      target: { type: "invitation", id },
      detail: { role: parsedRole.data },
    }),
  ]);
  if (inserted.length === 0) {
    throw refusal(by, await inviteRefusal(env, address.data, now));
  }
  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, by.userId));
  return {
    id,
    email: address.data,
    role: parsedRole.data,
    invitedBy: inviter?.name ?? "",
    invitedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
};

/**
 * Withdraws the invitation `invitationId` while nobody has taken it up and
 * the admin still is one, in one statement.
 */
const withdrawInvitation = async (
  env: Env,
  by: Identity,
  invitationId: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const parsed = identifierSchema.safeParse(invitationId);
  if (!parsed.success) {
    throw refusal(by, memberErrors.create("member.invitation_not_found"));
  }
  const db = drizzle(env.DB);
  const [invitation] = await db
    .select({ role: invitations.role })
    .from(invitations)
    .where(
      and(
        eq(invitations.id, parsed.data),
        eq(invitations.organizationId, organizationId),
        eq(invitations.status, "pending")
      )
    );
  if (!invitation) {
    throw refusal(by, memberErrors.create("member.invitation_not_found"));
  }
  const [withdrawn] = await auditedBatch(env, db, [
    db
      .update(invitations)
      .set({ status: "canceled" })
      .where(
        and(
          eq(invitations.id, parsed.data),
          eq(invitations.organizationId, organizationId),
          eq(invitations.status, "pending"),
          isActiveAdmin(by.userId)
        )
      )
      .returning({ id: invitations.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "member.invitation.withdrawn",
      target: { type: "invitation", id: parsed.data },
      detail: { role: invitation.role },
    }),
  ]);
  if (withdrawn.length > 0) {
    return;
  }
  throw refusal(
    by,
    (await stillAdmin(env, by.userId))
      ? memberErrors.create("member.invitation_not_found")
      : roleErrors.create("role.forbidden")
  );
};

/**
 * A signed-in admin's `members`. Every call checks the session first,
 * then the caller's role.
 */
export class MembersRpc extends CoreRpcTarget implements MembersApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<Member[]> {
    return await withPerson(
      this.#check,
      async (person) => await listMembers(this.#env, person)
    );
  }

  async remove(userId: string): Promise<{ connectionsDisconnected: number }> {
    return await withPerson(
      this.#check,
      async (person) => await removeMember(this.#env, person, userId)
    );
  }

  async revokeSessions(userId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await revokeMemberSessions(this.#env, person, userId);
    });
  }

  async setRole(userId: string, role: Role): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await setMemberRole(this.#env, person, userId, role);
    });
  }

  async invitations(): Promise<Invitation[]> {
    return await withPerson(
      this.#check,
      async (person) => await listInvitations(this.#env, person)
    );
  }

  async invite(email: string, role: Role): Promise<Invitation> {
    return await withPerson(
      this.#check,
      async (person) => await inviteMember(this.#env, person, email, role)
    );
  }

  async withdrawInvitation(invitationId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await withdrawInvitation(this.#env, person, invitationId);
    });
  }
}
