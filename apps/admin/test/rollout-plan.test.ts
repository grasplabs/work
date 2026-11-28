import { describe, expect, it } from "vite-plus/test";

import type { Channel } from "../src/rollout/channel-ids.ts";
import type { ChannelReleases } from "../src/rollout/desired.ts";
import { planPass, rolloutLimits } from "../src/rollout/plan.ts";
import type {
  Admission,
  Organization,
  PassFacts,
  Rollout,
} from "../src/rollout/plan.ts";

// What the fleet's rollout pass decides (src/rollout/plan.ts). How it can
// go wrong:
// - a large organization before a small one, a late one before any
//   other (a stored `own` among them), or ties taken in no fixed order;
// - more than one organization deploying a release first;
// - more runs out than slow start, the fleet's slots or the API budget
//   allow, or any starting while a 429 blocks the token;
// - one rollout starving another;
// - a rollout going on past 3 failures; or halting on 2, on a platform
//   fault, or on another rollout's;
// - an organization whose failure isn't the rollout's own (a platform
//   fault, an earlier rollout's) never tried again;
// - a superseded rollout's runs filling or halting the new one;
// - a rollout called done while one of its organizations is out, or one
//   that waits;
// - an organization outside any rollout (pinned, secrets behind, joining
//   a done channel) never deploying, or deploying ahead of a rollout, or
//   one waiting on a halted rollout deploying anyway.

const before = "26.11.1";
const release = "26.11.2";
const next = "26.11.3";

const releases: ChannelReleases = {
  edge: release,
  beta: release,
  stable: release,
};

const org = (
  id: string,
  overrides: Partial<Organization> = {}
): Organization => ({
  id,
  channel: "stable",
  pinnedReleaseId: null,
  running: before,
  secretsBehind: false,
  deploy: null,
  group: "normal",
  size: 0,
  platformFaults: 0,
  ...overrides,
});

const rolloutOn = (
  channel: Channel,
  overrides: Partial<Rollout> = {}
): Rollout => ({
  id: `r-${channel}`,
  channel,
  releaseId: release,
  status: "running",
  ...overrides,
});

const factsOf = (
  organizations: readonly Organization[],
  overrides: Partial<PassFacts> = {}
): PassFacts => ({
  rollouts: [rolloutOn("stable")],
  organizations,
  releases,
  inFlight: 0,
  budget: { remaining: null, blockedUntil: null },
  now: new Date("2026-11-28T10:00:00Z"),
  ...overrides,
});

/** `organization` with a deploy of `rolloutId`'s release in `status`. */
const deployed = (
  organization: Organization,
  rolloutId: string,
  status: "deploying" | "done" | "failed",
  error: string | null = status === "failed" ? "probe_failed" : null
): Organization => ({
  ...organization,
  running: status === "done" ? release : organization.running,
  deploy: { releaseId: release, status, error, rolloutId },
});

const byId = (a: string | undefined, b: string | undefined): number =>
  (a ?? "").localeCompare(b ?? "");

const idsOf = (admit: readonly Admission[]): string[] =>
  admit.map(({ clientId }) => clientId);

/** What a run of passes did: each pass's admissions, and how the rollouts ended. */
interface Simulated {
  passes: string[][];
  order: string[];
  rollouts: Rollout[];
  organizations: Organization[];
}

/**
 * Runs passes over `start` as the pass would meet them, until one admits
 * no one: each admitted organization's run ends before the next pass,
 * on the release, or failed where `fails` says so. A halt or done is
 * kept on the rollout, as the pass records it.
 */
