// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { act, gridRow, openAdmin, settle, until } from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import type { LiveStatus } from "../clients/grid.ts";
import type { OffboardedClient } from "../hosting/offboarding.ts";
import type { ChannelProgress } from "../rollout/progress.ts";
import type { PlatformSpend } from "./platform-spend-sums.ts";
import type { Readiness } from "./readiness.ts";

// Platform's pages and Home's banner as the browser shows them from what
// the Worker answers (test/readiness.test.ts, test/client-hosting.test.ts
// and test/release-pages.test.ts: what it reads of them).

/** Nothing set up yet: no release imported, the deployer reaching nothing. */
const blocked: Readiness = {
  checks: [
    {
      id: "release",
      title: "A release",
      required: true,
      status: "blocked",
      words:
        "No release is imported yet. CI publishes one for every merge to main, and the admin imports it within five minutes; Releases lists any it couldn't import, and why.",
    },
  ],
  blocking: 1,
};

const ready: Readiness = { checks: [], blocking: 0 };

/** What Platform reads, around `readiness`. */
const platformAnswers = (readiness: Readiness): Answers => ({
  fetchReadiness: readiness,
  fetchPlatform: { channels: [], history: [], events: [] },
  fetchPlatformSpend: null,
});

/** The figure labelled `label`, as its words read: label, value, then how it moved. */
const figureOf = (root: Element, label: string): string =>
  [...root.querySelectorAll('[data-slot="stat"]')]
    .map((stat) => stat.textContent ?? "")
    .find((words) => words.startsWith(label)) ?? "";

/** The page's part headings, in order. */
const headings = (root: Element): string[] =>
  [...root.querySelectorAll("main h2")].map((each) => each.textContent ?? "");

/** What an account answered live: its core reached and its version in sync, unless they say. */
const liveOf = (
  reach: LiveStatus["reach"] = "reachable",
  drift: LiveStatus["drift"] = "in_sync"
): LiveStatus => ({
  drift,
  sharedSecretsCurrent: true,
  reach,
  onboarding: null,
});

/** The rows of the list headed `id`, as their words read: its hairlines left out. */
const rowsOf = (root: Element, id: string): string[] =>
  [...root.querySelectorAll(`ul[aria-labelledby="${id}"] > li`)]
    .map((row) => row.textContent ?? "")
    .filter((words) => words !== "");

/** An answer that never comes. */
const never = async (): Promise<never> =>
  // oxlint-disable-next-line promise/avoid-new -- a read that never answers
  await new Promise(() => {});

/** An offboarded client, `days` days ago, its 30 days kept. */
const offboarded = (
  overrides: Partial<OffboardedClient> = {}
): OffboardedClient => {
  const offboardedAt = new Date(Date.now() - 86_400_000);
  return {
    clientId: "gone",
    name: "Gone",
    destinationId: "grasp-cloud-eu",
    offboardedAt,
    deletableFrom: new Date(offboardedAt.getTime() + 30 * 86_400_000),
    deletable: false,
    remaining: 3,
    emptying: [],
    ...overrides,
  };
};

