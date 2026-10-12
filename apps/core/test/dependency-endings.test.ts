import type { AuditEvent } from "@grasp-os/shared/audit";
import type {
  DependencyRequest,
  DependencyTarget,
} from "@grasp-os/shared/dependencies";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { PackageBuild } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeApprover } from "../src/dependencies/approvers.ts";
import {
  endDependency,
  proposeForTests,
} from "../src/dependencies/requests.ts";
import { buildDependencies } from "../src/packages/build.ts";
import { mockIdp } from "./idp.ts";
import { intentFor, named, plain, publish } from "./npm.ts";
import { racingDb } from "./racing-db.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Retiring and revoking an App's approved npm graph (spec 19.3.1,
// src/dependencies/requests.ts `endDependency`), from its threat model:
// a revoked graph still built, handed out or served; a retired graph
// admitting anything new (a new pin, a resolve that finds the approval
// standing, a build that pins after the fence) or breaking what was built
// before; a build racing the decision with no clear winner; the wrong
// person deciding (a role, staff, an agent acting for a holder, someone
// who lost the permission meanwhile); a decision on an impact that
// changed since it was read; history overwritten; an approver's
// approvals taken back with their permission. Packages come from
// connect's strict fake of the npm registry, built and served through
// core's real path.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** An admin who holds `dependencies.approve`, by their own grant. */
const approvingAdmin = async (): Promise<Person> => {
  const admin = await personApi("admin");
  await admin.api.dependencies.grantApprover({
    type: "person",
    userId: admin.userId,
  });
  return admin;
};

/** One small package of ES modules, for both targets. */
const smallPackage = async (): Promise<string> => {
  const name = named("small");
  await publish(plain(name));
  return name;
};

/**
 * An App whose package.json resolved to a new package, for `targets`, and
 * which `approver` approved.
 */
const approvedApp = async (
  approver: Person,
  targets: DependencyTarget[] = ["browser", "server"]
) => {
  const name = await smallPackage();
  const builder = await personApi("builder");
  const { id: app } = await builder.api.apps.create({
    name: `App ${unique()}`,
  });
  const { request } = await builder.api.dependencies.resolve(
    intentFor(app, { [name]: "1.0.0" }, { targets })
  );
  const { policyGeneration } = await approver.api.dependencies.waiting();
  const approval = await approver.api.dependencies.decide(request.id, {
    approved: true,
    reviewed: { graphHash: request.graphHash, policyGeneration },
  });
  return { builder, app, name, request: approval };
};

type Approved = Awaited<ReturnType<typeof approvedApp>>;

/** Builds `target` of the App's graph, under the policy generation now. */
const buildOf = async (
  { builder, app, request }: Approved,
  target: DependencyTarget
): Promise<PackageBuild> => {
  const { policyGeneration } = await builder.api.dependencies.status(app);
  return await builder.api.dependencies.build({
    app,
    graphHash: request.graphHash,
    target,
    policyGeneration,
  });
};

/** Retires or revokes `request`'s graph as `person`, on its impact as read now. */
const end = async (
  person: Person,
  how: "retire" | "revoke",
  request: Pick<DependencyRequest, "id" | "graphHash">,
  reason = "The library is no longer maintained."
) => {
  const { policyGeneration } = await person.api.dependencies.impact(request.id);
  return await person.api.dependencies[how](request.id, {
    reviewed: { graphHash: request.graphHash, policyGeneration },
    reason,
  });
};

/** The status core answers each file of a browser build with, now. */
const servedStatus = async (build: PackageBuild): Promise<number> => {
  if (build.address === null) {
    throw new Error("A browser build has an address");
  }
  const [file] = Object.keys(build.artifact.files);
  const response = await routed(`${build.address}${file}`);
  await response.body?.cancel();
  return response.status;
};

