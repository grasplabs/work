import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import type { Roster } from "@grasp-os/shared/onboarding";
import { teamNameKey } from "@grasp-os/shared/onboarding";
import { clockLeaseMs } from "@grasp-os/workerflow/clock";
import type { SQL } from "drizzle-orm";
import { and, eq, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { revocationsOf, tellKept } from "./access-revocations.ts";
import { appsOwnedOrSharedNow } from "./app-access.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { providerIds } from "./auth/config.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import {
  accounts,
  staffListPlaced,
  retiredTeamIds,
  teamMembers,
  teamPrimaries,
  teams,
} from "./db/core/schema.ts";
import { chunks, inList } from "./db/d1.ts";
import { onboardingStore } from "./onboarding/store.ts";
import type { ConfirmedPlaces } from "./onboarding/store.ts";
import { comparable, provedSignInAccounts } from "./source-readers.ts";

// One list of teams with one id (GRA-2055): the onboarding's staff list
// names the members' teams (Better Auth's `teams`), never teams of its
// own. Its people stay its own (most have no account), and so do a team's
// lead, its description and whether it takes part, kept by the onboarding
// store beside the team under the team's id. The ways this can leak, and
// what stops each:
//
// - Someone placed in a team reads what the team's members read. Only an
//   admin's confirm places anyone (`placePrimaries`), never a draft save;
//   only a current member (not removed, checked in the statement itself),
//   found by what their sign-in proved (`provedMembersOf`, the reader
//   lists' proof): a Google address, or a Microsoft account by tenant and
//   object id against the one the directory read put on the entry; never
//   by `users.email`, Entra's `email` claim, a name or a directory
//   placeholder; every placement and removal audited.
// - Nothing automatic overrides what an admin did by hand (`placementOf`):
//   the list adds a membership only when the team it gives someone
//   changes, and takes away only one it made itself.
// - A deleted team's id coming back with what was shared with it: a team's
//   id is a members' team's, or one core made for the list
//   (`crypto.randomUUID`, marked `minted` in the store), never one a
//   request sent; a confirm makes a members' team only under a minted id,
//   and only under one D1 never retired: a trigger retires every deleted
//   team's id (`retired_team_ids`), whichever release's code deleted it.
// - A rename or a confirm splitting what one team holds: a team keeps one
//   id from the first save that names it, and everything keys by it.
// - A team the admin only drafted: made at the confirm, never before, so a
//   draft fixed before it leaves no team behind.

/** The open-page notices a leave keeps (`revocationsOf`), as its rows read back. */
const keptRowsSchema = z.array(
  z.object({
    id: z.string(),
    appId: z.string().nullable(),
    userIds: z.array(z.string()).nullable(),
    attempts: z.number(),
    createdAt: z.date(),
    afterAppId: z.string().nullable(),
  })
);

/** How many people's changes go in one batch: six statements each at most. */
const peoplePerBatch = 50;

/**
 * How long a placing holds its claim without renewing it: the clock's
 * own lease on a task, past which it is taken for dead.
 */
const leaseMs = clockLeaseMs;

/** What a staff-list change records as how it was made. */
const via = "staffList";

/** A team of the staff list the onboarding's store holds now. */
export interface HeldTeam {
  id: string;
  name: string;
  /** Whether core made its id for the list (`teams.minted`). */
  minted: boolean;
}

/**
 * `roster` with each of its teams under the one id it keeps for good
 * (GRA-2055): a members' team's, or one core made for the list (`minted`)
 * that the onboarding's store holds (`held`), by its id, else by its name
 * (trimmed, any case) where one alone has it and no other team on the list
 * took it; else a new id core makes, never the one the request sent. A held
 * id that is neither (a members' team deleted while a save ran) is never
 * kept: no deleted team's id comes back, with what was shared with it. The
 * id never changes after: a team new on a draft is kept under it in the
 * store, and once the admin confirms the list its members' team is made
 * under that same id, and named as the list names it, by that version's
 * placing (`teamsOf`), never here: nothing is written here, so a draft put
 * right before the confirm leaves no team in Settings › Members. Answers
 * the roster as the store keeps it, and the ids core made for it
 * (`minted`).
 */
export const intoMembersTeams = async (
  env: Env,
  roster: Roster,
  {
    held: heldNow,
  }: {
    /** The store's teams, read only after the members' teams are. */
    held: () => Promise<readonly HeldTeam[]>;
  }
): Promise<{ roster: Roster; minted: Set<string> }> => {
  const db = drizzle(env.DB);
  // The members' teams first, then the store's: a team deleted in between
  // is missing from the first read and so never kept by the second. No
  // test can pin this order; the insert's own guard below is what holds.
  const [existing, retired] = await db.batch([
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.organizationId, organizationId)),
    db.select({ id: retiredTeamIds.id }).from(retiredTeamIds),
  ]);
  const held = await heldNow();
  const known = new Map(existing.map(({ id, name }) => [id, name]));
  // A minted id whose team was deleted (retired) is never kept, and its
  // team gets a new id. What the store holds under the old id is left on
  // purpose: that team was deleted, and nothing of it may reach the new one.
  const deleted = new Set(retired.map(({ id }) => id));
  const mintedHeld = held.filter(
    ({ id, minted }) => minted && !known.has(id) && !deleted.has(id)
  );
  const kept = new Set([...known.keys(), ...mintedHeld.map(({ id }) => id)]);
  const byName = new Map<string, Set<string>>();
  for (const { id, name } of [...existing, ...mintedHeld]) {
    const key = teamNameKey(name);
    byName.set(key, (byName.get(key) ?? new Set()).add(id));
  }
  // Ids first, then names, so a team the list holds by its id is never
  // taken by another of the list's teams through its name.
  const taken = new Set(
    roster.teams.flatMap(({ id }) => (kept.has(id) ? [id] : []))
  );
  const idOf = new Map<string, string>();
  const mintedNow = new Set<string>();
  for (const team of roster.teams) {
    if (kept.has(team.id)) {
      idOf.set(team.id, team.id);
      continue;
    }
    const [named, ...others] = [
      ...(byName.get(teamNameKey(team.name)) ?? []),
    ].filter((id) => !taken.has(id));
    const id =
      named !== undefined && others.length === 0 ? named : crypto.randomUUID();
    if (id !== named) {
      mintedNow.add(id);
    }
    taken.add(id);
    idOf.set(team.id, id);
  }
  const listed = roster.teams.map((team) => ({
    ...team,
    id: idOf.get(team.id) ?? team.id,
  }));
  const wasMinted = new Set(mintedHeld.map(({ id }) => id));
  return {
    roster: {
      teams: listed,
      people: roster.people.map((person) => ({
        ...person,
        team: idOf.get(person.team) ?? person.team,
      })),
    },
    minted: new Set(
      listed.flatMap(({ id }) =>
        mintedNow.has(id) || wasMinted.has(id) ? [id] : []
      )
    ),
  };
};