const simulate = (
  start: PassFacts,
  fails: (id: string) => boolean = () => false
): Simulated => {
  let { rollouts, organizations } = start;
  const passes: string[][] = [];
  for (let pass = 0; pass < 10_000; pass += 1) {
    const plan = planPass({ ...start, rollouts, organizations });
    const halted = new Set(plan.halt);
    rollouts = rollouts.map((rollout) => {
      if (halted.has(rollout.id)) {
        return { ...rollout, status: "halted" as const };
      }
      return plan.done.includes(rollout.id)
        ? { ...rollout, status: "done" as const }
        : rollout;
    });
    const admitted = new Map(
      plan.admit.map((admission) => [admission.clientId, admission])
    );
    organizations = organizations.map((organization) => {
      const admission = admitted.get(organization.id);
      if (admission === undefined) {
        return organization;
      }
      const failed = fails(organization.id);
      return {
        ...organization,
        running: failed ? organization.running : admission.releaseId,
        secretsBehind: failed && organization.secretsBehind,
        deploy: {
          releaseId: admission.releaseId,
          status: failed ? ("failed" as const) : ("done" as const),
          error: failed ? "probe_failed" : null,
          rolloutId: admission.rolloutId,
        },
      };
    });
    if (
      plan.admit.length === 0 &&
      plan.halt.length === 0 &&
      plan.done.length === 0
    ) {
      return {
        passes,
        order: passes.flat(),
        rollouts: [...rollouts],
        organizations: [...organizations],
      };
    }
    if (plan.admit.length > 0) {
      passes.push(idsOf(plan.admit));
    }
  }
  throw new Error("The passes never settled");
};

/**
 * `count` organizations on Stable: every tenth late, every seventh a
 * stored `own`, sizes from a fixed spread with ties.
 */
const fleet = (count: number): Organization[] =>
  Array.from({ length: count }, (_, index) => {
    const id = `o${String(index).padStart(4, "0")}`;
    let group: Organization["group"] = "normal";
    if (index % 10 === 9) {
      group = "late";
    } else if (index % 7 === 0) {
      group = "own";
    }
    return org(id, { group, size: (index * 37) % 23 });
  });

/** 1 for a late organization, else 0. */
const late = (organization: Organization) =>
  organization.group === "late" ? 1 : 0;

/** `organizations` in the order a rollout takes them: late ones last; each part by size, then id. */
const expectedOrder = (organizations: readonly Organization[]): string[] =>
  organizations
    .toSorted(
      (a, b) => late(a) - late(b) || a.size - b.size || (a.id < b.id ? -1 : 1)
    )
    .map(({ id }) => id);

describe("the order a rollout takes", () => {
  it("deploys a release to one organization first, the smallest, whatever its group", () => {
    const organizations = [
      org("a-small", { size: 1 }),
      org("own-big", { group: "own", size: 90 }),
      org("own-small", { group: "own", size: 5 }),
      org("b-small", { size: 2 }),
    ];

    const { passes } = simulate(factsOf(organizations));

    expect(passes).toStrictEqual([
      ["a-small"],
      ["b-small", "own-small"],
      ["own-big"],
    ]);
  });

  it("goes smallest first, ties by id, late ones last, unknown sizes as 0, a stored own like any other", () => {
    const organizations = [
      org("late-tiny", { group: "late", size: 0 }),
      org("ours", { group: "own", size: 4 }),
      org("c", { size: 3 }),
      org("b", { size: 3 }),
      org("unknown"),
      org("a", { size: 10 }),
    ];
    // Slow start past: plenty already on the release.
    const onIt = Array.from({ length: 20 }, (_, index) =>
      org(`on-${String(index).padStart(2, "0")}`, { running: release })
    );

    const plan = planPass(factsOf([...organizations, ...onIt]));

    expect(idsOf(plan.admit)).toStrictEqual([
      "unknown",
      "b",
      "c",
      "ours",
      "a",
      "late-tiny",
    ]);
  });
});