/** The App's lock of its graph, as core stores it, if it is there. */
const storedLock = async ({ app, request }: Approved) => {
  const row = await env.DB.prepare(
    "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
  )
    .bind(app, request.graphHash)
    .first<{ lock: string }>();
  return row ? graspLockSchema.parse(JSON.parse(row.lock)) : undefined;
};

/** Whether the artifact `hash`'s files are queued for the cron to delete. */
const queuedForCleanup = async (hash: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT key FROM package_cleanups WHERE key = ?"
  )
    .bind(hash)
    .first();
  return row !== null;
};

/** The dependency events among `events`, as action and detail. */
const dependencyEvents = (events: AuditEvent[], app: string) =>
  events
    .filter(
      ({ action, detail }) =>
        action.startsWith("dependency.") && detail.app === app
    )
    .map(({ action, detail }) => ({ action, detail }));

const integrity = `sha512-${"A".repeat(86)}==`;

/** A graph handed in as the resolver would, with no lock: for races on the request alone. */
const proposalFor = (app: string, version = "1.0.0") => ({
  app,
  sourceRevision: "rev-1",
  purpose: "Format dates in the report.",
  targets: ["browser"],
  graph: {
    direct: [{ name: "dates", version }],
    packages: [
      {
        name: "dates",
        version,
        origin: "https://registry.npmjs.org",
        integrity,
        license: "MIT",
        dependencies: [],
        peers: [],
      },
    ],
    platformPeers: { react: "19.2.0" },
  },
  findings: [],
  refused: [],
});

describe("revoking an App's approved packages", () => {
  it("stops every use of the graph at once: a build, a kept artifact handed out and each file served", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const browser = await buildOf(approved, "browser");
    const servedBefore = await servedStatus(browser);
    const { policyGeneration: before } =
      await approved.builder.api.dependencies.status(approved.app);

    let ended: DependencyRequest[] = [];
    const events = await auditedDuring(async () => {
      ended = await end(admin, "revoke", approved.request);
    });

    const refused = {
      // The same build again: the kept artifact is not handed out.
      kept: await outcome(buildOf(approved, "browser")),
      // A target never built: nothing new either.
      server: await outcome(buildOf(approved, "server")),
      // The page loading the artifact it was given.
      served: await servedStatus(browser),
    };
    const status = await approved.builder.api.dependencies.status(approved.app);
    const after = {
      // Its lock goes, and the bytes built from it are queued to be deleted.
      lock: await storedLock(approved),
      queued: await queuedForCleanup(browser.hash),
    };

    expect({ servedBefore, ...refused }).toStrictEqual({
      servedBefore: 200,
      kept: "dependency.revoked",
      server: "dependency.revoked",
      served: 403,
    });
    expect(ended).toMatchObject([
      {
        id: approved.request.id,
        status: "revoked",
        decided: { by: { userId: admin.userId } },
        ended: {
          by: { userId: admin.userId },
          reason: "The library is no longer maintained.",
          policyGeneration: before + 1,
        },
      },
    ]);
    expect(status).toMatchObject({
      policyGeneration: before + 1,
      approved: null,
    });
    expect(after).toStrictEqual({ lock: undefined, queued: true });
    expect(dependencyEvents(events, approved.app)).toStrictEqual([
      {
        action: "dependency.revoked",
        detail: {
          app: approved.app,
          graphHash: approved.request.graphHash,
          approvals: approved.request.id,
          reason: "The library is no longer maintained.",
          policyGeneration: before + 1,
        },
      },
    ]);
  });

  it("revokes a retired graph too, and nothing ends it twice", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const browser = await buildOf(approved, "browser");
    await end(admin, "retire", approved.request);
    const servedRetired = await servedStatus(browser);

    const revoked = await end(admin, "revoke", approved.request);
    const servedRevoked = await servedStatus(browser);
    const again = {
      retire: await outcome(end(admin, "retire", approved.request)),
      revoke: await outcome(end(admin, "revoke", approved.request)),
      impact: await outcome(admin.api.dependencies.impact(approved.request.id)),
    };

    expect({
      servedRetired,
      servedRevoked,
      revoked: revoked.map(({ status }) => status),
    }).toStrictEqual({
      servedRetired: 200,
      servedRevoked: 403,
      revoked: ["revoked"],
    });
    // A revoked approval is in force no more: there is nothing to end.
    expect(again).toStrictEqual({
      retire: "dependency.not_found",
      revoke: "dependency.not_found",
      impact: "dependency.not_found",
    });
  });

  it("ends every approval of the graph, whatever targets each was for", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin, ["browser"]);
    // The same graph, approved again for another target: a second row.
    const { request: server } = await approved.builder.api.dependencies.resolve(
      intentFor(
        approved.app,
        { [approved.name]: "1.0.0" },
        {
          targets: ["server"],
        }
      )
    );
    const { policyGeneration } = await admin.api.dependencies.waiting();
    await admin.api.dependencies.decide(server.id, {
      approved: true,
      reviewed: { graphHash: server.graphHash, policyGeneration },
    });
    const impact = await admin.api.dependencies.impact(approved.request.id);

    const revoked = await end(admin, "revoke", approved.request);
    const build = await outcome(buildOf(approved, "server"));

    expect(server.graphHash).toBe(approved.request.graphHash);
    expect(impact.approvals.map(({ id }) => id).toSorted()).toStrictEqual(
      [approved.request.id, server.id].toSorted()
    );
    expect(revoked.map(({ id, status }) => [id, status])).toStrictEqual(
      [
        [approved.request.id, "revoked"],
        [server.id, "revoked"],
      ].toSorted(([a], [b]) => String(a).localeCompare(String(b)))
    );
    expect(build).toBe("dependency.revoked");
  });
});

