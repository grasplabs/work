// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import type { OffboardedClient } from "../hosting/offboarding.ts";
import { gridRow, openAdmin } from "../test-app.tsx";
import type { Answers } from "../test-app.tsx";
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
  const confirm = item?.querySelector('[id^="no-export-"]');
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

    expect(main()).toContain("No client is offboarded.");
  });

  it("says a release that isn't one isn't there, asking the Worker nothing", async () => {
    const { main, calls } = await openAdmin("/platform/releases/not-a-release");

    expect({
      notHere: main().includes("This page is not here"),
      asked: calls.some(({ fn }) => fn === "fetchRelease"),
    }).toStrictEqual({ notHere: true, asked: false });
  });
});