/**
 * The key Better Auth gives a team membership, which its unique index on
 * `team_members.membership_key` keeps to one row per person and team:
 * SHA-256 of `[teamId, userId]` as JSON, base64url without padding, as its
 * organization plugin's `computeTeamMembershipKey` makes it (adapter.ts,
 * which it doesn't export).
 */
const membershipKeyOf = async (
  teamId: string,
  userId: string
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, userId]))
  );
  return btoa(String.fromCodePoint(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/**
 * The team the list last gave someone (their saved assignment): whether
 * the list made that membership itself, whether it is still to add
 * (`pending`), and what the list names them by.
 */
export interface Placed {
  teamId: string;
  made: boolean;
  pending: boolean;
  placeKey: PlaceKey;
}

/** One change the list makes to someone's teams, as `placementOf` decides it. */
interface Placement {
  userId: string;
  before: Placed | undefined;
  /** The team the list gives them now; none when it gives them none. */
  after: string | undefined;
  /** What the list names them by for `after`. */
  placeKey: PlaceKey | undefined;
  /** Whether their sign-in proves `placeKey` now: only then is a membership added. */
  proved: boolean;
  /** The key of the membership in `after` (`membershipKeyOf`). */
  key: string | undefined;
}

/**
 * The same team for `userId`, named by another key now (an address that
 * changed at Google and on the list): only the key their primary row keeps
 * changes, so an address that later goes to someone else never moves
 * them, and no membership an admin took away comes back.
 */
const rekeyOf = (
  db: DrizzleD1Database,
  userId: string,
  before: Placed | undefined,
  placeKey: PlaceKey | undefined,
  holds: SQL
): BatchItem<"sqlite">[] =>
  before !== undefined && placeKey !== undefined && before.placeKey !== placeKey
    ? [
        db
          .update(teamPrimaries)
          .set({ placeKey })
          .where(and(eq(teamPrimaries.userId, userId), holds)),
      ]
    : [];

/**
 * The staff list's rule for one person (GRA-2055), decided here alone:
 * nothing automatic overrides what an admin did by hand, and lack of proof
 * never takes anything away. The list touches someone's memberships only
 * when the team it gives them changes, from `before` to `after`: then it
 * takes away the old one only if it made it itself (`made`), never one an
 * admin added by hand, and adds the new one only while their sign-in
 * proves who they are (`proved`), recording whether it made it (an admin
 * may have added it already); unproved, the new team waits as `pending`,
 * added once they are proved. It never adds a membership in the team
 * their primary row already names, unless it is pending: an admin who
 * took that one away by hand keeps it away. Placings never interleave
 * (`placePrimaries`): each reads under its claim, so what it read stands;
 * what an admin does by hand meanwhile is checked in the statements
 * themselves. Every statement holds only while `holds` (the placing's
 * lease stands). The statements of one person go in one batch, a move's
 * leave and join together; a leave's open-page notice is kept in the
 * batch with it (`revocationsOf`).
 */
export const placementOf = (
  db: DrizzleD1Database,
  actor: AuditActor,
  { userId, before, after, placeKey, proved, key }: Placement,
  now: Date,
  holds: SQL
): { statements: BatchItem<"sqlite">[]; leaves: boolean } => {
  const moved = before?.teamId !== after;
  const joins =
    after !== undefined &&
    placeKey !== undefined &&
    key !== undefined &&
    proved &&
    (moved || before?.pending === true);
  const waits =
    after !== undefined && placeKey !== undefined && !proved && moved;
  if (!(moved || joins)) {
    return {
      statements: rekeyOf(db, userId, before, placeKey, holds),
      leaves: false,
    };
  }
  const entry = (
    action: "team.member.added" | "team.member.removed",
    teamId: string
  ): AuditEntry => ({
    actor,
    action,
    target: { type: "team", id: teamId },
    detail: { userId, via },
  });
  const leave =
    before === undefined || !moved
      ? []
      : (() => {
          const listMade = sql`EXISTS (SELECT 1 FROM ${teamPrimaries} WHERE ${teamPrimaries.userId} = ${userId} AND ${teamPrimaries.teamId} = ${before.teamId} AND ${teamPrimaries.made} = 1)`;
          const isInBefore = sql`EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${before.teamId})`;
          return [
            // First, while the membership is still there to say what it
            // reached: a notice for each App they reach now, which the
            // clock tells if the pages aren't told after this commits.
            revocationsOf(
              db,
              appsOwnedOrSharedNow(userId),
              [userId],
              sql`${holds} AND ${listMade} AND ${isInBefore}`
            ),
            db
              .delete(teamMembers)
              .where(
                and(
                  eq(teamMembers.userId, userId),
                  eq(teamMembers.teamId, before.teamId),
                  listMade,
                  holds
                )
              ),
            outboxedIfChanged(db, entry("team.member.removed", before.teamId)),
            ...(after === undefined
              ? [
                  db
                    .delete(teamPrimaries)
                    .where(and(eq(teamPrimaries.userId, userId), holds)),
                ]
              : []),
          ];
        })();
  // The list's team for them, to add once their sign-in proves who they
  // are; no membership meanwhile.
  const wait = waits
    ? [
        db
          .insert(teamPrimaries)
          .select(
            sql`SELECT ${userId}, ${after}, ${now.getTime()}, 0, ${placeKey}, 1
            WHERE ${holds}
              AND EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${after} AND ${teams.organizationId} = ${organizationId})`
          )
          .onConflictDoUpdate({
            target: teamPrimaries.userId,
            set: {
              teamId: sql`excluded.team_id`,
              placedAt: sql`excluded.placed_at`,
              made: sql`excluded.made`,
              placeKey: sql`excluded.place_key`,
              pending: sql`excluded.pending`,
            },
          }),
      ]
    : [];
  const memberId = crypto.randomUUID();
  const isIn = sql`EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${after ?? ""})`;
  const join = joins
    ? [
        // In one statement with the checks: someone removed, or a team
        // deleted, since the read gets nothing; nor does a membership an
        // admin added meanwhile, by its pair or Better Auth's key.
        db
          .insert(teamMembers)
          .select(
            sql`SELECT ${memberId}, ${after}, ${userId}, ${key}, ${now.getTime()}
            WHERE ${holds}
              AND ${activeMember(userId)}
              AND EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${after} AND ${teams.organizationId} = ${organizationId})
              AND NOT ${isIn}`
          )
          .onConflictDoNothing(),
        outboxedIfChanged(db, entry("team.member.added", after)),
        // Made by the list only if its own insert made the row.
        db
          .insert(teamPrimaries)
          .select(
            sql`SELECT ${userId}, ${after}, ${now.getTime()},
              EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.id} = ${memberId}),
              ${placeKey}, 0
            WHERE ${holds} AND ${isIn}`
          )
          .onConflictDoUpdate({
            target: teamPrimaries.userId,
            set: {
              teamId: sql`excluded.team_id`,
              placedAt: sql`excluded.placed_at`,
              made: sql`excluded.made`,
              placeKey: sql`excluded.place_key`,
              pending: sql`excluded.pending`,
            },
          }),
      ]
    : [];
  return {
    statements: [...leave, ...wait, ...join],
    leaves: leave.length > 0,
  };
};

/**
 * What the staff list places a sign-in by (GRA-2055, `provedMembersOf`):
 * an entry's address, which a Google sign-in proves, or the Microsoft
 * directory account an entry from the directory read carries, by tenant
 * and object id, which a Microsoft sign-in proves.
 */
export type PlaceKey = `google:${string}` | `microsoft:${string}`;

/** A place key as `team_primaries.place_key` keeps it. */
const placeKeySchema = z.custom<PlaceKey>(
  (value) =>
    typeof value === "string" &&
    (value.startsWith("google:") || value.startsWith("microsoft:"))
);

/** The key of the address `email`, in compared form (`comparable`). */
export const addressKey = (email: string): PlaceKey =>
  `google:${comparable(email)}`;

/** The key of the Microsoft account `oid` in the tenant `tenant`. */
export const entraKey = (tenant: string, oid: string): PlaceKey =>
  `microsoft:${comparable(tenant)}:${comparable(oid)}`;

/** The keys a confirmed entry places a sign-in by. */
export const keysOfPlace = ({
  email,
  entra,
}: {
  email: string;
  entra: { tenant: string; oid: string } | null;
}): PlaceKey[] => [
  ...(email === "" ? [] : [addressKey(email)]),
  ...(entra === null ? [] : [entraKey(entra.tenant, entra.oid)]),
];

/**
 * The current members whose sign-in proved one of `keys` is theirs, each
 * with the key: the one rule of who the staff list places (GRA-2055), for
 * a confirm's placing and for a first sign-in after it. The proof is the
 * one an item's reader list takes (source-readers.ts
 * `provedSignInAccounts`), lasting: Google by the address its ID token
 * marked verified, in the company's hosted domain and sign-in domains,
 * whenever that sign-in was (the reader lists' one-day rule is for reading,
 * checked on every read; a lasting membership never hangs on a proof's
 * age); Microsoft by the object id of a sign-in through the
 * company's own tenant, against the account the directory read put on the
 * entry, no address compared at all. Never `users.email`, nor Entra's
 * `email` claim, which proves nothing: a Microsoft member whose entry
 * carries no directory account (a list from a file, or typed by hand) is
 * placed by an admin, by hand.
 */
export const provedMembersOf = async (
  env: Pick<Env, "SIGN_IN">,
  db: DrizzleD1Database,
  keys: readonly PlaceKey[]
): Promise<{ userId: string; key: PlaceKey }[]> => {
  const wanted = new Set(keys);
  const addresses = keys.flatMap((key) =>
    key.startsWith("google:") ? [key.slice("google:".length)] : []
  );
  const oids = keys.flatMap((key) =>
    key.startsWith("microsoft:") ? [key.slice(key.lastIndexOf(":") + 1)] : []
  );
  if (addresses.length === 0 && oids.length === 0) {
    return [];
  }
  const signIns = await db
    .select({
      userId: accounts.userId,
      providerId: accounts.providerId,
      oid: accounts.oid,
      verifiedEmail: accounts.verifiedEmail,
      verifiedEmailAt: accounts.verifiedEmailAt,
      verifiedTenant: accounts.verifiedTenant,
    })
    .from(accounts)
    .where(
      and(
        or(
          and(
            eq(accounts.providerId, providerIds.google),
            inList(sql`lower(${accounts.verifiedEmail})`, addresses)
          ),
          and(
            eq(accounts.providerId, providerIds.entra),
            inList(sql`lower(${accounts.oid})`, oids)
          )
        ),
        activeMember(accounts.userId)
      )
    )
    .orderBy(accounts.userId);
  return signIns.flatMap(({ userId, ...signIn }) =>
    provedSignInAccounts(env, [signIn]).flatMap(
      ({ provider, tenant, account }) => {
        const key =
          provider === "google"
            ? addressKey(account)
            : entraKey(tenant, account);
        return wanted.has(key) ? [{ userId, key }] : [];
      }
    )
  );
};

/**
 * What a placing writes of the confirmed list's teams (`teams`) to the
 * members' teams (GRA-2055), in its first batch, while its lease stands
 * (`holds`), so an older confirm never makes or names a team after a
 * newer one: each team the members' teams don't have yet is made under
 * its id, as Better Auth's own create-team makes a team, and only under
 * an id never retired, checked in the statement itself, so no deleted
 * team's id comes back with what was shared with it; each one named
 * otherwise takes the list's name. None is ever deleted here, as one may
 * hold what was shared with it.
 */
const teamsOf = async (
  db: DrizzleD1Database,
  actor: AuditActor,
  confirmed: ConfirmedPlaces["teams"],
  holds: SQL
): Promise<BatchItem<"sqlite">[]> => {
  const existing = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, organizationId));
  const known = new Map(existing.map(({ id, name }) => [id, name]));
  const now = Date.now();
  const entry = (action: string, id: string): AuditEntry => ({
    actor,
    action,
    target: { type: "team", id },
    detail: { via },
  });
  return confirmed.flatMap(({ id, name }): BatchItem<"sqlite">[] => {
    const was = known.get(id);
    if (was === undefined) {
      return [
        db
          .insert(teams)
          .select(
            sql`SELECT ${id}, ${name}, 0, ${organizationId}, ${now}, ${now}
              WHERE ${holds}
                AND NOT EXISTS (SELECT 1 FROM ${retiredTeamIds} WHERE ${retiredTeamIds.id} = ${id})`
          )
          .onConflictDoNothing(),
        outboxedIfChanged(db, entry("team.created", id)),
      ];
    }
    return was === name
      ? []
      : [
          db
            .update(teams)
            .set({ name, updatedAt: new Date(now) })
            .where(
              and(
                eq(teams.id, id),
                eq(teams.organizationId, organizationId),
                holds
              )
            ),
          outboxedIfChanged(db, entry("team.updated", id)),
        ];
  });
};

