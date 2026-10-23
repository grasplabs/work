import { actorOf } from "@grasp-os/shared/audit";
import {
  channelLinkMs,
  channelLinkPath,
  channelLinkSecretSchema,
  linkedPlatformSchema,
  platformNameSchema,
  platformUserIdSchema,
} from "@grasp-os/shared/channel-accounts";
import type {
  ChannelAccount,
  ChannelAccountsApi,
  ChannelLinkOutcome,
  ChannelLinkPreview,
  ChannelLinkRefusal,
  ChannelUnlinked,
} from "@grasp-os/shared/channel-accounts";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import { identifierSchema } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "../audit-outbox.ts";
import { activeMember } from "../auth/auth.ts";
import { channelAccounts, channelLinks } from "../db/core/schema.ts";
import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";

// A person's accounts on chat platforms whose messages carry no Entra
// object id (Slack, WhatsApp, Telegram...), linked to their Grasp person,
// so the agent knows who writes there. The ways it can fail, and what
// stops each:
//
// - Someone claims another's account by name, email or phone number: a
//   link is only ever bound to the platform's own verified sender id
//   (Chat SDK's `message.author.userId`), which the door hands to
//   `offerChannelLink`; nothing a person types names an account.
// - A link lying in a chat's history, or prefetched by the chat app,
//   links anyone who opens it: it links nothing until a signed-in person
//   presses to confirm, it holds for 15 minutes, once, and a newer link
//   to the same account replaces it. Opening it only previews it.
// - A link leaks through a log or a referrer: its secret sits after the
//   `#`, which no browser sends to a server, and core keeps only its hash.
// - An account linked twice, or to two people: one statement takes the
//   link and the account together, and the account is unique per
//   platform id, so two confirmations can't both win.
// - Someone removed keeps their chat accounts: removal deletes them
//   (members.ts), and `personOnChannel` knows active members only.
// - Grasp staff link an account: they aren't the company's people; every
//   method refuses them.
// - The audit log, append-only, keeps a phone number: an event names the
//   account by its own id and its platform, never the platform's id (on
//   WhatsApp that is the number).
//
// A link someone forwards to a colleague, who signs in and confirms,
// links the sender's account to the colleague: the confirm card shows the
// platform's name for the account, so they see whose it is.

/** How long a used or dead link is kept, so opening it says why it links nothing. */
const linkKeptMs = 24 * 60 * 60 * 1000;

/** Most links one sweep deletes. */
const sweptPerRun = 500;

/** The chat account a link is sent to, as the door read it from the platform. */
export interface ChannelSender {
  platform: string;
  platformUserId: string;
  /** What the platform calls them, if it said. */
  name?: string | null;
}

/** A link the door sends a sender: its path, with the secret, and when it stops working. */
export interface ChannelLinkOffered {
  /** `/chat-link#<secret>`, to put after the deployment's origin. */
  path: string;
  expiresAt: Date;
}

/**
 * The active member the platform account `platformUserId` on `platform`
 * is linked to, or null: nobody linked it, or the person it was linked to
 * is no longer a member.
 */
export const personOnChannel = async (
  env: Env,
  platform: string,
  platformUserId: string
): Promise<string | null> => {
  const [row] = await drizzle(env.DB)
    .select({ userId: channelAccounts.userId })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.platform, platform),
        eq(channelAccounts.platformUserId, platformUserId),
        activeMember(channelAccounts.userId)
      )
    )
    .limit(1);
  return row?.userId ?? null;
};

/**
 * A new link for `sender`, replacing any earlier one still open for the
 * same account. Only the secret's hash is kept; the secret is in the path
 * returned, after the `#`. Throws on a platform that isn't linked by
 * account (Teams) or a sender id that isn't one.
 */