/** The Offboarded page's item for `name`, and its controls. */
const offboardedItem = (root: Element, name: string) => {
  const item = [...root.querySelectorAll("main li")].find((each) =>
    each.textContent?.includes(`(${name})`)
  );
  const button = [...(item?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent === "Delete its resources"
  );
  const confirm = item?.querySelector('[role="checkbox"]');
  return {
    text: item?.textContent ?? "",
    deleteOff: button?.hasAttribute("disabled") ?? null,
    confirmOff:
      confirm === null || confirm === undefined
        ? null
        : confirm.hasAttribute("disabled") ||
          confirm.getAttribute("aria-disabled") === "true",
  };
};

describe("Home's banner and Platform's Readiness", () => {
  it("says on Home that Grasp can't onboard an organization yet while a required check blocks, and on Platform what stops it", async () => {
    const home = await openAdmin("/", { fetchReadiness: blocked });
    const banner = home
      .main()
      .includes("Grasp can't onboard an organization yet");
    const platform = await openAdmin("/platform", platformAnswers(blocked));

    expect({
      banner,
      panel: platform.main().includes("No release is imported yet."),
    }).toStrictEqual({ banner: true, panel: true });
  });

  it("says at a glance on Platform that onboarding is ready, with no Readiness lines once every one is", async () => {
    const { container } = await openAdmin("/platform", platformAnswers(ready));

    expect({
      figure: figureOf(container, "Onboarding"),
      lines: headings(container).includes("Readiness"),
    }).toStrictEqual({
      figure: "OnboardingReadyNothing stops a new organization",
      lines: false,
    });
  });

  it("shows no banner once nothing required blocks", async () => {
    const { main } = await openAdmin("/", { fetchReadiness: ready });

    expect(main()).not.toContain("Grasp can't onboard");
  });

  it("counts beside Platform the companies that need a look", async () => {
    const { container } = await openAdmin("/", {
      fetchReadiness: ready,
      fetchClientGrid: [
        gridRow({
          id: "laggard",
          name: "Laggard",
          setup: { state: "stopped" },
        }),
        gridRow({ id: "fineco", name: "Fineco" }),
      ],
    });

    expect(
      container.querySelector('[data-slot="sidebar"]')?.textContent
    ).toContain("1 company needs a look");
  });
});

describe("Platform's overview at a glance", () => {
  it("counts the cores that answer and the companies that need a look, once their accounts are read", async () => {
    const { container, main } = await openAdmin("/platform", {
      ...platformAnswers(ready),
      fetchClientGrid: [
        gridRow({ id: "acme", name: "Acme" }),
        gridRow({ id: "bolt", name: "Bolt" }),
        gridRow({
          id: "cork",
          name: "Cork",
          pinnedReleaseId: "39.01.10",
          lastDeploy: {
            releaseId: "39.01.10",
            status: "failed",
            at: new Date(),
          },
        }),
        gridRow({ id: "dove", name: "Dove" }),
      ],
      fetchGridLive: {
        acme: liveOf(),
        // Its version read, its core not reached.
        bolt: liveOf("unreachable"),
        cork: liveOf(),
        // Its core reached, its version not read.
        dove: liveOf("reachable", "unknown"),
      },
    });
    await until(() => figureOf(container, "Cores answering").includes(" of "));
    const listed = rowsOf(container, "needs-a-look");

    expect({
      cores: figureOf(container, "Cores answering"),
      look: figureOf(container, "Need a look"),
      listed: listed.map((row) => row.slice(0, 4)),
      bolt: listed[0]?.includes("Its core doesn't answer.") ?? false,
      corkPinned: listed[1]?.includes("Stable · Pinned") ?? false,
      failed: main().includes("Its last deploy failed (39.01.10)."),
    }).toStrictEqual({
      cores: "Cores answering3 of 41 not answering",
      look: "Need a look31 deploy failed, 1 not answering, and 1 not read",
      listed: ["Bolt", "Cork", "Dove"],
      bolt: true,
      corkPinned: true,
      failed: true,
    });
  });

  it("waits to say whether anything needs a look until the accounts answer, and never says all is well when they couldn't be read", async () => {
    const answers = {
      ...platformAnswers(ready),
      fetchClientGrid: [gridRow({ id: "acme", name: "Acme" })],
    };
    const reading = await openAdmin(
      "/platform",
      // The accounts never answer while it is open.
      { ...answers, fetchGridLive: never },
      { rest: false }
    );
    await until(() => figureOf(reading.container, "Need a look") !== "");
    const whileReading = {
      look: figureOf(reading.container, "Need a look"),
      allWell: reading.main().includes("Nothing needs a look"),
    };
    const failed = await openAdmin("/platform", answers);

    expect({
      whileReading,
      look: figureOf(failed.container, "Need a look"),
      allWell: failed.main().includes("Nothing needs a look"),
    }).toStrictEqual({
      whileReading: { look: "Need a look", allWell: false },
      look: "Need a look0The accounts couldn’t be read",
      allWell: false,
    });
  });

  it("lists every recent change of a channel's release the admin keeps, set-backs too", async () => {
    const history = Array.from({ length: 8 }, (_, at) => ({
      channel: "stable" as const,
      releaseId: `39.01.${String(10 - at)}`,
      from: `39.01.${String(11 - at)}`,
      back: at % 2 === 1,
      actor: "staff@grasp.test",
      at: new Date(Date.now() - at * 60_000),
    }));
    const { container } = await openAdmin("/platform", {
      ...platformAnswers(ready),
      fetchPlatform: { channels: [], history, events: [] },
    });
    const listed = rowsOf(container, "changes");

    expect({
      count: listed.length,
      back: listed[1]?.startsWith("Stable set back to 39.01.9") ?? false,
    }).toStrictEqual({ count: 8, back: true });
  });

  it("sums what Grasp's own AI costs, with this month's pace and the organizations near their limit", async () => {
    const now = new Date();
    const period = (back: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
        .toISOString()
        .slice(0, 7);
    const month = (back: number, micros: number) => ({
      period: period(back),
      micros,
      byFeature: [{ feature: null, micros }],
      byModel: [{ model: "anthropic/claude-sonnet-5-5", micros }],
    });
    const spend: PlatformSpend = {
      thisMonth: month(0, 300_000_000),
      lastMonth: month(1, 200_000_000),
      byOrganization: [
        {
          clientId: "acme",
          name: "Acme",
          thisMonth: 190_000_000,
          lastMonth: 150_000_000,
          graspAi: { spent: 190_000_000, limit: 200_000_000 },
        },
        {
          clientId: "bolt",
          name: "Bolt",
          thisMonth: 110_000_000,
          lastMonth: 50_000_000,
          graspAi: { spent: 110_000_000, limit: 400_000_000 },
        },
      ],
      organizations: 3,
      unread: [{ clientId: "cork", name: "Cork" }],
      unreported: [],
    };
    const { container, main } = await openAdmin("/platform", {
      ...platformAnswers(ready),
      fetchPlatformSpend: spend,
    });
    await until(() => figureOf(container, "Near their limit") !== "");
    // Before its third day a month's pace says too little, so it isn't said.
    const paced = now.getUTCDate() > 3;

    const acme = container.querySelector(
      '[aria-labelledby="spend-by-organization"] a[href="/organizations/acme/ai-use"]'
    );

    expect({
      acme: acme?.closest("li")?.textContent?.includes("Near its limit"),
      thisMonth: main().includes("$300.00"),
      pace: main().includes("on pace for $"),
      lastMonth: main().includes("$200.00"),
      near: figureOf(container, "Near their limit"),
      leftOut: main().includes(
        "Read from 2 of 3 active organizations. Not in these sums, as their core didn’t answer: Cork."
      ),
    }).toStrictEqual({
      acme: true,
      thisMonth: true,
      pace: paced,
      lastMonth: true,
      near: "Near their limit1of 2 on a limit",
      leftOut: true,
    });
  });
});

describe("Grasp's own AI on Platform when its features cost nothing", () => {
  it("still says which organizations' own AI is near its limit", async () => {
    const now = new Date();
    const month = (back: number) => ({
      period: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)
      )
        .toISOString()
        .slice(0, 7),
      micros: 0,
      byFeature: [],
      byModel: [],
    });
    const { container, main } = await openAdmin("/platform", {
      ...platformAnswers(ready),
      fetchPlatformSpend: {
        thisMonth: month(0),
        lastMonth: month(1),
        byOrganization: [
          {
            clientId: "acme",
            name: "Acme",
            thisMonth: 0,
            lastMonth: 0,
            graspAi: { spent: 190_000_000, limit: 200_000_000 },
          },
        ],
        organizations: 1,
        unread: [],
        unreported: [],
      } satisfies PlatformSpend,
    });
    await until(() => figureOf(container, "Near their limit") !== "");

    expect({
      near: figureOf(container, "Near their limit"),
      nothing: main().includes("Nothing on Grasp’s keys this month or last."),
    }).toStrictEqual({
      near: "Near their limit1of 1 on a limit",
      nothing: true,
    });
  });
});

