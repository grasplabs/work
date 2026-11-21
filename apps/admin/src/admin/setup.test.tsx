// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import type { ClientSetup } from "../clients/setup.ts";
import type { WatchedSignals } from "../clients/watch-signals.ts";
import { answeredAdmin, gridRow, openAdmin } from "../test-app.tsx";

// What an organization's Setup says of its own staff's secrets, its Teams
// bot and how Stephen fares there, and which tab it opens on, as the
// browser shows them from the Setup the Worker answers. What the Worker
// answers is in workerd (test/client-sealed-secrets.test.ts,
// test/client-teams-bot.test.ts, test/stephen-watch.test.ts); the rest of
// the Setup renders from real answers there (test/setup-page.ts).

const acme = gridRow({ id: "acme", name: "Acme", hostname: "acme.grasp.test" });
const at = new Date();

/** A live company's Setup, running its release, nothing waiting: `overrides` on top. */
const setupOf = (overrides: Partial<ClientSetup> = {}): ClientSetup => ({
  provisioning: {
    clientId: acme.id,
    hostname: acme.hostname,
    client: {
      name: acme.name,
      channel: "stable",
      status: "active",
      createdBy: "ops@grasp.test",
      createdAt: at,
      pinnedReleaseId: null,
    },
    stopped: null,
    notStarted: null,
    needsAttention: null,
    phase: "active",
  },
  account: {
    generation: 1,
    rotatedAt: null,
    rotationLiveAt: null,
    configChangedAt: null,
  },
  signIn: null,
  teamsBot: null,
  teamsBotSecretDays: null,
  configPending: false,
  staffWindow: { window: null, open: false, staffSignIn: false },
  sealedSecrets: [],
  watched: null,
  workers: [],
  resources: null,
  releases: [],
  newestReleaseId: null,
  moreReleases: false,
  target: null,
  deploy: null,
  history: [],
  ...overrides,
});

/** Acme's Setup on `tab` (how it stands when none), the Worker answering `setup`. */
const openSetup = async (setup: ClientSetup, tab?: string) =>
  await openAdmin(
    `/organizations/acme/setup${tab === undefined ? "" : `?tab=${tab}`}`,
    {
      fetchClientGrid: [acme],
      fetchClientAdmin: answeredAdmin({ client: acme }),
      fetchClientSetup: setup,
      fetchPinChoices: { releases: [] },
      fetchClientHosting: null,
      fetchProvisioningProgress: null,
      fetchClientAiStatus: null,
    }
  );

/** A quiet day for Stephen: no signal over its bar. */
const quiet: WatchedSignals = {
  hours: 24,
  refused: 2,
  answered: 40,
  failed: 1,
  busy: 0,
  sendFailed: 0,
  uninstalled: 0,
  p50Ms: 4000,
  p90Ms: 8000,
  companyAgain: 0,
  personalAgain: 0,
};

const bot = {
  appId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  secretExpiresOn: "2027-01-01",
};

describe("an organization's Setup", () => {
  it("opens on how it stands for a tab it doesn't have", async () => {
    const { container } = await openSetup(setupOf(), "nothing");

    expect(
      container.querySelector('section[aria-label="How it stands"]')
    ).not.toBeNull();
  });

  it("shows who set its Teams bot's secret and when, and nothing else of it", async () => {
    const { main } = await openSetup(
      setupOf({
        sealedSecrets: [
          { name: "TEAMS_BOT_SECRET", setBy: "ops@grasp.test", setAt: at },
        ],
      }),
      "settings"
    );

    expect(main()).toContain("by ops@grasp.test");
  });

  it("sets up its Slack app from a manifest that sends to its own core, showing its bot token as set", async () => {
    const { main } = await openSetup(
      setupOf({
        sealedSecrets: [
          { name: "SLACK_BOT_TOKEN", setBy: "ops@grasp.test", setAt: at },
        ],
      }),
      "settings"
    );

    expect({
      requestUrl: main().includes("https://acme.grasp.test/api/channels/slack"),
      shown: main().includes("Bot token"),
    }).toStrictEqual({ requestUrl: true, shown: true });
  });

  it("says its bot's secret needs replacing once it's within a month of expiring, or has expired", async () => {
    const withDays = async (days: number) => {
      const { main } = await openSetup(
        setupOf({ teamsBot: bot, teamsBotSecretDays: days })
      );
      return main();
    };
    const far = await withDays(90);
    const soon = await withDays(20);
    const expired = await withDays(-1);

    expect({
      far: far.includes("Its Teams bot's secret"),
      soon: soon.includes("Its Teams bot's secret expires in 20 days."),
      expired: expired.includes(
        "Its Teams bot's secret has expired: Stephen can't answer in Teams."
      ),
    }).toStrictEqual({ far: false, soon: true, expired: true });
  });

  it("says a signal of Stephen's is over its bar while it is, and nothing on a quiet day", async () => {
    const over = await openSetup(
      setupOf({ watched: { readAt: at, signals: { ...quiet, failed: 10 } } })
    );
    const whileOver = over.main();
    const calm = await openSetup(
      setupOf({ watched: { readAt: at, signals: quiet } })
    );

    expect({
      whileOver: whileOver.includes("One of Stephen's signals is over its bar"),
      calm: calm.main().includes("over its bar:"),
    }).toStrictEqual({ whileOver: true, calm: false });
  });
});