describe("retiring an App's approved packages", () => {
  it("keeps what was built working, and builds nothing new", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const browser = await buildOf(approved, "browser");
    const impact = await admin.api.dependencies.impact(approved.request.id);

    let ended: DependencyRequest[] = [];
    const events = await auditedDuring(async () => {
      ended = await end(admin, "retire", approved.request);
    });
    const kept = await buildOf(approved, "browser");
    let server = "";
    const refusedEvents = await auditedDuring(async () => {
      server = await outcome(buildOf(approved, "server"));
    });
    const served = await servedStatus(kept);
    const lock = await storedLock(approved);

    expect(impact.artifacts).toMatchObject([
      { target: "browser", hash: browser.hash },
    ]);
    expect(ended.map(({ status }) => status)).toStrictEqual(["retired"]);
    // The artifact built before is handed out again, from its pin, and its
    // files still load.
    // Nothing new is built.
    expect({
      kept: [kept.hash, kept.stats, kept.approval],
      served,
      pinned: lock?.artifacts === undefined ? [] : [browser.hash],
      server,
    }).toStrictEqual({
      kept: [browser.hash, null, approved.request.id],
      served: 200,
      pinned: [browser.hash],
      server: "dependency.retired",
    });
    expect([
      ...dependencyEvents(events, approved.app),
      ...dependencyEvents(refusedEvents, approved.app),
    ]).toMatchObject([
      {
        action: "dependency.retired",
        detail: { approvals: approved.request.id },
      },
      {
        action: "dependency.admission_refused",
        detail: { targets: "server", reason: "retired" },
      },
    ]);
  });

  it("makes a missing kept artifact again only to its pin", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const browser = await buildOf(approved, "browser");
    await end(admin, "retire", approved.request);
    await env.FILES.delete(`package-builds/${browser.hash}.json`);

    const again = await buildOf(approved, "browser");
    const served = await servedStatus(again);

    expect([again.hash, again.stats === null, served]).toStrictEqual([
      browser.hash,
      false,
      200,
    ]);
  });

  it("keeps a retired graph's lock while newer graphs take the App's room, until it is revoked", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin, ["browser"]);
    const browser = await buildOf(approved, "browser");
    await end(admin, "retire", approved.request);
    // Every address handed out has expired: only retirement keeps it.
    await env.DB.prepare(
      "UPDATE dependency_locks SET served_until = ? WHERE app_id = ?"
    )
      .bind(Date.now() - 1, approved.app)
      .run();
    /** Resolves the App to a graph of its own and approves it. */
    const approveAnother = async (): Promise<void> => {
      const name = await smallPackage();
      const { request } = await approved.builder.api.dependencies.resolve(
        intentFor(approved.app, { [name]: "1.0.0" })
      );
      const { policyGeneration } = await admin.api.dependencies.waiting();
      await admin.api.dependencies.decide(request.id, {
        approved: true,
        reviewed: { graphHash: request.graphHash, policyGeneration },
      });
    };

    // The tests' limit is three locks (vite.config.ts): four graphs more
    // take the room of the older approvals, never the retired one's.
    for (let next = 0; next < 4; next += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one graph after another
      await approveAnother();
    }
    const retainedLock = await storedLock(approved);
    const served = await servedStatus(browser);
    await end(admin, "revoke", approved.request);
    const revokedLock = await storedLock(approved);

    expect([
      retainedLock?.artifacts === undefined,
      served,
      revokedLock,
    ]).toStrictEqual([false, 200, undefined]);
  });

  it("asks a person again for a graph the App resolves back to once it is retired, and keeps the history", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    await end(admin, "retire", approved.request);

    const { request: again } = await approved.builder.api.dependencies.resolve(
      intentFor(
        approved.app,
        { [approved.name]: "1.0.0" },
        {
          targets: ["browser", "server"],
        }
      )
    );
    const before = await outcome(buildOf(approved, "server"));
    const { policyGeneration } = await admin.api.dependencies.waiting();
    const approvedAgain = await admin.api.dependencies.decide(again.id, {
      approved: true,
      reviewed: { graphHash: again.graphHash, policyGeneration },
    });
    const server = await buildOf(approved, "server");
    const old = await admin.api.dependencies.get(approved.request.id);

    expect({
      again: [again.status, again.graphHash],
      before,
      approvedAgain: approvedAgain.status,
      server: server.approval,
    }).toStrictEqual({
      again: ["pending", approved.request.graphHash],
      before: "dependency.retired",
      approvedAgain: "approved",
      server: again.id,
    });
    // The retired approval stays as it was ended.
    expect(old).toMatchObject({
      status: "retired",
      ended: { by: { userId: admin.userId } },
    });
  });
});

