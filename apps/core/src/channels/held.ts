import type { ConnectionPerson, PendingAction } from "@grasp-os/shared/connect";
import { roleSchema } from "@grasp-os/shared/roles";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionReadOf } from "../agent-scope.ts";
import { activeMember, organizationId } from "../auth/auth.ts";
import { personOf } from "../connections.ts";
import { members, users } from "../db/core/schema.ts";
import type { HeldWriteView, ReadCheck } from "./cards.tsx";

// A turn's held writes, as its chat platform's card shows them (cards.tsx
// `heldWritesCard`): the writes the chat's agent had connect hold in this
// chat during the turn, in the order it asked for them, each with its
// exact values. Connect keeps them (its src/pending.ts), with their input
// hashes, which the card carries so a press confirms exactly these.

/** The person `userId` as connect names them, while they are a member. */
const memberPerson = async (
  env: Env,
  userId: string
): Promise<ConnectionPerson | null> => {
  const [row] = await drizzle(env.DB)
    .select({ role: members.role, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.userId, userId),
        activeMember(members.userId)
      )
    )
    .limit(1);
  const role = roleSchema.safeParse(row?.role);
  if (row === undefined || !role.success) {
    return null;
  }
  return await personOf(env, {
    userId,
    role: role.data,
    staff: false,
    email: row.email,
  });
};

/** One value as the card shows it: text as it is, a list joined, else JSON. */
const shownValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((each) => typeof each === "string")) {
    return value.join(", ");
  }
  return JSON.stringify(value, null, 2);
};

/**
 * A held write as the card shows it: in its tool's own words, its values
 * as the tool describes them. One whose tool describes none, or describes
 * only part of its input, shows every property of its exact input
 * instead, so nothing that runs is left off the card.
 */
export const viewOf = (held: PendingAction): HeldWriteView => {
  const { description, input: exact } = held;
  if (description?.complete === true) {
    return {
      id: held.id,
      inputHash: held.inputHash,
      title: description.title,
      values: description.fields.map(({ label, value }) => ({
        label,
        value: shownValue(value),
      })),
      state: "held",
    };
  }
  let input: unknown;
  try {
    input = JSON.parse(exact);
  } catch {
    input = exact;
  }
  const values =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.entries(input).map(([label, value]) => ({
          label,
          value: shownValue(value),
        }))
      : [{ label: held.action, value: shownValue(input) }];
  return {
    id: held.id,
    inputHash: held.inputHash,
    title: description?.title ?? held.action,
    values,
    state: "held",
  };
};

/**
 * The writes the agent of chat `chatId` had held for `userId` since
 * `since` (milliseconds since the epoch), oldest first: none for someone
 * no longer a member, whose writes connect drops.
 */
export const turnHeldWrites = async (
  env: Env,
  userId: string,
  chatId: string,
  since: number
): Promise<HeldWriteView[]> => {
  const person = await memberPerson(env, userId);
  if (person === null) {
    return [];
  }
  const waiting = await env.CONNECT.listPendingActions(person);
  return waiting
    .filter(
      ({ context, requestedAt }) =>
        context.type === "chat" &&
        context.chatId === chatId &&
        Date.parse(requestedAt) >= since
    )
    .toSorted((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .map(viewOf);
};

/**
 * What the card warns of, from what the chat's code read (the turn's
 * provenance, `connectionRead` sources): mail, which other people wrote.
 * Company records' line (`record`) comes with the rules that know which
 * reads are of a company record (GRA-719).
 */
export const checkOf = (sources: readonly string[]): ReadCheck | undefined =>
  sources.some(
    (source) => connectionReadOf(source)?.action.startsWith("mail.") === true
  )
    ? { read: "mail" }
    : undefined;