/**
 * `placePrimaries` for one claimed version, under its lease `leaseId`:
 * each current member whose sign-in proved an address or account its list
 * names (`provedMembersOf`) goes in that team, as their primary one; whoever it moved, took off, or no longer
 * finds leaves the team it gave them before, by the one rule
 * (`placementOf`). Each change audited. Its last batch marks the version
 * placed.
 */
const placeVersion = async (
  env: Env,
  actor: AuditActor,
  { version, places, teams: listTeams }: ConfirmedPlaces,
  leaseId: string
): Promise<void> => {
  const db = drizzle(env.DB);
  const ours = and(
    eq(staffListPlaced.organizationId, organizationId),
    eq(staffListPlaced.leaseId, leaseId)
  );
  const holds = sql`EXISTS (SELECT 1 FROM ${staffListPlaced} WHERE ${ours})`;
  const teamOf = new Map(
    places.flatMap((place) =>
      keysOfPlace(place).map((key) => [key, place.team] as const)
    )
  );
  const [found, placed] = await Promise.all([
    provedMembersOf(env, db, [...teamOf.keys()]),
    db
      .select({
        userId: teamPrimaries.userId,
        teamId: teamPrimaries.teamId,
        made: teamPrimaries.made,
        pending: teamPrimaries.pending,
        placeKey: teamPrimaries.placeKey,
      })
      .from(teamPrimaries),
  ]);
  // What each member's sign-in proves now, of what the list names.
  const provedBy = new Map<string, PlaceKey[]>();
  for (const { userId, key } of found) {
    provedBy.set(userId, [...(provedBy.get(userId) ?? []), key]);
  }
  const was = new Map(
    placed.map(({ userId, placeKey, ...row }) => [
      userId,
      { ...row, placeKey: placeKeySchema.parse(placeKey) },
    ])
  );
  // Who proves each key now: one someone else proves names them, not
  // whoever was placed by it before.
  const proverOf = new Map<PlaceKey, string>();
  for (const { userId, key } of found) {
    proverOf.set(key, userId);
  }
  /**
   * What the list gives `userId` now. By what their sign-in proves of what
   * it names: the key they were placed by first, else another, as an
   * address that changed at Google and on the list. Proving nothing it
   * names, by what it named them by before, while nobody else proves that,
   * so lack of proof takes nothing away; and while someone else does (an
   * address that changed hands), they stay as they are.
   */
  const assigned = (userId: string) => {
    const before = was.get(userId);
    const proves = provedBy.get(userId) ?? [];
    const placeKey =
      before !== undefined && proves.includes(before.placeKey)
        ? before.placeKey
        : proves[0];
    if (placeKey !== undefined) {
      return { after: teamOf.get(placeKey), placeKey, proved: true };
    }
    if (before === undefined) {
      return { after: undefined, placeKey: undefined, proved: false };
    }
    const prover = proverOf.get(before.placeKey);
    if (prover !== undefined && prover !== userId) {
      return { after: before.teamId, placeKey: before.placeKey, proved: false };
    }
    return {
      after: teamOf.get(before.placeKey),
      placeKey: before.placeKey,
      proved: false,
    };
  };
  const changes = await Promise.all(
    [...new Set([...was.keys(), ...provedBy.keys()])]
      // One order every time, so batches are the same on a retry.
      .toSorted()
      .flatMap((userId) => {
        const before = was.get(userId);
        const { after, placeKey, proved } = assigned(userId);
        const changed =
          before?.teamId !== after ||
          (before?.pending === true && proved) ||
          // What the list names them by changed hands to them alone.
          (before !== undefined &&
            placeKey !== undefined &&
            before.placeKey !== placeKey);
        return changed ? [{ userId, before, after, placeKey, proved }] : [];
      })
      .map(async (change): Promise<Placement> => ({
        ...change,
        key:
          change.after === undefined
            ? undefined
            : await membershipKeyOf(change.after, change.userId),
      }))
  );
  const now = new Date();
  // The teams first, in the first batch: made before anyone joins them.
  const teamWrites = await teamsOf(db, actor, listTeams, holds);
  const batches = changes.length > 0 ? chunks(changes, peoplePerBatch) : [[]];
  // Each person's change whole in one batch, so a move never ends half
  // done; the batches one after another, each within D1's limits, the
  // first statement of each renewing the lease. A placing that stops part
  // way leaves its version unplaced, for the clock to place again.
  for (const [index, part] of batches.entries()) {
    const groups = part.map((change) =>
      placementOf(db, actor, change, now, holds)
    );
    const first = index === 0 ? teamWrites : [];
    // Where each leaving person's statements start: its notice first.
    const leaves: number[] = [];
    let at = 1 + first.length;
    for (const { statements, leaves: leaving } of groups) {
      if (leaving) {
        leaves.push(at);
      }
      at += statements.length;
    }
    const touched = [
      ...new Set(
        part.flatMap(({ before, after }) =>
          [before?.teamId, after].filter((id) => id !== undefined)
        )
      ),
    ];
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    const results = await auditedBatch(env, db, [
      db
        .update(staffListPlaced)
        .set({ leaseUntil: new Date(Date.now() + leaseMs) })
        .where(ours),
      ...first,
      ...groups.flatMap(({ statements }) => statements),
      // Better Auth's count of each team's members, as its own writes keep
      // it: in the batch that changed them, so a placing that stops after
      // it leaves no count behind.
      ...(touched.length > 0
        ? [
            db
              .update(teams)
              .set({
                memberCount: sql`(SELECT count(*) FROM ${teamMembers} WHERE ${teamMembers.teamId} = ${teams.id})`,
              })
              .where(inList(teams.id, touched)),
          ]
        : []),
      ...(index === batches.length - 1
        ? [
            db
              .update(staffListPlaced)
              .set({ placed: version, leaseId: null, leaseUntil: null })
              .where(ours),
          ]
        : []),
    ]);
    // As Better Auth's own removal does (auth.ts): leaving a team can
    // take a role in an App away, so its open pages look again; told
    // once the batch committed, and by the clock if not now.
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    await tellKept(
      env,
      leaves.flatMap((start) => keptRowsSchema.parse(results[start]))
    );
  }
};

