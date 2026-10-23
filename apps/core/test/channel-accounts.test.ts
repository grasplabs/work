import {
  channelLinkMs,
  channelLinkPath,
} from "@grasp-os/shared/channel-accounts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  offerChannelLink,
  personOnChannel,
  sweepChannelLinks,
} from "../src/channels/accounts.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Linking a person's chat account to them (Settings › Security). The ways
// it can fail, first: a link that links by being opened (chat apps
// prefetch links), one that links twice, after its time, after a newer
// one, or to a second person; someone linking an account they weren't
// sent, or unlinking another's; staff linking anything; a removed person
// still known on a platform; and the platform's id (a phone number on
// WhatsApp) or the secret kept where it shouldn't be.

const idp = mockIdp();

/** A Slack account nobody linked, and a link the chat sent it. */
const sentLink = async (
  sender: { platformUserId?: string; now?: Date } = {}
) => {
  const platformUserId = sender.platformUserId ?? `U${unique()}`;
  const { path, expiresAt } = await offerChannelLink(
    env,
    { platform: "slack", platformUserId, name: "Ada on Slack" },
    sender.now
  );
  const [, secret = ""] = path.split("#");
  return { platformUserId, path, secret, expiresAt };
};

describe("linking a chat account", { timeout: 60_000 }, () => {
  it("links nothing on opening: a preview shows whose it is and leaves it open", async () => {
    const me = await signedInApi(idp, "user");
    const { platformUserId, secret } = await sentLink();

    const audited = await auditedDuring(async () => {
      await expect(
        me.api.channelAccounts.preview(secret)
      ).resolves.toMatchObject({
        state: "open",
        offer: {
          platform: "slack",
          platformUserId,
          name: "Ada on Slack",
        },
      });
      await me.api.channelAccounts.preview(secret);
    });

    expect(audited).toStrictEqual([]);
    await expect(me.api.channelAccounts.list()).resolves.toStrictEqual([]);
    await expect(
      personOnChannel(env, "slack", platformUserId)
    ).resolves.toBeNull();
  });

  it("refuse a secret that names no link, changing and recording nothing", async () => {
    const me = await signedInApi(idp, "user");

    const audited = await auditedDuring(async () => {
      const refused = await Promise.all(
        ["", "x".repeat(1000), "A".repeat(43), "not a secret"].map(
          async (secret) => await me.api.channelAccounts.link(secret)
        )
      );
      expect(refused).toStrictEqual(
        Array.from({ length: 4 }, () => ({
          state: "refused",
          reason: "not_found",
        }))
      );
    });

    expect(audited).toStrictEqual([]);
    await expect(me.api.channelAccounts.list()).resolves.toStrictEqual([]);
  });

  it("refuse a link after its time, or once a newer one was sent to the account", async () => {
    const me = await signedInApi(idp, "user");
    const expired = await sentLink({
      now: new Date(Date.now() - channelLinkMs - 1000),
    });
    const older = await sentLink();
    const newer = await sentLink({ platformUserId: older.platformUserId });

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          me.api.channelAccounts.preview(expired.secret),
          me.api.channelAccounts.link(expired.secret),
          me.api.channelAccounts.link(older.secret),
        ])
      ).resolves.toStrictEqual([
        { state: "refused", reason: "expired" },
        { state: "refused", reason: "expired" },
        { state: "refused", reason: "replaced" },
      ]);
    });

    expect(audited).toStrictEqual([]);
    await expect(
      me.api.channelAccounts.link(newer.secret)
    ).resolves.toMatchObject({
      state: "linked",
    });
  });

  it("link once: a second confirmation, theirs or someone else's, finds it used", async () => {
    const me = await signedInApi(idp, "user");
    const colleague = await signedInApi(idp, "user");
    const { platformUserId, secret } = await sentLink();

    const outcomes = await Promise.all([
      me.api.channelAccounts.link(secret),
      colleague.api.channelAccounts.link(secret),
    ]);

    expect(outcomes.map(({ state }) => state).toSorted()).toStrictEqual([
      "linked",
      "refused",
    ]);
    await expect(
      Promise.all([
        me.api.channelAccounts.link(secret),
        colleague.api.channelAccounts.link(secret),
      ])
    ).resolves.toStrictEqual([
      { state: "refused", reason: "used" },
      { state: "refused", reason: "used" },
    ]);
    const linkedTo = await personOnChannel(env, "slack", platformUserId);
    expect([me.userId, colleague.userId]).toContain(linkedTo);
  });

  it("refuse to link an account someone else has, until they unlink it", async () => {
    const owner = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "user");
    const first = await sentLink();
    await owner.api.channelAccounts.link(first.secret);
    const second = await sentLink({ platformUserId: first.platformUserId });

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          other.api.channelAccounts.preview(second.secret),
          other.api.channelAccounts.link(second.secret),
        ])
      ).resolves.toStrictEqual([
        { state: "refused", reason: "taken" },
        { state: "refused", reason: "taken" },
      ]);
    });

    expect(audited).toStrictEqual([]);
    await expect(
      personOnChannel(env, "slack", first.platformUserId)
    ).resolves.toBe(owner.userId);
    const [account] = await owner.api.channelAccounts.list();
    await owner.api.channelAccounts.unlink(account?.id ?? "");
    await expect(
      other.api.channelAccounts.link(second.secret)
    ).resolves.toMatchObject({
      state: "linked",
    });
  });

  it("refuse to unlink another person's account, or one that names none", async () => {
    const owner = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "admin");
    const { secret } = await sentLink();
    await owner.api.channelAccounts.link(secret);
    const [account] = await owner.api.channelAccounts.list();

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          other.api.channelAccounts.unlink(account?.id ?? ""),
          owner.api.channelAccounts.unlink(""),
          owner.api.channelAccounts.unlink("x".repeat(1000)),
          owner.api.channelAccounts.unlink(crypto.randomUUID()),
        ])
      ).resolves.toStrictEqual(Array.from({ length: 4 }, () => "not_found"));
    });

    expect(audited).toStrictEqual([]);
    await expect(owner.api.channelAccounts.list()).resolves.toHaveLength(1);
  });

  it("refuse Grasp staff everything, linking nothing", async () => {
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const api = staff.core.authenticate();
    const { platformUserId, secret } = await sentLink();

    await expect(
      Promise.all([
        outcome(api.channelAccounts.list()),
        outcome(api.channelAccounts.preview(secret)),
        outcome(api.channelAccounts.link(secret)),
        outcome(api.channelAccounts.unlink(crypto.randomUUID())),
      ])
    ).resolves.toStrictEqual(Array.from({ length: 4 }, () => "role.forbidden"));
    await expect(
      personOnChannel(env, "slack", platformUserId)
    ).resolves.toBeNull();
  });

  it("forget a removed person's accounts: the platform account is a stranger again", async () => {
    const admin = await signedInApi(idp, "admin");
    const leaves = await signedInApi(idp, "user");
    const { platformUserId, secret } = await sentLink();
    await leaves.api.channelAccounts.link(secret);

    await admin.api.members.remove(leaves.userId);

    await expect(
      personOnChannel(env, "slack", platformUserId)
    ).resolves.toBeNull();
    const { count } = (await env.DB.prepare(
      "SELECT count(*) AS count FROM channel_accounts WHERE user_id = ?"
    )
      .bind(leaves.userId)
      .first<{ count: number }>()) ?? { count: -1 };
    expect(count).toBe(0);
  });

  it("send no link to a Teams account: Teams people are known by their Entra object id", async () => {
    await expect(
      offerChannelLink(env, {
        platform: "teams",
        platformUserId: `29:${unique()}`,
      })
    ).rejects.toThrow("Entra object id");
  });

  it("keep only the secret's hash, and never put the platform's id in the audit log", async () => {
    const me = await signedInApi(idp, "user");
    const { platformUserId, secret, path } = await sentLink({
      platformUserId: `+4930${unique()}`,
    });

    const audited = await auditedDuring(async () => {
      await me.api.channelAccounts.link(secret);
    });

    expect(path).toBe(`${channelLinkPath}#${secret}`);
    const { results } = await env.DB.prepare(
      "SELECT * FROM channel_links"
    ).all();
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(JSON.stringify(audited)).not.toContain(platformUserId);
    expect(audited).toMatchObject([
      {
        actor: { type: "person", userId: me.userId },
        action: "channel_account.linked",
        target: { type: "channel_account" },
      },
    ]);
  });

  it("delete links a day after they stopped working, used or not, and keep the rest", async () => {
    const old = await sentLink({
      now: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    const fresh = await sentLink();
    const me = await signedInApi(idp, "user");

    await sweepChannelLinks(env, new Date());

    await expect(
      Promise.all([
        me.api.channelAccounts.preview(old.secret),
        me.api.channelAccounts.preview(fresh.secret),
      ])
    ).resolves.toMatchObject([
      { state: "refused", reason: "not_found" },
      { state: "open" },
    ]);
  });
});