/**
 * Builds `target` while `during` runs as the builder starts: after the
 * build's admission, before its pin.
 */
const buildWhile = async (
  approved: Approved,
  target: DependencyTarget,
  during: () => Promise<unknown>
) => {
  const identity = await approved.builder.api.whoami();
  const { policyGeneration } = await approved.builder.api.dependencies.status(
    approved.app
  );
  let ran = false;
  const assets = new Proxy(env.ASSETS, {
    get: (assetsTarget, property): unknown => {
      if (property !== "fetch") {
        const value: unknown = Reflect.get(assetsTarget, property);
        return typeof value === "function" ? value.bind(assetsTarget) : value;
      }
      return async (input: RequestInfo, init?: RequestInit) => {
        if (!ran) {
          ran = true;
          await during();
        }
        return await assetsTarget.fetch(input, init);
      };
    },
  });
  return await outcome(
    buildDependencies({ ...env, ASSETS: assets }, identity, {
      app: approved.app,
      graphHash: approved.request.graphHash,
      target,
      policyGeneration,
    })
  );
};

describe("a build racing the decision", () => {
  it("pins nothing once the graph is retired or revoked while it builds", async () => {
    const admin = await approvingAdmin();
    const retiring = await approvedApp(admin);
    const revoking = await approvedApp(admin);

    const retired = await buildWhile(retiring, "browser", async () => {
      await end(admin, "retire", retiring.request);
    });
    const revoked = await buildWhile(revoking, "browser", async () => {
      await end(admin, "revoke", revoking.request);
    });
    const afterRetired = await outcome(buildOf(retiring, "browser"));
    const retiredLock = await storedLock(retiring);
    const revokedLock = await storedLock(revoking);

    // The decision landed first: the build read the policy before it, and
    // nothing it made was pinned, so the retired graph keeps nothing.
    expect({
      retired,
      revoked,
      retiredPins: retiredLock?.artifacts,
      afterRetired,
      revokedLock,
    }).toStrictEqual({
      retired: "dependency.policy_changed",
      revoked: "dependency.policy_changed",
      retiredPins: undefined,
      afterRetired: "dependency.retired",
      revokedLock: undefined,
    });
  });

  it("keeps a pin that landed just before the graph was retired", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const { policyGeneration } = await admin.api.dependencies.impact(
      approved.request.id
    );
    const browser = await buildOf(approved, "browser");

    // Decided on the impact read before the pin landed: the pin is part
    // of what the graph keeps.
    await admin.api.dependencies.retire(approved.request.id, {
      reviewed: { graphHash: approved.request.graphHash, policyGeneration },
      reason: "Replaced by the platform's own chart.",
    });

    const kept = await buildOf(approved, "browser");
    const served = await servedStatus(browser);

    expect([kept.hash, served]).toStrictEqual([browser.hash, 200]);
  });

  it("asks again when the approval a proposal finds standing is retired as it lands", async () => {
    const admin = await approvingAdmin();
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const identity = await builder.api.whoami();
    const first = await proposeForTests(env, identity, proposalFor(app));
    const { policyGeneration } = await admin.api.dependencies.waiting();
    await admin.api.dependencies.decide(first.id, {
      approved: true,
      reviewed: { graphHash: first.graphHash, policyGeneration },
    });
    // Something else waits meanwhile, which the App going back drops.
    await proposeForTests(env, identity, proposalFor(app, "2.0.0"));

    let raced = false;
    const db = racingDb(async () => {
      if (!raced) {
        raced = true;
        await end(admin, "retire", first);
      }
    });
    const back = await proposeForTests(
      { ...env, DB: db },
      identity,
      proposalFor(app)
    );

    expect(raced).toBeTruthy();
    expect([back.id === first.id, back.status, back.graphHash]).toStrictEqual([
      false,
      "pending",
      first.graphHash,
    ]);
  });
});