/**
 * Puts the members of the list the admin last confirmed in their teams
 * (GRA-2055), from the onboarding store's confirmed places, never from a
 * request: a placing at a time, and never an older list after a newer
 * one. It claims its version in D1 first (`staff_list_placed`), under a
 * lease of its own, only when it is newer than the one claimed, or is the
 * one claimed, not placed, and under no live lease (a placing that failed
 * or died); it reads after that claim, and writes only while its lease
 * stands: a newer claim makes the rest of an older placing's writes
 * nothing, and reads what it wrote. Placed, it looks at the store again
 * and places a newer list, if one came meanwhile, so the members' teams
 * end as the last confirmed list says. The clock calls it too, so a list
 * a confirm saved but didn't place is placed shortly.
 */
export const placePrimaries = async (
  env: Env,
  actor: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  const store = onboardingStore(env);
  let confirmed = await store.confirmedPlaces();
  while (confirmed !== null) {
    const { version } = confirmed;
    const leaseId = crypto.randomUUID();
    const now = Date.now();
    const leaseUntil = new Date(now + leaseMs);
    // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
    const [claimed] = await db
      .insert(staffListPlaced)
      .values({ organizationId, version, placed: 0, leaseId, leaseUntil })
      .onConflictDoUpdate({
        target: staffListPlaced.organizationId,
        set: { version, leaseId, leaseUntil },
        setWhere: sql`${staffListPlaced.version} < ${version}
          OR (${staffListPlaced.version} = ${version}
            AND ${staffListPlaced.placed} < ${version}
            AND (${staffListPlaced.leaseUntil} IS NULL OR ${staffListPlaced.leaseUntil} <= ${now}))`,
      })
      .returning({ version: staffListPlaced.version });
    if (claimed === undefined) {
      // This list or a newer one is placed, or being placed.
      return;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
      await placeVersion(env, actor, confirmed, leaseId);
    } catch (error) {
      // Its lease given up at once, so the clock's next run places it
      // again; if even that fails, once the lease runs out.
      // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
      await db
        .update(staffListPlaced)
        .set({ leaseUntil: null })
        .where(eq(staffListPlaced.leaseId, leaseId))
        .catch(() => null);
      throw error;
    }
    // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
    const latest = await store.confirmedPlaces();
    confirmed = latest?.version === version ? null : latest;
  }
};

/**
 * The version of the confirmed list whose placing last finished
 * (`placePrimaries`), 0 before any.
 */
export const placedVersion = async (env: Env): Promise<number> => {
  const [row] = await drizzle(env.DB)
    .select({ placed: staffListPlaced.placed })
    .from(staffListPlaced)
    .where(eq(staffListPlaced.organizationId, organizationId));
  return row?.placed ?? 0;
};

/**
 * For the clock: places the list the admin last confirmed where no
 * placing finished it (a confirm whose placing failed or died), as the
 * system. Nothing when it is placed.
 */
export const placeUnplaced = async (env: Env): Promise<void> => {
  const version = await onboardingStore(env).confirmedVersion();
  if (version > (await placedVersion(env))) {
    await placePrimaries(env, { type: "system" });
  }
};