describe("how many start at once", () => {
  it("lets a rollout have at most 1 + its done count out, doubling as it proves itself", () => {
    const { passes } = simulate(factsOf(fleet(40)));

    expect(passes.map((admitted) => admitted.length)).toStrictEqual([
      1, 2, 4, 8, 16, 9,
    ]);
  });

  it(`keeps at most ${rolloutLimits.maxInFlight} out across the fleet, runs out of any kind counted`, () => {
    const onIt = Array.from({ length: 30 }, (_, index) =>
      org(`on-${String(index).padStart(2, "0")}`, { running: release })
    );
    const waiting = Array.from({ length: 30 }, (_, index) =>
      org(`w-${String(index).padStart(2, "0")}`)
    );

    const free = planPass(factsOf([...onIt, ...waiting]));
    const busy = planPass(factsOf([...onIt, ...waiting], { inFlight: 5 }));
    const full = planPass(
      factsOf([...onIt, ...waiting], { inFlight: rolloutLimits.maxInFlight })
    );

    expect({
      free: free.admit.length,
      busy: busy.admit.length,
      full: full.admit.length,
    }).toStrictEqual({
      free: rolloutLimits.maxInFlight,
      busy: rolloutLimits.maxInFlight - 5,
      full: 0,
    });
  });

  it("takes rollouts in turn, Edge, Beta, then Stable, so none starves another", () => {
    const organizations = (["edge", "beta", "stable"] as const).flatMap(
      (channel) => [
        ...Array.from({ length: 10 }, (_, index) =>
          org(`${channel}-on-${String(index)}`, { channel, running: release })
        ),
        ...Array.from({ length: 10 }, (_, index) =>
          org(`${channel}-${String(index).padStart(2, "0")}`, { channel })
        ),
      ]
    );
    const plan = planPass(
      factsOf(organizations, {
        rollouts: [rolloutOn("edge"), rolloutOn("beta"), rolloutOn("stable")],
      })
    );

    // One each in turn until the fleet's slots are full.
    const turns = ["r-edge", "r-beta", "r-stable"];
    expect(plan.admit.map(({ rolloutId }) => rolloutId)).toStrictEqual(
      Array.from(
        { length: rolloutLimits.maxInFlight },
        (_, index) => turns[index % turns.length]
      )
    );
  });

  it("gives one slot freed to the rollout with fewest out, not always Edge", () => {
    const organizations = (["edge", "beta"] as const).flatMap((channel) => [
      ...Array.from({ length: 5 }, (_, index) =>
        org(`${channel}-on-${String(index)}`, { channel, running: release })
      ),
      org(`${channel}-waiting`, { channel }),
    ]);
    const out = ["edge-out-1", "edge-out-2"].map((id) =>
      deployed(org(id, { channel: "edge" }), "r-edge", "deploying")
    );

    const plan = planPass(
      factsOf([...organizations, ...out], {
        rollouts: [rolloutOn("edge"), rolloutOn("beta")],
        inFlight: rolloutLimits.maxInFlight - 1,
      })
    );

    expect(plan.admit).toStrictEqual([
      { clientId: "beta-waiting", releaseId: release, rolloutId: "r-beta" },
    ]);
  });

  it("starts one more only while the budget's left covers its reserve and every run out, and none while a 429 blocks", () => {
    const onIt = Array.from({ length: 30 }, (_, index) =>
      org(`on-${String(index).padStart(2, "0")}`, { running: release })
    );
    const waiting = Array.from({ length: 30 }, (_, index) =>
      org(`w-${String(index).padStart(2, "0")}`)
    );
    const now = new Date("2026-11-28T10:00:00Z");
    const plan = (budget: PassFacts["budget"], inFlight = 0) =>
      planPass(factsOf([...onIt, ...waiting], { budget, inFlight, now }));

    expect({
      // 290 left: 200 kept back, 30 a run, from 0 to 3 out.
      some: plan({ remaining: 290, blockedUntil: null }).admit.length,
      busy: plan({ remaining: 290, blockedUntil: null }, 2).admit.length,
      none: plan({ remaining: 199, blockedUntil: null }).admit.length,
      barely: plan({ remaining: 229, blockedUntil: null }).admit.length,
      blocked: (({ blocked, admit }) => [blocked, admit])(
        plan({ remaining: null, blockedUntil: new Date(now.getTime() + 1) })
      ),
      blockPassed: plan({ remaining: null, blockedUntil: now }).admit.length,
    }).toStrictEqual({
      some: 4,
      busy: 2,
      none: 0,
      barely: 1,
      blocked: [true, []],
      blockPassed: rolloutLimits.maxInFlight,
    });
  });

  it("gives a slot whose start was refused to the next in order", () => {
    const plan = planPass(
      factsOf([org("a", { size: 1 }), org("b", { size: 2 })], {
        skip: new Set(["a"]),
      })
    );

    expect(idsOf(plan.admit)).toStrictEqual(["b"]);
  });
});

