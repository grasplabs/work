import { actorOf } from "@grasp-os/shared/audit";
import {
  connectionErrors,
  sharedMailboxesMax,
  sharedMailboxSchema,
  toolClassAudienceSchema,
} from "@grasp-os/shared/connect";
import type {
  SharedMailboxSetting,
  ToolClassAudience,
} from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { count, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { sharedMailboxPointers, teams } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import {
  audienceOf,
  classesOn,
  storedOf,
  storedTeamsSchema,
  takesIn,
} from "./tool-classes.ts";

// The shared mailboxes an admin points Stephen at, and for whom (GRA-724):
// a shared mailbox is the company's, so the chat's agent reaches one only
// once an admin points it there for the person it acts for, whatever
// classes are on. Core signs the mailboxes pointed at the person into
// each capability of the chat's agent, and connect refuses its mail calls
// on any other mailbox but its person's own (connect's mailboxes.ts),
// where the call's mailbox is known. Microsoft 365 is asked for shared
// mailboxes' rights only while one is pointed at (connect's
// provider-rights.ts). The ways it can fail, which the tests start from: a
// shared mailbox read without a pointer, or by someone it doesn't name; a
// pointer changed by someone other than the company's own admins (staff
// included) or without a trace; an address in another case counting as
// another mailbox.

/** Off, for a row that can't be read: never more than the admin chose. */
const off: ToolClassAudience = { who: "nobody" };

/** Every shared mailbox an admin pointed Stephen at, and for whom. */
export const readSharedMailboxes = async (
  env: Env
): Promise<SharedMailboxSetting[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(sharedMailboxPointers)
    .orderBy(sharedMailboxPointers.mailbox);
  return rows.map((row) => ({
    mailbox: row.mailbox,
    audience: audienceOf(row) ?? off,
    changedBy: row.changedBy,
    changedAt: row.changedAt.toISOString(),
  }));
};

/**
 * Points Stephen at `mailbox` for everyone or some teams, or for nobody.
 * Admins only, never Grasp staff; each change audited, and one that
 * changes nothing records nothing. Throws `connection.invalid` for an
 * address or audience that isn't one, a team the company doesn't have, or
 * one mailbox more than `sharedMailboxesMax`. Pointing at one asks the
 * Microsoft connections without shared mailboxes' rights to be connected
 * again.
 */
export const pointSharedMailbox = async (
  env: Env,
  identity: Identity,
  mailbox: unknown,
  audience: unknown
): Promise<void> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const parsedMailbox = sharedMailboxSchema.safeParse(mailbox);
  const parsedAudience = toolClassAudienceSchema.safeParse(audience);
  if (!(parsedMailbox.success && parsedAudience.success)) {
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
  const [counted] = await db
    .select({ pointers: count() })
    .from(sharedMailboxPointers)
    .where(sql`${sharedMailboxPointers.mailbox} <> ${parsedMailbox.data}`);
  if ((counted?.pointers ?? 0) >= sharedMailboxesMax) {
    throw connectionErrors.create("connection.invalid");
  }
  const detail: Record<string, string> = {
    mailbox: parsedMailbox.data,
    who: stored.who,
  };
  for (const [index, team] of teamIds.entries()) {
    detail[`team${index + 1}`] = team;
  }
  const changedAt = new Date();
  await auditedBatch(env, db, [
    db
      .insert(sharedMailboxPointers)
      .values({
        mailbox: parsedMailbox.data,
        ...stored,
        changedBy: identity.userId,
        changedAt,
      })
      .onConflictDoUpdate({
        target: sharedMailboxPointers.mailbox,
        set: { ...stored, changedBy: identity.userId, changedAt },
        // Only a different audience is a change: the same one again leaves
        // the row, and so the log, as it was.
        setWhere: or(
          sql`${sharedMailboxPointers.who} IS NOT ${stored.who}`,
          sql`${sharedMailboxPointers.teams} IS NOT ${stored.teams}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "connection.mailbox.pointed",
      target: { type: "shared_mailbox", id: parsedMailbox.data },
      detail,
    }),
  ]);
  if (stored.who !== "nobody") {
    // Asked even when nothing changed here, so an admin who points again
    // after a failure here gets it done. Sending from it comes with Reach
    // others on.
    const on = await classesOn(env);
    await env.CONNECT.requireClassRights({
      classes: on.includes("reach-others") ? ["reach-others"] : [],
      sharedMailbox: true,
    });
  }
};

/**
 * The shared mailboxes the company pointed Stephen at for the person
 * `userId`, in lower case: what core signs into each capability of the
 * chat's agent acting for them.
 */
export const mailboxesFor = async (
  env: Env,
  userId: string
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(sharedMailboxPointers)
    .where(ne(sharedMailboxPointers.who, "nobody"));
  const pointed = await Promise.all(
    rows.map(async (row) => {
      const audience = audienceOf(row) ?? off;
      return (await takesIn(env, audience, userId)) ? row.mailbox : undefined;
    })
  );
  return pointed.filter((mailbox) => mailbox !== undefined);
};
