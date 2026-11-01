import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  auditEvents,
  channels,
  clientDeploys,
  clients,
} from "../src/db/schema.ts";
import type { Channel } from "../src/db/schema.ts";
import { promoteRelease, releaseToEdge } from "../src/rollout/channels.ts";
import { promoteReleaseFn, retryChannelFn } from "../src/rollout/functions.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// The release channels on the Platform page (src/admin/channel-parts.tsx),
// rendered by the admin's entry, and the changes its buttons send.

const token = "test-deployer-token-channel-pages-7a2d41";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const tags = /<[^>]*>/gu;
const spaces = /\s+/gu;
const options =
  /<option\b[^>]*\bvalue="[^"]+"[^>]*>(?<words>[^<]*)<\/option>/gu;

/** `html` as words, its tags gone. */
const textOf = (html: string): string =>
  html.replaceAll(tags, " ").replaceAll("&#x27;", "'").replaceAll(spaces, " ");

/** How many times `text` appears in `html`. */
const count = (html: string, text: string): number =>
  html.split(text).length - 1;

/**
 * What `channel`'s Promote offers on the page, each option as it reads;
 * null when the channel offers no move at all.
 */
const offered = (html: string, channel: Channel): string[] | null => {
  const select = new RegExp(
    `<select\\b[^>]*\\bid="promote-${channel}"[^>]*>([\\s\\S]*?)</select>`,
    "u"
  ).exec(html);
  if (select === null) {
    return null;
  }
  return [...(select[1] ?? "").matchAll(options)].map((option) =>
    (option.groups?.words ?? "").trim()
  );
};

/** A live client on `releaseId`, following `channel`. */
const live = async (channel: Channel, releaseId: string): Promise<string> => {
  const { clientId } = await livePlacedClient(cloudflare, releaseId, {
    channel,
  });
  return clientId;
};

/** Takes `releaseId` to Stable as staff would: Edge, then Beta, then Stable. */
const toStable = async (releaseId: string): Promise<void> => {
  await releaseToEdge(env, [releaseId]);
  await promoteRelease(env, staff, { channel: "beta", releaseId });
  await promoteRelease(env, staff, { channel: "stable", releaseId });
};

/**
 * Sets aside what earlier tests left: their clients offboarded, and no
 * release on any channel.
 */
const setAsideEarlierTests = async (): Promise<void> => {
  await db
    .update(clients)
    .set({ status: "offboarded" })
    .where(ne(clients.status, "offboarded"));
  await db.delete(channels);
};

describe("the release channels on the Platform page", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("shows each channel's release and how many of its companies run it", async () => {
    const before = await placedRelease("feat(core): before");
    const release = await placedRelease("feat(core): on stable");
    const newest = await placedRelease("feat(core): only on edge");
    const current = await live("stable", release);
    const lagging = await live("stable", before);
    const onEdge = await live("edge", release);
    await toStable(release);
    await releaseToEdge(env, [newest]);

    const { status, html } = await page("/platform");
    const text = textOf(html);

    expect({
      status,
      stable: text.includes("1 of 2 up to date"),
      edge: text.includes("0 of 1 up to date"),
      beta: text.includes("0 of 0 up to date"),
      // Each company of a channel, where it stands.
      states: [
        text.includes(`Acme ${current} Up to date`),
        text.includes(`Acme ${lagging} Waiting`),
        text.includes(`Acme ${onEdge} Waiting`),
      ],
      // Each channel's release opens its own page.
      opensRelease:
        html.includes(`href="/platform/releases/${release}"`) &&
        html.includes(`href="/platform/releases/${newest}"`),
    }).toStrictEqual({
      status: 200,
      stable: true,
      edge: true,
      beta: true,
      states: [true, true, true],
      opensRelease: true,
    });
  });

  it("offers each channel only the moves it may make: Edge's releases to Beta, Beta's to Stable, and a release a channel had back", async () => {
    const never = await placedRelease("feat(core): never on a channel");
    const release = await placedRelease("feat(core): on stable");
    const newest = await placedRelease("feat(core): only on edge");
    await toStable(release);
    await releaseToEdge(env, [newest]);

    const { html } = await page("/platform");
    const edge = offered(html, "edge") ?? [];
    const beta = offered(html, "beta") ?? [];
    const stable = offered(html, "stable") ?? [];

    expect({
      // Edge set back to the release it had.
      edgeBack: edge.includes(`${release} (back)`),
      // Beta takes what reached Edge.
      betaTakesNewest: beta.includes(newest),
      // Stable never takes what Beta hasn't had.
      stableSkips: stable.includes(newest),
      // Nor does any channel take what was never on the one before it.
      neverOffered: [edge, beta, stable].some((each) =>
        each.some((words) => words.startsWith(never))
      ),
      // A channel isn't offered the release it has.
      current: beta.includes(release) || stable.includes(release),
    }).toStrictEqual({
      edgeBack: true,
      betaTakesNewest: true,
      stableSkips: false,
      neverOffered: false,
      current: false,
    });
  });

  it("shows a channel whose deploy failed, with the company and why, and Retry, gone once staff retry", async () => {
    const before = await placedRelease("feat(core): before");
    const release = await placedRelease("feat(core): fails on one");
    const failing = await live("stable", before);
    await live("stable", before);
    await toStable(release);
    const now = new Date();
    // As the reconciler records a deploy whose upload was refused.
    await db.insert(clientDeploys).values({
      clientId: failing,
      releaseId: release,
      runId: `deploy-${crypto.randomUUID().slice(0, 8)}`,
      status: "failed",
      error: "cloudflare_400_10000",
      startedAt: now,
      endedAt: now,
    });

    const { html: failed } = await page("/platform");
    const retried = await callServerFn(retryChannelFn, { channel: "stable" });
    const { html: after } = await page("/platform");

    expect({
      badge: failed.includes("Failed: nothing new starts until Retry"),
      why: textOf(failed).includes("Failed cloudflare_400_10000"),
      retry: count(failed, ">Retry<"),
      retried,
      afterBadge: after.includes("Failed: nothing new starts until Retry"),
      afterRetry: count(after, ">Retry<"),
    }).toStrictEqual({
      badge: true,
      why: true,
      retry: 1,
      retried: { done: true, refused: null },
      afterBadge: false,
      afterRetry: 0,
    });
  });
});

describe("promoting a release from the Platform page", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(setAsideEarlierTests);

  it("refuses a release that skips a channel, and promotes one Beta had, recorded as the staff member who sent it", async () => {
    const release = await placedRelease("feat(core): promoted");
    await releaseToEdge(env, [release]);

    const skipping = await callServerFn(promoteReleaseFn, {
      channel: "stable",
      releaseId: release,
    });
    const toBeta = await callServerFn(promoteReleaseFn, {
      channel: "beta",
      releaseId: release,
    });
    const beta = await db
      .select({ releaseId: channels.releaseId })
      .from(channels)
      .where(eq(channels.id, "beta"))
      .get();
    const event = await db
      .select({ actor: auditEvents.actor })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "channel.promote"),
          eq(auditEvents.target, release),
          ne(auditEvents.actor, "system")
        )
      )
      .get();

    expect({ skipping, toBeta, beta, event }).toStrictEqual({
      skipping: { done: false, refused: "promotion_not_allowed" },
      toBeta: { done: true, refused: null },
      beta: { releaseId: release },
      event: { actor: staff.email },
    });
  });
});