describe("when a rollout halts", () => {
  const ofRollout = (
    ids: readonly string[],
    status: "deploying" | "done" | "failed",
    overrides: Partial<Organization> = {},
    error?: string
  ) => ids.map((id) => deployed(org(id, overrides), "r-stable", status, error));

  it("halts at the third failure, not the second, one of ours like any other", () => {
    const three = planPass(
      factsOf([
        ...ofRollout(["a", "b"], "failed"),
        ...ofRollout(["ours"], "failed", { group: "own" }),
        org("waiting"),
      ])
    );
    const two = planPass(
      factsOf([
        ...ofRollout(["a", "ours"], "failed", {}),
        ...ofRollout(["x", "y"], "done"),
        org("waiting"),
      ])
    );

    expect({
      three: [three.halt, three.admit],
      two: [two.halt, idsOf(two.admit)],
    }).toStrictEqual({
      three: [["r-stable"], []],
      two: [[], ["waiting"]],
    });
  });

  it("never counts a platform fault, or another rollout's failure, and tries those organizations again", () => {
    const onIt = Array.from({ length: 10 }, (_, index) =>
      org(`on-${String(index)}`, { running: release })
    );
    const plan = planPass(
      factsOf([
        ...onIt,
        ...ofRollout(["rate"], "failed", {}, "cloudflare_429_10000"),
        ...ofRollout(["engine"], "failed", {}, "run_not_created"),
        ...ofRollout(["taken"], "failed", {}, "runner_replaced"),
        deployed(org("other-a"), "r-older", "failed"),
        deployed(org("other-b"), "r-older", "failed"),
        deployed(org("other-c"), "r-older", "failed"),
        ...ofRollout(["real"], "failed"),
      ])
    );

    expect({
      halt: plan.halt,
      failed: plan.counts.get("r-stable")?.failed,
      retried: idsOf(plan.admit).toSorted(byId),
    }).toStrictEqual({
      halt: [],
      failed: 1,
      // The rollout's own failure waits for staff; the rest go again.
      retried: ["engine", "other-a", "other-b", "other-c", "rate", "taken"],
    });
  });

  it("counts no failure of an organization pinned or moved since", () => {
    const plan = planPass(
      factsOf([
        ...ofRollout(["a", "b"], "failed"),
        ...ofRollout(["pinned"], "failed", { pinnedReleaseId: before }),
        ...ofRollout(["moved"], "failed", { channel: "beta" }),
        org("waiting"),
      ])
    );

    expect([plan.halt, plan.counts.get("r-stable")?.failed]).toStrictEqual([
      [],
      2,
    ]);
  });

  it("sets aside an organization after 3 platform faults in a row, and goes on to the next, never halting", () => {
    // Over 30 passes, "a-stuck", the smallest, ends every run in a 429.
    let organizations: Organization[] = [
      org("a-stuck"),
      ...Array.from({ length: 5 }, (_, index) =>
        org(`b-${String(index)}`, { size: 1 })
      ),
    ];
    const admitted: string[] = [];
    const setAside: string[] = [];
    let halted = false;
    for (let pass = 0; pass < 30; pass += 1) {
      const plan = planPass(factsOf(organizations));
      halted ||= plan.halt.length > 0;
      setAside.push(...plan.setAside.map(({ clientId }) => clientId));
      const now = new Set(plan.admit.map(({ clientId }) => clientId));
      admitted.push(...now);
      organizations = organizations.map((organization) => {
        if (!now.has(organization.id)) {
          return organization;
        }
        const stuck = organization.id === "a-stuck";
        const last = organization.deploy;
        return {
          ...organization,
          running: stuck ? organization.running : release,
          // As the claim counts them: a platform fault on the same
          // release and rollout before this one.
          platformFaults:
            last?.status === "failed" && last.error === "cloudflare_429_10000"
              ? organization.platformFaults + 1
              : 0,
          deploy: {
            releaseId: release,
            status: stuck ? ("failed" as const) : ("done" as const),
            error: stuck ? "cloudflare_429_10000" : null,
            rolloutId: "r-stable",
          },
        };
      });
    }

    expect({
      stuckStarts: admitted.filter((id) => id === "a-stuck").length,
      othersDone: organizations
        .filter(({ id }) => id !== "a-stuck")
        .every(({ running }) => running === release),
      halted,
      // Reported by every pass from the third fault on: alerted once, by
      // its key.
      setAside: [...new Set(setAside)],
    }).toStrictEqual({
      stuckStarts: 3,
      othersDone: true,
      halted: false,
      setAside: ["a-stuck"],
    });
  });

  it("halts as runs end, wherever the third failure falls in the order", () => {
    const organizations = fleet(100);
    const order = expectedOrder(organizations);
    const failing = new Set([order[10], order[40], order[41]]);

    const { rollouts, organizations: after } = simulate(
      factsOf(organizations),
      (id) => failing.has(id)
    );
    const failed = after.filter(({ deploy }) => deploy?.status === "failed");

    expect({
      status: rollouts[0]?.status,
      failed: failed.map(({ id }) => id).toSorted(byId),
      // Nothing started past the pass that met the third failure.
      left: after.some(({ deploy }) => deploy === null),
    }).toStrictEqual({
      status: "halted",
      failed: [...failing].toSorted(byId),
      left: true,
    });
  });

  it("admits nothing for a halted rollout", () => {
    const plan = planPass(
      factsOf([...ofRollout(["a", "b", "c"], "failed"), org("waiting")], {
        rollouts: [rolloutOn("stable", { status: "halted" })],
      })
    );

    expect([plan.halt, plan.admit]).toStrictEqual([[], []]);
  });
});

