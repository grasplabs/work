import { describe, expect, it } from "vite-plus/test";

import {
  BUILD_STAGES,
  needsGrasp,
  nextRing,
  sortBuilds,
  waitingOnGrasp,
  waitsOn,
  withRollout,
} from "../../src/admin/admin-integrations.ts";
import type {
  BuildRequest,
  IntegrationBuild,
} from "../../src/admin/admin-integrations.ts";
import type { Rollout } from "../../src/admin/admin-platform.ts";
import { SAMPLE_BUILDS } from "./fixtures/admin-integrations-sample.ts";
import {
  SAMPLE_PLATFORMS,
  SAMPLE_RELEASES,
} from "./fixtures/admin-platform-sample.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const build = (more: Partial<IntegrationBuild> = {}): IntegrationBuild => ({
  id: "acme",
  app: "Acme Books",
  about: "Bookkeeping.",
  docs: "https://acme.example/docs",
  auth: "oauth2",
  actions: [{ name: "Read invoices", access: "read" }],
  requests: [
    {
      org: "noordkade",
      workflows: ["Matching invoices"],
      on: "2026-10-01",
      by: "Eva",
    },
  ],
  stage: "requested",
  reached: { requested: "2026-10-01" },
  ...more,
});

const asked = (org: string): BuildRequest => ({
  org,
  workflows: ["x"],
  on: "2026-09-01",
  by: "Someone",
});

describe("what a build waits on", () => {
  it("names someone for every step: Grasp’s agent, a person at Grasp, or the companies", () => {
    for (const stage of BUILD_STAGES) {
      expect(["agent", "grasp", "company"]).toContain(waitsOn(stage));
    }
    expect(waitsOn("declined")).toBe("nobody");
  });

  it("needs a person at Grasp to start it and at the plan, the credentials, the review and the rollout, and nowhere else", () => {
    expect(
      BUILD_STAGES.filter((stage) => waitsOn(stage) === "grasp")
    ).toStrictEqual(["requested", "plan", "credentials", "review", "rollout"]);
    expect(
      waitingOnGrasp([
        build(),
        build({ stage: "writing" }),
        build({ stage: "review" }),
        build({ stage: "declined" }),
      ])
    ).toBe(2);
  });
});

describe("the order of the list", () => {
  it("puts what waits on Grasp first, then the agent’s, then what the companies can connect, then what is not built", () => {
    const builds = [
      build({ id: "no", stage: "declined" }),
      build({ id: "live", stage: "live" }),
      build({ id: "agent", stage: "writing" }),
      build({ id: "grasp", stage: "plan" }),
    ];
    expect(sortBuilds(builds).map((each) => each.id)).toStrictEqual([
      "grasp",
      "agent",
      "live",
      "no",
    ]);
  });

  it("within the same, puts the app most companies asked for first, then the one asked for longest ago", () => {
    const two = build({
      id: "two",
      requests: [
        ...build().requests,
        { org: "hartog", workflows: ["x"], on: "2026-10-05", by: "Hanneke" },
      ],
    });
    const old = build({
      id: "old",
      requests: [
        { org: "vanrijn", workflows: ["x"], on: "2026-09-01", by: "Bart" },
      ],
    });
    const recent = build({ id: "recent" });
    expect(sortBuilds([recent, old, two]).map((each) => each.id)).toStrictEqual(
      ["two", "old", "recent"]
    );
    expect(needsGrasp(two)).toBeTruthy();
  });
});

describe("the rollout of a build", () => {
  it("reaches the companies ring by ring, whatever order they are listed in", () => {
    const rolling = build({
      stage: "rollout",
      work: {
        session: "s",
        branch: "b",
        minutes: 1,
        cost: 1,
        release: "r004812-3f9c2ab",
        rollout: [
          { org: "b", ring: 2, status: "pending", live: null },
          { org: "a", ring: 0, status: "pending", live: null },
        ],
      },
    });
    expect(nextRing(rolling)).toBe(0);
    expect(needsGrasp(rolling)).toBeTruthy();
  });
});

