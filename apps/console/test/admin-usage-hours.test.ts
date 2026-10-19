import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-usage-5c1e9a";
const tenantToken = "test-tenant-admin-token-admin-usage-7f2b40";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live, answering with `snapshot`. */
const liveClient = async (snapshot: AdminSnapshot) => {
  const release = await publishRelease({ notes: "feat(core): ai use" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Acme ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  account.admin = snapshot;
  return `/admin/organizations/${clientId}`;
};

/** One model's calls on a day, as core counts them. */
const calls = (tokensIn: number, tokensOut: number, seconds = 0) => ({
  calls: 1,
  tokensIn,
  kept: 0,
  tokensOut,
  seconds,
});

/**
 * A company whose core counted, today: Stephen reading the first
 * conversation with the careful model (2 million tokens read, 200
 * thousand written: €15) and interviewing with the quick one (1 million
 * read, 200 thousand written: €6), his voice (20 minutes: €3), and
 * core's own default model, which has no price (500 thousand read, 100
 * thousand written: its tokens count, not its cost). €24 in all, with
 * its contract not known.
 */
const usedSnapshot = (): AdminSnapshot => {
  const empty = emptyAdminSnapshot("Acme");
  return {
    ...empty,
    usage: [
      {
        day: empty.now.slice(0, 10),
        use: {
          reading: { "claude-opus-5-5": calls(2_000_000, 200_000) },
          interviews: {
            "claude-sonnet-5-5": calls(1_000_000, 200_000),
            voice: calls(0, 0, 1200),
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast": calls(500_000, 100_000),
          },
        },
      },
    ],
  };
};

/** The month of `iso`, as the page names it: "Oct 2026". */
const monthName = (iso: string): string =>
  new Date(iso).toLocaleString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

describe("an organization's AI use and hours", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows what core counted: this month and in all, the tokens and minutes, by use, by model, and the prices", async () => {
    const snapshot = usedSnapshot();
    const base = await liveClient(snapshot);

    const { status, html } = await page(`${base}/ai-use`);
    const has = (text: string) => html.includes(text);

    expect({
      status,
      counted: has("Counted as it happened, every time a model was asked."),
      month: has(`${monthName(snapshot.now)}</span>`),
      inAll: has("In all, so far"),
      spend: html.split(">€24<").length - 1,
      // Core doesn't send the contract yet: unknown, not unsigned.
      contract: [
        has("the contract isn’t known yet"),
        has("no signed contract yet"),
      ],
      tokens: [
        has(">4.0 million<"),
        has("3.5 million read, 500 thousand written"),
      ],
      voice: [has(">20<"), has("20 spoken, 0 heard")],
      // The numbers, by use: reading and interviews cost, the rest nothing.
      byUse: [
        has(">€15<"),
        has(">€9.00<"),
        has("Every interview Stephen held"),
        // The unpriced model's tokens are among the interviews'.
        has("1.5 million read, 300 thousand written"),
      ],
      shares: [has(">63%<"), has(">25%<"), has(">13%<")],
      prices: [
        has("€5 a million tokens read, €25 written"),
        has("€0.15 a minute"),
        has("Other models (not priced)"),
        has("No price: its tokens count, its cost doesn’t"),
      ],
      toCome: has("This section isn’t in the console yet."),
    }).toStrictEqual({
      status: 200,
      counted: true,
      month: true,
      inAll: true,
      // In all so far, this month, and the numbers' total.
      spend: 3,
      contract: [true, false],
      tokens: [true, true],
      voice: [true, true],
      byUse: [true, true, true, true],
      shares: [true, true, true],
      prices: [true, true, true, true],
      toCome: false,
    });
  });

  it("names this month's figure after the month core is on, even before anything is used in it", async () => {
    const snapshot = usedSnapshot();
    const [used] = snapshot.usage;
    // The same use, forty days before core's day: in an earlier month.
    const earlier = new Date(Date.parse(snapshot.now) - 40 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const base = await liveClient({
      ...snapshot,
      usage: used === undefined ? [] : [{ ...used, day: earlier }],
    });

    const { status, html } = await page(`${base}/ai-use`);

    expect({
      status,
      thisMonth: html.includes(`>${monthName(snapshot.now)}</span>`),
      // This month took nothing; everything so far is the earlier month's.
      nothingYet: html.includes(">€0.00<"),
      inAll: html.includes(">€24<"),
      since: html.includes(`since ${monthName(earlier)}`),
    }).toStrictEqual({
      status: 200,
      thisMonth: true,
      nothingYet: true,
      inAll: true,
      since: true,
    });
  });

  it("says nothing is used yet where core counted nothing, with the way to the first conversation", async () => {
    const base = await liveClient(emptyAdminSnapshot("Acme"));

    const { status, html } = await page(`${base}/ai-use`);

    expect({
      status,
      nothing: html.includes("Nothing used yet"),
      way: html.includes(`href="${base}/steps"`),
      figures: html.includes("In all, so far"),
    }).toStrictEqual({ status: 200, nothing: true, way: true, figures: false });
  });

  it("knows no hours while core sends no drawn work, saying why", async () => {
    const untold = await liveClient(emptyAdminSnapshot("Acme"));
    const empty = emptyAdminSnapshot("Acme");
    // Told today, with its interviews from today on.
    const told = await liveClient({
      ...empty,
      told: true,
      plan: { start: empty.now.slice(0, 10), days: 14 },
    });

    const before = await page(`${untold}/hours`);
    const during = await page(`${told}/hours`);

    expect({
      statuses: [before.status, during.status],
      none: [before, during].map(({ html }) =>
        html.includes("No hours known yet")
      ),
      before: before.html.includes(
        "The interviews start once the company has told its team."
      ),
      during: during.html.includes(
        "The team leads go first. Their teams follow the same day."
      ),
      toCome: [before, during].some(({ html }) =>
        html.includes("This section isn’t in the console yet.")
      ),
    }).toStrictEqual({
      statuses: [200, 200],
      none: [true, true],
      before: true,
      during: true,
      toCome: false,
    });
  });
});