describe("a linked chat account", { timeout: 60_000 }, () => {
  it("names its person on that platform alone, and lists for them alone", async () => {
    const me = await signedInApi(idp, "user");
    const someoneElse = await signedInApi(idp, "user");
    const { platformUserId, secret } = await sentLink();

    const linked = await me.api.channelAccounts.link(secret);

    expect(linked).toMatchObject({
      state: "linked",
      account: { platform: "slack", platformUserId, name: "Ada on Slack" },
    });
    await expect(personOnChannel(env, "slack", platformUserId)).resolves.toBe(
      me.userId
    );
    await expect(
      personOnChannel(env, "telegram", platformUserId)
    ).resolves.toBeNull();
    await expect(someoneElse.api.channelAccounts.list()).resolves.toStrictEqual(
      []
    );
  });

  it("unlinks, audited: the platform account is a stranger again", async () => {
    const me = await signedInApi(idp, "user");
    const { platformUserId, secret } = await sentLink();
    await me.api.channelAccounts.link(secret);
    const [account] = await me.api.channelAccounts.list();

    const audited = await auditedDuring(async () => {
      await expect(
        me.api.channelAccounts.unlink(account?.id ?? "")
      ).resolves.toBe("unlinked");
    });

    expect(audited).toStrictEqual([
      expect.objectContaining({
        action: "channel_account.unlinked",
        target: { type: "channel_account", id: account?.id },
      }),
    ]);
    await expect(
      personOnChannel(env, "slack", platformUserId)
    ).resolves.toBeNull();
    await expect(me.api.channelAccounts.list()).resolves.toStrictEqual([]);
  });
});
