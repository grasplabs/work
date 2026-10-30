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
import { stephenReachFor } from "../src/channels/where.ts";
import {
  gmailAccount,
  slackApp,
  teamsBot,
  telegramBot,
  whatsAppNumber,
} from "./connect-providers.ts";
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
        outcome(api.channelAccounts.reach()),
      ])
    ).resolves.toStrictEqual(Array.from({ length: 5 }, () => "role.forbidden"));
    await expect(
      personOnChannel(env, "slack", platformUserId)
    ).resolves.toBeNull();
  });

  it("forget a removed person's accounts, and link none back on a connection checked before the removal", async () => {
    const admin = await signedInApi(idp, "admin");
    const leaves = await signedInApi(idp, "user");
    const { platformUserId, secret } = await sentLink();
    await leaves.api.channelAccounts.link(secret);
    const later = await sentLink();
    // Their connection's latest reading still says they are a member.
    await leaves.api.whoami();

    await admin.api.members.remove(leaves.userId);
    const linked = await outcome(leaves.api.channelAccounts.link(later.secret));

    expect(["role.forbidden", "auth.unauthenticated"]).toContain(linked);
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

  it("delete links a day after they stopped working, used or not, more than D1 binds at once, and keep the rest", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    // More than the 100 values D1 binds to one statement.
    await Promise.all(
      Array.from(
        { length: 120 },
        async () => await sentLink({ now: twoDaysAgo })
      )
    );
    const old = await sentLink({ now: twoDaysAgo });
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

describe("where to reach Stephen", { timeout: 60_000 }, () => {
  it("lists each chat app set up, with only what the app shows anyone", async () => {
    const me = await signedInApi(idp, "user");

    const reach = await me.api.channelAccounts.reach();

    expect(reach).toStrictEqual([
      {
        platform: "teams",
        address: null,
        href: `https://teams.microsoft.com/l/chat/0/0?users=28:${teamsBot.id}`,
      },
      { platform: "slack", address: null, href: null },
      {
        platform: "whatsapp",
        address: "+31 20 123 4567",
        href: "https://wa.me/31201234567",
      },
      {
        platform: "telegram",
        address: "@acme_stephen_bot",
        href: "https://t.me/acme_stephen_bot",
      },
      {
        platform: "gmail",
        address: gmailAccount.mailbox,
        href: `mailto:${gmailAccount.mailbox}`,
      },
    ]);
    const said = JSON.stringify(reach);
    for (const secret of [
      slackApp.signingSecret,
      whatsAppNumber.appSecret,
      whatsAppNumber.phoneNumberId,
      whatsAppNumber.verifyToken,
      telegramBot.webhookSecret,
      telegramBot.token,
    ]) {
      expect(said).not.toContain(secret);
    }
  });

  it("leaves out an app that isn't set up, and an address that isn't one", async () => {
    const me = await signedInApi(idp, "user");

    const reach = await stephenReachFor(
      {
        ...env,
        SLACK_SIGNING_SECRET: "",
        GMAIL_MAILBOX: undefined,
        WHATSAPP_NUMBER: "call reception",
        TELEGRAM_BOT_USERNAME: "@acme_stephen_bot",
      },
      me.userId
    );

    expect(reach).toStrictEqual([
      expect.objectContaining({ platform: "teams" }),
      { platform: "whatsapp", address: null, href: null },
      {
        platform: "telegram",
        address: "@acme_stephen_bot",
        href: "https://t.me/acme_stephen_bot",
      },
    ]);
  });

  it("leaves out an app Stephen doesn't answer them in, and every one while he is off", async () => {
    const admin = await signedInApi(idp, "admin");
    const me = await signedInApi(idp, "user");
    // A team of nobody: the person isn't in it.
    const team = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Sales', 'organization', ?)"
    )
      .bind(team, Date.now())
      .run();
    try {
      await admin.api.connections.setStephenPlace(
        "whatsapp",
        { who: "teams", teams: [team] },
        true
      );
      const narrowed = await me.api.channelAccounts.reach();
      await admin.api.connections.setStephenReach(false, { who: "everyone" });
      const off = await me.api.channelAccounts.reach();

      expect({
        narrowed: narrowed.map(({ platform }) => platform),
        off,
      }).toStrictEqual({
        narrowed: ["teams", "slack", "telegram", "gmail"],
        off: [],
      });
    } finally {
      await admin.api.connections.setStephenReach(true, { who: "everyone" });
      await admin.api.connections.setStephenPlace(
        "whatsapp",
        { who: "asStephen" },
        true
      );
    }
  });
});