export const offerChannelLink = async (
  env: Env,
  sender: ChannelSender,
  now = new Date()
): Promise<ChannelLinkOffered> => {
  const platform = linkedPlatformSchema.parse(sender.platform);
  const platformUserId = platformUserIdSchema.parse(sender.platformUserId);
  // A name only shows who the platform says it is; one that isn't a name
  // is left out rather than refusing the link.
  const name = platformNameSchema.safeParse(sender.name ?? undefined);
  const secret = randomToken();
  const expiresAt = new Date(now.getTime() + channelLinkMs);
  const db = drizzle(env.DB);
  await db.batch([
    db
      .update(channelLinks)
      .set({ replacedAt: now })
      .where(
        and(
          eq(channelLinks.platform, platform),
          eq(channelLinks.platformUserId, platformUserId),
          isNull(channelLinks.usedAt),
          isNull(channelLinks.replacedAt)
        )
      ),
    db.insert(channelLinks).values({
      secretHash: await sha256Hex(secret),
      platform,
      platformUserId,
      name: name.success ? name.data : null,
      createdAt: now,
      expiresAt,
    }),
  ]);
  return { path: `${channelLinkPath}#${secret}`, expiresAt };
};

/** Deletes links that stopped working a while ago, used or not. */
export const sweepChannelLinks = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  // Through a subquery: D1 binds at most 100 values to a statement.
  const stale = db
    .select({ secretHash: channelLinks.secretHash })
    .from(channelLinks)
    .where(lt(channelLinks.expiresAt, new Date(now.getTime() - linkKeptMs)))
    .orderBy(asc(channelLinks.expiresAt))
    .limit(sweptPerRun);
  const gone = await db
    .delete(channelLinks)
    .where(inArray(channelLinks.secretHash, stale))
    .returning({ secretHash: channelLinks.secretHash });
  if (gone.length === 0) {
    return;
  }
  log.info("channel.links_deleted", { links: gone.length });
};

type LinkRow = typeof channelLinks.$inferSelect;

const accountOf = (
  row: typeof channelAccounts.$inferSelect
): ChannelAccount => ({
  id: row.id,
  platform: row.platform,
  platformUserId: row.platformUserId,
  name: row.name,
  linkedAt: row.linkedAt.toISOString(),
});

/** That nobody but `userId` has the account a link is bound to, as SQL. */
const notTakenFrom = (userId: string) => sql`NOT EXISTS (
  SELECT 1 FROM ${channelAccounts}
  WHERE ${channelAccounts.platform} = ${channelLinks.platform}
    AND ${channelAccounts.platformUserId} = ${channelLinks.platformUserId}
    AND ${channelAccounts.userId} <> ${userId}
)`;