describe("when a rollout is done", () => {
  it("is done once every organization following its channel runs the release and none is out, pinned ones aside", () => {
    const pinned = org("pinned", { pinnedReleaseId: before, running: before });
    const out = planPass(
      factsOf([
        org("on", { running: release }),
        deployed(org("going", { running: release }), "r-stable", "deploying"),
        pinned,
      ])
    );
    const done = planPass(factsOf([org("on", { running: release }), pinned]));
    const failedOne = planPass(
      factsOf([
        org("on", { running: release }),
        deployed(org("failed"), "r-stable", "failed"),
      ])
    );
    // Its Workers on the release, but its deploy of it failed part way.
    const failedPartWay = planPass(
      factsOf([
        org("on", { running: release }),
        {
          ...deployed(org("part-way"), "r-stable", "failed"),
          running: release,
        },
      ])
    );
    const empty = planPass(factsOf([]));

    expect({
      out: out.done,
      done: done.done,
      failedOne: failedOne.done,
      failedPartWay: [
        failedPartWay.done,
        failedPartWay.counts.get("r-stable")?.done,
      ],
      empty: empty.done,
    }).toStrictEqual({
      out: [],
      done: ["r-stable"],
      failedOne: [],
      failedPartWay: [[], 1],
      empty: ["r-stable"],
    });
  });
});