describe("Platform's Offboarded and Releases", () => {
  it("offers deleting an offboarded client's resources only once its retention is over, saying from when", async () => {
    const early = await openAdmin("/platform/offboarded", {
      fetchOffboardedClients: [offboarded()],
    });
    const waiting = offboardedItem(early.container, "gone");

    expect({
      deleteOff: waiting.deleteOff,
      confirm: waiting.confirmOff,
      from: waiting.text.includes("It can be deleted from"),
    }).toStrictEqual({ deleteOff: true, confirm: true, from: true });
  });

  it("asks only that no export was made once its retention is over, and says which bucket is still emptying", async () => {
    const due = await openAdmin("/platform/offboarded", {
      fetchOffboardedClients: [
        offboarded({
          deletable: true,
          emptying: [
            {
              physicalName: "grasp-gone-files",
              emptyBy: new Date(Date.now() + 86_400_000),
            },
          ],
        }),
      ],
    });
    const item = offboardedItem(due.container, "gone");

    expect({
      confirm: item.confirmOff,
      waits: item.text.includes("It can be deleted from"),
      emptying: item.text.includes("grasp-gone-files still held objects"),
    }).toStrictEqual({ confirm: false, waits: false, emptying: true });
  });

  it("says so when no client is offboarded", async () => {
    const { main } = await openAdmin("/platform/offboarded", {
      fetchOffboardedClients: [],
    });

    expect(main()).toContain("No client is offboarded");
  });

  it("says a release that isn't one isn't there, asking the Worker nothing", async () => {
    const { main, calls } = await openAdmin("/platform/releases/not-a-release");

    expect({
      notHere: main().includes("This page is not here"),
      asked: calls.some(({ fn }) => fn === "fetchRelease"),
    }).toStrictEqual({ notHere: true, asked: false });
  });
});