describe("who ends an approval, and on what", () => {
  it("lets only a person who holds the permission end one: no role, no staff, no agent acting for a holder", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const otherAdmin = await personApi("admin");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate();
    const { policyGeneration } = await admin.api.dependencies.impact(
      approved.request.id
    );
    const ending = {
      reviewed: { graphHash: approved.request.graphHash, policyGeneration },
      reason: "Unsafe.",
    };
    const identity = await admin.api.whoami();
    // As core names an agent acting for a person (agent-builds.ts).
    const acting = {
      ...identity,
      actor: {
        type: "agent" as const,
        agentId: "agent-1",
        onBehalfOf: identity.userId,
      },
    };

    const refused = {
      otherAdmin: await outcome(
        otherAdmin.api.dependencies.revoke(approved.request.id, ending)
      ),
      builder: await outcome(
        approved.builder.api.dependencies.retire(approved.request.id, ending)
      ),
      staff: await outcome(
        staff.dependencies.revoke(approved.request.id, ending)
      ),
      agent: await outcome(
        endDependency(env, acting, approved.request.id, "revoked", ending)
      ),
      // Nor does anyone without it read what ending one would touch.
      builderImpact: await outcome(
        approved.builder.api.dependencies.impact(approved.request.id)
      ),
      noReason: await outcome(
        admin.api.dependencies.revoke(approved.request.id, {
          ...ending,
          reason: " ",
        })
      ),
    };
    const status = await approved.builder.api.dependencies.status(approved.app);

    expect(refused).toStrictEqual({
      otherAdmin: "dependency.forbidden",
      builder: "dependency.forbidden",
      staff: "dependency.forbidden",
      agent: "dependency.forbidden",
      builderImpact: "dependency.not_found",
      noReason: "dependency.invalid",
    });
    expect(status.approved?.status).toBe("approved");
  });

  it("decides in one write: a grant lost, a policy change or another approval of the graph just before it lands refuses it", async () => {
    const admin = await approvingAdmin();
    const adminIdentity = await admin.api.whoami();
    const racedBy = async (
      first: (raced: {
        approver: Person;
        grant: string;
        approved: Approved;
      }) => Promise<unknown>
    ) => {
      const approver = await personApi("user");
      const { id: grant } = await admin.api.dependencies.grantApprover({
        type: "person",
        userId: approver.userId,
      });
      const approved = await approvedApp(admin, ["browser"]);
      const identity = await approver.api.whoami();
      const { policyGeneration } = await approver.api.dependencies.impact(
        approved.request.id
      );
      let raced = false;
      const db = racingDb(async () => {
        if (!raced) {
          raced = true;
          await first({ approver, grant, approved });
        }
      });
      const result = await outcome(
        endDependency(
          { ...env, DB: db },
          identity,
          approved.request.id,
          "revoked",
          {
            reviewed: {
              graphHash: approved.request.graphHash,
              policyGeneration,
            },
            reason: "Unsafe.",
          }
        )
      );
      const { approved: still } =
        await approved.builder.api.dependencies.status(approved.app);
      return { result, status: still?.status };
    };

    const grantLost = await racedBy(async ({ grant }) => {
      await revokeApprover(env, adminIdentity, grant);
    });
    const policyChanged = await racedBy(async () => {
      const another = await personApi("user");
      await admin.api.dependencies.grantApprover({
        type: "person",
        userId: another.userId,
      });
    });
    const approvedAgain = await racedBy(async ({ approved }) => {
      // The same graph approved for another target meanwhile: one more
      // approval in force than the person read.
      const { request } = await approved.builder.api.dependencies.resolve(
        intentFor(
          approved.app,
          { [approved.name]: "1.0.0" },
          {
            targets: ["server"],
          }
        )
      );
      const { policyGeneration } = await admin.api.dependencies.waiting();
      await admin.api.dependencies.decide(request.id, {
        approved: true,
        reviewed: { graphHash: request.graphHash, policyGeneration },
      });
    });

    expect({ grantLost, policyChanged, approvedAgain }).toStrictEqual({
      grantLost: { result: "dependency.forbidden", status: "approved" },
      policyChanged: { result: "dependency.stale", status: "approved" },
      approvedAgain: { result: "dependency.stale", status: "approved" },
    });
  });

  it("refuses a decision on another graph than the approval's", async () => {
    const admin = await approvingAdmin();
    const approved = await approvedApp(admin);
    const { policyGeneration } = await admin.api.dependencies.impact(
      approved.request.id
    );

    const result = await outcome(
      admin.api.dependencies.revoke(approved.request.id, {
        reviewed: { graphHash: "f".repeat(64), policyGeneration },
        reason: "Unsafe.",
      })
    );

    expect(result).toBe("dependency.stale");
  });

  it("leaves what an approver approved in force when their permission is revoked", async () => {
    const admin = await personApi("admin");
    const approver = await personApi("user");
    const { id: grant } = await admin.api.dependencies.grantApprover({
      type: "person",
      userId: approver.userId,
    });
    const approved = await approvedApp(approver, ["browser"]);

    await admin.api.dependencies.revokeApprover(grant);
    const build = await buildOf(approved, "browser");
    const status = await approved.builder.api.dependencies.status(approved.app);

    expect([build.approval, status.approved?.status]).toStrictEqual([
      approved.request.id,
      "approved",
    ]);
  });
});