describe("the console’s rollout", () => {
  const rollout: Rollout = {
    id: "ro-418",
    kind: "release",
    release: "r418-3f9c2ab",
    status: "waiting",
    ring: 1,
    by: "Nick",
    at: "2026-10-14T08:00:00Z",
    targets: [
      { org: "hartog", ring: 0, status: "done" },
      { org: "noordkade", ring: 1, status: "done" },
      { org: "veldkamp", ring: 2, status: "pending" },
    ],
  };
  const inRelease = build({
    stage: "rollout",
    requests: [asked("noordkade"), asked("veldkamp")],
    work: {
      session: "s",
      branch: "b",
      minutes: 1,
      cost: 1,
      release: "r418-3f9c2ab",
    },
  });

  it("stands at each company that asked where the console’s rollout of its release stands", () => {
    const now = withRollout(inRelease, rollout);
    expect(now.work?.rollout).toStrictEqual([
      { org: "noordkade", ring: 1, status: "done", live: "2026-10-14" },
      { org: "veldkamp", ring: 2, status: "pending", live: null },
    ]);
    expect(nextRing(now)).toBe(2);
    expect(needsGrasp(now)).toBeTruthy();
  });

  it("waits on nobody while a ring deploys, and is live once every company that asked runs it", () => {
    const deploying = withRollout(inRelease, {
      ...rollout,
      status: "running",
      ring: 2,
      targets: rollout.targets.map((target) =>
        target.ring === 2 ? { ...target, status: "deploying" } : target
      ),
    });
    expect(nextRing(deploying)).toBeUndefined();
    expect(needsGrasp(deploying)).toBeFalsy();
    const done = withRollout(inRelease, {
      ...rollout,
      status: "done",
      targets: rollout.targets.map((target) => ({
        ...target,
        status: "done",
      })),
    });
    expect(done.stage).toBe("live");
  });

  it("leaves a build in another release as it was", () => {
    const other = build({
      stage: "rollout",
      work: {
        session: "s",
        branch: "b",
        minutes: 1,
        cost: 1,
        release: "r419-0000000",
      },
    });
    expect(withRollout(other, rollout)).toBe(other);
  });
});

describe("the sample integrations to build", () => {
  it("asks only for workflows the sample organizations have", () => {
    for (const each of SAMPLE_BUILDS) {
      for (const request of each.requests) {
        const org = SAMPLE_ORGS.find((sample) => sample.id === request.org);
        expect(org).toBeDefined();
        const names = new Set(org?.works.map((work) => work.name));
        for (const workflow of request.workflows) {
          expect(names).toContain(workflow);
        }
      }
    }
  });

  it("shows every kind of wait, and has a day for every step it reached", () => {
    expect(
      new Set(SAMPLE_BUILDS.map((each) => waitsOn(each.stage)))
    ).toStrictEqual(new Set(["grasp", "agent", "nobody"]));
    for (const each of SAMPLE_BUILDS) {
      const reached =
        each.stage === "declined"
          ? []
          : BUILD_STAGES.slice(0, BUILD_STAGES.indexOf(each.stage) + 1);
      expect(
        [each.stage, ...reached].every(
          (step) => each.reached[step] !== undefined
        )
      ).toBeTruthy();
    }
  });

  it("rolls out in the ring each organization’s platform is in, to the organizations that asked", () => {
    const platforms = new Map(Object.entries(SAMPLE_PLATFORMS));
    for (const each of SAMPLE_BUILDS) {
      for (const at of each.work?.rollout ?? []) {
        expect(platforms.get(at.org)?.ring).toBe(at.ring);
        expect(each.requests.map((request) => request.org)).toContain(at.org);
      }
    }
  });

  it("goes out in a release the console has, merged before that release was made", () => {
    const released = SAMPLE_BUILDS.filter(
      (each) => each.work?.release !== undefined
    );
    expect(released.length).toBeGreaterThan(0);
    for (const each of released) {
      const release = SAMPLE_RELEASES.find(
        (one) => one.id === each.work?.release
      );
      expect(release).toBeDefined();
      expect((each.reached.merged ?? "") <= (release?.on ?? "")).toBeTruthy();
    }
  });

  it("opens its pull requests in Grasp’s own repository, on a connector branch", () => {
    const prs = SAMPLE_BUILDS.flatMap((each) =>
      each.work?.pr ? [each.work.pr] : []
    );
    expect(prs.length).toBeGreaterThan(0);
    for (const pr of prs) {
      expect(pr.url).toBe(
        `https://github.com/grasplabs/work/pull/${pr.number}`
      );
    }
    for (const work of SAMPLE_BUILDS.flatMap((each) =>
      each.work ? [each.work] : []
    )) {
      expect(work.branch).toMatch(/^feat\/connector-[a-z0-9-]+$/u);
    }
  });
});