/** Beta: on 39.01.09, three companies following it, two of them failed, 39.01.10 to promote. */
const beta: ChannelProgress = {
  channel: "beta",
  releaseId: "39.01.09",
  notes: "",
  total: 3,
  upToDate: 1,
  following: 3,
  failed: true,
  clients: [
    {
      id: "a",
      name: "Acme",
      state: "failed",
      running: null,
      pinnedReleaseId: null,
      error: "deploy_failed",
    },
    {
      id: "b",
      name: "Bolt",
      state: "failed",
      running: null,
      pinnedReleaseId: null,
      error: "deploy_failed",
    },
    {
      id: "c",
      name: "Cork",
      state: "up_to_date",
      running: "39.01.09",
      pinnedReleaseId: null,
      error: null,
    },
  ],
  promotable: [{ releaseId: "39.01.10", back: false }],
};

/** Platform with Beta, every move applied; what it sent, by function. */
const openPlatform = async () => {
  const page = await openAdmin("/platform", {
    ...platformAnswers(ready),
    fetchPlatform: { channels: [beta], history: [], events: [] },
    fetchChannels: [beta],
    promoteReleaseFn: { done: true, refused: null },
    retryChannelFn: { done: true, refused: null },
  });
  const sent = (fn: string) =>
    page.calls.filter((call) => call.fn === fn).map((call) => call.data);
  return { ...page, sent };
};

/** The button named `name` (its words) in `root`. */
const buttonIn = (root: Element | Document, name: string) =>
  [...root.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name
  );