describe("a channel moved mid-rollout", () => {
  it("starts the new rollout with one, the old one's runs counted against the fleet's slots only, its failures tried again", () => {
    const newer: Rollout = {
      ...rolloutOn("stable"),
      id: "r-next",
      releaseId: next,
    };
    const organizations = [
      deployed(org("old-out"), "r-stable", "deploying"),
      deployed(org("old-failed-1"), "r-stable", "failed"),
      deployed(org("old-failed-2"), "r-stable", "failed"),
      deployed(org("old-failed-3"), "r-stable", "failed"),
      org("on-old", { running: release, size: 1 }),
    ];

    const plan = planPass(
      factsOf(organizations, {
        rollouts: [newer],
        releases: { ...releases, stable: next },
        inFlight: 1,
      })
    );

    expect({
      halt: plan.halt,
      counts: plan.counts.get("r-next"),
      admit: plan.admit,
    }).toStrictEqual({
      halt: [],
      counts: { done: 0, failed: 0, inFlight: 0, following: 5 },
      admit: [
        { clientId: "old-failed-1", releaseId: next, rolloutId: "r-next" },
      ],
    });
  });
});

describe("deploys outside any rollout", () => {
  it("start in the slots the rollouts leave: pinned, secrets behind, or joining a done channel; never ahead of a halted rollout", () => {
    const organizations = [
      org("pinned", { pinnedReleaseId: next }),
      org("secrets", { running: release, secretsBehind: true }),
      org("edge-straggler", { channel: "edge" }),
      org("beta-waits", { channel: "beta" }),
      org("beta-secrets", {
        channel: "beta",
        running: release,
        secretsBehind: true,
      }),
      org("stable-waiting", { size: 1 }),
      ...Array.from({ length: 5 }, (_, index) =>
        org(`stable-on-${String(index)}`, { running: release })
      ),
    ];

    const plan = planPass(
      factsOf(organizations, {
        rollouts: [
          rolloutOn("edge", { status: "done" }),
          rolloutOn("beta", { status: "halted" }),
          rolloutOn("stable"),
        ],
      })
    );

    expect(plan.admit).toStrictEqual([
      { clientId: "stable-waiting", releaseId: release, rolloutId: "r-stable" },
      { clientId: "beta-secrets", releaseId: release, rolloutId: null },
      { clientId: "edge-straggler", releaseId: release, rolloutId: null },
      { clientId: "pinned", releaseId: next, rolloutId: null },
      { clientId: "secrets", releaseId: release, rolloutId: null },
    ]);
  });

  it("tries one again whose last deploy failed for the platform's fault, and leaves one that failed for its own to staff", () => {
    const failedWith = (id: string, error: string) =>
      org(id, {
        pinnedReleaseId: next,
        deploy: { releaseId: next, status: "failed", error, rolloutId: null },
      });
    const plan = planPass(
      factsOf([
        failedWith("limited", "cloudflare_429_10000"),
        failedWith("broken", "smoke_check_failed"),
      ])
    );

    expect(plan.admit).toStrictEqual([
      { clientId: "limited", releaseId: next, rolloutId: null },
    ]);
  });

  it("waits while its channel has a release but no rollout yet", () => {
    const plan = planPass(factsOf([org("waiting")], { rollouts: [] }));

    expect(plan.admit).toStrictEqual([]);
  });
});

describe("a whole fleet", () => {
  it.each([
    { count: 10, widest: 4 },
    { count: 100, widest: rolloutLimits.maxInFlight },
    { count: 1000, widest: rolloutLimits.maxInFlight },
  ])(
    "takes $count organizations to the release in order, within every limit",
    ({ count, widest }) => {
      const organizations = fleet(count);

      const result = simulate(factsOf(organizations));

      expect({
        order: result.order,
        status: result.rollouts[0]?.status,
        onRelease: result.organizations.every(
          ({ running }) => running === release
        ),
        first: result.passes[0]?.length,
        widest: Math.max(...result.passes.map((pass) => pass.length)),
      }).toStrictEqual({
        order: expectedOrder(organizations),
        status: "done",
        onRelease: true,
        first: 1,
        widest,
      });
    }
  );
});