/** The signed-in person's own chat accounts, over `/rpc`. Never staff's. */
export class ChannelAccountsRpc
  extends CoreRpcTarget
  implements ChannelAccountsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  /** Runs `run` as the person behind the session, refusing Grasp staff. */
  async #asMember<T>(run: (person: Identity) => Promise<T>): Promise<T> {
    return await withPerson(this.#check, async (person) => {
      if (person.staff) {
        throw roleErrors.create("role.forbidden");
      }
      return await run(person);
    });
  }

  async list(): Promise<ChannelAccount[]> {
    return await this.#asMember(async ({ userId }) => {
      const rows = await drizzle(this.#env.DB)
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.userId, userId))
        .orderBy(desc(channelAccounts.linkedAt), desc(channelAccounts.id));
      return rows.map(accountOf);
    });
  }

  async preview(secret: string): Promise<ChannelLinkPreview> {
    return await this.#asMember(async ({ userId }) => {
      const row = await this.#linkOf(secret);
      const refused = await this.#refusalOf(row, userId);
      if (refused !== null || row === undefined) {
        return { state: "refused", reason: refused ?? "not_found" };
      }
      return {
        state: "open",
        offer: {
          platform: row.platform,
          platformUserId: row.platformUserId,
          name: row.name,
          expiresAt: row.expiresAt.toISOString(),
        },
      };
    });
  }

  async link(secret: string): Promise<ChannelLinkOutcome> {
    return await this.#asMember(async (person) => {
      const parsed = channelLinkSecretSchema.safeParse(secret);
      if (!parsed.success) {
        return { state: "refused", reason: "not_found" };
      }
      const secretHash = await sha256Hex(parsed.data);
      const now = new Date();
      const id = crypto.randomUUID();
      const db = drizzle(this.#env.DB);
      // Taking the link and linking the account are one batch: the link
      // only while it is open and the account nobody else's, the account
      // only if the link was taken just now. A second confirmation, of
      // this link or another to the same account, finds it taken.
      const [taken] = await auditedBatch(this.#env, db, [
        db
          .update(channelLinks)
          .set({ usedAt: now, usedBy: person.userId })
          .where(
            and(
              eq(channelLinks.secretHash, secretHash),
              isNull(channelLinks.usedAt),
              isNull(channelLinks.replacedAt),
              gt(channelLinks.expiresAt, now),
              notTakenFrom(person.userId)
            )
          )
          .returning({
            platform: channelLinks.platform,
            platformUserId: channelLinks.platformUserId,
          }),
        db
          .insert(channelAccounts)
          .select(
            sql`SELECT ${id}, ${channelLinks.platform}, ${channelLinks.platformUserId},
              ${person.userId}, ${channelLinks.name}, ${now.getTime()}, 'sign_in_link'
              FROM ${channelLinks}
              WHERE ${channelLinks.secretHash} = ${secretHash} AND changes() > 0`
          )
          .onConflictDoNothing(),
        // Never the platform's id: on WhatsApp it is a phone number.
        outboxedIfChanged(db, {
          actor: actorOf(person),
          action: "channel_account.linked",
          target: { type: "channel_account", id },
        }),
      ]);
      const [link] = taken;
      if (link === undefined) {
        const row = await this.#linkOf(parsed.data);
        return {
          state: "refused",
          reason: (await this.#refusalOf(row, person.userId)) ?? "used",
        };
      }
      // Linked now, or by them already through an earlier link.
      const [account] = await db
        .select()
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.platform, link.platform),
            eq(channelAccounts.platformUserId, link.platformUserId),
            eq(channelAccounts.userId, person.userId)
          )
        );
      if (account === undefined) {
        // Unlinked again between the batch and this read.
        return { state: "refused", reason: "used" };
      }
      return { state: "linked", account: accountOf(account) };
    });
  }

  async unlink(id: string): Promise<ChannelUnlinked> {
    return await this.#asMember(async (person) => {
      // Anything but an identifier names no account, and the audit log takes it.
      const parsed = identifierSchema.safeParse(id);
      if (!parsed.success) {
        return "not_found";
      }
      const db = drizzle(this.#env.DB);
      const [gone] = await auditedBatch(this.#env, db, [
        db
          .delete(channelAccounts)
          .where(
            and(
              eq(channelAccounts.id, parsed.data),
              eq(channelAccounts.userId, person.userId)
            )
          )
          .returning({ id: channelAccounts.id }),
        outboxedIfChanged(db, {
          actor: actorOf(person),
          action: "channel_account.unlinked",
          target: { type: "channel_account", id: parsed.data },
        }),
      ]);
      return gone.length === 0 ? "not_found" : "unlinked";
    });
  }

  /** The link with `secret`, if it is one and core has it. */
  async #linkOf(secret: string): Promise<LinkRow | undefined> {
    const parsed = channelLinkSecretSchema.safeParse(secret);
    if (!parsed.success) {
      return undefined;
    }
    const [row] = await drizzle(this.#env.DB)
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.secretHash, await sha256Hex(parsed.data)));
    return row;
  }

  /** Why `row` links nothing for `userId` now; null while it would. */
  async #refusalOf(
    row: LinkRow | undefined,
    userId: string
  ): Promise<ChannelLinkRefusal | null> {
    if (row === undefined) {
      return "not_found";
    }
    if (row.usedAt !== null) {
      return "used";
    }
    if (row.replacedAt !== null) {
      return "replaced";
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return "expired";
    }
    const [holder] = await drizzle(this.#env.DB)
      .select({ userId: channelAccounts.userId })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.platform, row.platform),
          eq(channelAccounts.platformUserId, row.platformUserId)
        )
      );
    return holder === undefined || holder.userId === userId ? null : "taken";
  }
}