/** Presses `name` in what `root` gives, once it is there. */
const press = async (root: () => Element | Document, name: string) => {
  await until(() => buttonIn(root(), name) !== undefined);
  await act(() => {
    buttonIn(root(), name)?.click();
  });
  await settle();
};

/** The question, while it stands. */
const question = () => document.querySelector('[role="alertdialog"]');

/** Beta's part of the channels, named by its heading. */
const betaPanel = (root: Element) =>
  root.querySelector('section[aria-labelledby="channel-beta"]') ?? root;

/** Presses Escape where focus is. */
const escape = async () => {
  await act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });
  await settle();
};

describe("moving a channel's companies", () => {
  it("promotes a release only once staff confirm, naming the channel, the release and how many companies move", async () => {
    const page = await openPlatform();
    await press(() => betaPanel(page.container), "Promote");
    const asked = {
      words: question()?.textContent ?? "",
      focus: document.activeElement?.textContent?.trim(),
    };
    await press(() => question() ?? document, "Promote");
    await until(() => page.sent("promoteReleaseFn").length > 0);

    expect({
      title: asked.words.includes("Promote 39.01.10 to Beta?"),
      reach: asked.words.includes("3 companies on Beta move to 39.01.10"),
      focus: asked.focus,
      sent: page.sent("promoteReleaseFn"),
    }).toStrictEqual({
      title: true,
      reach: true,
      focus: "Cancel",
      sent: [{ channel: "beta", releaseId: "39.01.10" }],
    });
  });

  it("retries a channel's failed deploys only once staff confirm, naming how many companies try again", async () => {
    const page = await openPlatform();
    await press(() => betaPanel(page.container), "Retry");
    const words = question()?.textContent ?? "";
    await press(() => question() ?? document, "Retry");
    await until(() => page.sent("retryChannelFn").length > 0);

    expect({
      title: words.includes("Retry Beta’s failed deploys?"),
      reach: words.includes(
        "2 companies on Beta whose deploy failed try again, each with the release it was being given"
      ),
      sent: page.sent("retryChannelFn"),
    }).toStrictEqual({ title: true, reach: true, sent: [{ channel: "beta" }] });
  });

  it("moves nothing when staff cancel or press Escape", async () => {
    const page = await openPlatform();
    /** Asks `name`, cancels, asks again and presses Escape: whether the question stayed open each time. */
    const askAndLeave = async (name: string) => {
      await press(() => betaPanel(page.container), name);
      await press(() => question() ?? document, "Cancel");
      const cancelled = { open: question() !== null };
      await press(() => betaPanel(page.container), name);
      await escape();
      return [cancelled, { open: question() !== null }];
    };
    const outcomes = [
      ...(await askAndLeave("Promote")),
      ...(await askAndLeave("Retry")),
    ];

    expect({
      outcomes,
      promoted: page.sent("promoteReleaseFn"),
      retried: page.sent("retryChannelFn"),
    }).toStrictEqual({
      outcomes: [
        { open: false },
        { open: false },
        { open: false },
        { open: false },
      ],
      promoted: [],
      retried: [],
    });
  });
});

describe("Platform's figure of who is up to date", () => {
  it("counts pinned companies apart from those up to date with their channel", async () => {
    const stable: ChannelProgress = {
      ...beta,
      channel: "stable",
      failed: false,
      total: 2,
      upToDate: 1,
      following: 1,
      clients: [
        {
          id: "c",
          name: "Cork",
          state: "up_to_date",
          running: "39.01.09",
          pinnedReleaseId: null,
          error: null,
        },
        {
          id: "d",
          name: "Dock",
          state: "pinned",
          running: "39.01.08",
          pinnedReleaseId: "39.01.08",
          error: null,
        },
      ],
    };
    const { container } = await openAdmin("/platform", {
      ...platformAnswers(ready),
      fetchPlatform: { channels: [stable], history: [], events: [] },
    });

    expect(figureOf(container, "Up to date")).toBe(
      "Up to date1 of 1On their channel’s release"
    );
  });
});
