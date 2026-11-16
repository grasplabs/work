import { agentErrors } from "@grasp-os/shared/agent";
import { heldAppCallsPage } from "@grasp-os/shared/chat";
import type { ChatChannel, HeldAppCall } from "@grasp-os/shared/chat";
import type { ConnectionPerson, PendingAction } from "@grasp-os/shared/connect";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionReadOf } from "../agent-scope.ts";
import { activeMember, organizationId } from "../auth/auth.ts";
import { personOf } from "../connections.ts";
import { members, users } from "../db/core/schema.ts";
import { heldAppCallsOf } from "../held-app-calls.ts";
import type { HeldWriteView, ReadCheck } from "./cards.tsx";
import { inertOn } from "./inert.ts";
import { say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// A turn's held writes, as its chat platform's card shows them (cards.tsx
// `heldWritesCard`): the writes the chat's agent had held in this chat
// during the turn, in the order it asked for them, each with its exact
// values. Connect keeps a connection's (its src/pending.ts), with their
// input hashes; the chat's Workspace keeps a write to an App its chat held
// once it used something only its person can read (held-app-calls.ts,
// GRA-1929), with its exact request's hash. The card carries the hashes,
// so a press confirms exactly these.

/**
 * The member `userId` as core's decisions take them (`identity`, as a
 * session would give it, with only what a decision reads) and as connect
 * names them (`person`), while they are a member; null otherwise.
 */
export const memberOf = async (
  env: Env,
  userId: string
): Promise<{ identity: Identity; person: ConnectionPerson } | null> => {
  const [row] = await drizzle(env.DB)
    .select({ role: members.role, email: users.email, name: users.name })
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
  const identity: Identity = {
    userId,
    email: row.email,
    name: row.name,
    role: role.data,
    teams: [],
    staff: false,
    expiresAt: new Date().toISOString(),
  };
  return { identity, person: await personOf(env, identity) };
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
 * A write to an App held in chat `chatId` as the card shows it, in
 * `locale`: what it calls in which App (by its ID once removed), and the
 * exact request it would send, the text its hash is of, as it is.
 */
export const appViewOf = (
  chatId: string,
  call: HeldAppCall,
  locale: ChannelLocale
): HeldWriteView => ({
  id: call.id,
  inputHash: call.requestHash,
  chatId,
  title: say("heldAppWrite", locale, {
    function: call.function,
    app: call.appName ?? call.appId,
  }),
  values: [{ label: say("heldAppRequest", locale), value: call.request }],
  state: "held",
});

/**
 * The writes to an App held for `userId` in their chat `chatId`, which
 * came through `via`, that still wait, oldest first, every page; none for
 * a chat that isn't theirs through `via`.
 */
export const heldAppCallsIn = async (
  env: Env,
  userId: string,
  chatId: string,
  via: ChatChannel
): Promise<HeldAppCall[]> => {
  const all: HeldAppCall[] = [];
  let after: string | undefined;
  for (;;) {
    let page: HeldAppCall[];
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
      page = await heldAppCallsOf(env, { userId }, chatId, via, after);
    } catch (error) {
      if (agentErrors.codeOf(error) === "agent.chat_not_found") {
        return [];
      }
      throw error;
    }
    all.push(...page);
    after = page.at(-1)?.id;
    if (page.length < heldAppCallsPage || after === undefined) {
      return all;
    }
  }
};

/**
 * The writes the agent of chat `chatId`, which came through `platform`,
 * had held for `userId` since `since` (milliseconds since the epoch):
 * connect's and those to an App, oldest first, in `locale`. None for
 * someone no longer a member, whose writes connect drops, and whose App
 * writes could no longer run.
 */
export const turnHeldWrites = async (
  env: Env,
  {
    userId,
    chatId,
    platform,
    locale,
  }: {
    userId: string;
    chatId: string;
    platform: ChatChannel;
    locale: ChannelLocale;
  },
  since: number
): Promise<HeldWriteView[]> => {
  const member = await memberOf(env, userId);
  if (member === null) {
    return [];
  }
  const waiting = await env.CONNECT.listPendingActions(
    member.person,
    "chat_app"
  );
  const writes = waiting
    .filter(
      ({ context, requestedAt }) =>
        context.type === "chat" &&
        context.chatId === chatId &&
        Date.parse(requestedAt) >= since
    )
    .map((held) => ({ at: Date.parse(held.requestedAt), view: viewOf(held) }));
  const calls = await heldAppCallsIn(env, userId, chatId, platform);
  const toApps = calls
    .filter(({ heldAt }) => Date.parse(heldAt) >= since)
    .map((call) => ({
      at: Date.parse(call.heldAt),
      view: appViewOf(chatId, call, locale),
    }));
  return [...writes, ...toApps]
    .toSorted((a, b) => a.at - b.at)
    .map(({ view }) => view);
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

/**
 * `view` as a card on `platform` shows it: its title, labels and values,
 * which the model wrote, as they will be sent, nothing cut, with the
 * platform's own link and mention syntax made inert (`inertOn`: on Teams
 * a space after a `]` a link would go on from), so the card shows where a
 * value leads, and no value leads anywhere from the card.
 */
export const inertView = (
  platform: string,
  view: HeldWriteView
): HeldWriteView => {
  const inert = inertOn(platform);
  return {
    ...view,
    title: inert(view.title),
    values: view.values.map(({ label, value }) => ({
      label: inert(label),
      value: inert(value),
    })),
  };
};
