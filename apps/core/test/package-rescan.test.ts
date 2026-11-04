import type { PackageBuild } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  malwareRecheckMs,
  rescanPackages,
} from "../src/dependencies/requests.ts";
import { mockIdp } from "./idp.ts";
import {
  advise,
  failure,
  intentFor,
  named,
  osvAnswers,
  plain,
  publish,
  reportToOsv,
} from "./npm.ts";
import { racingDb } from "./racing-db.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// Malware or an advisory reported after a graph was approved (GRA-924,
// threat T5), from its threat model: a build that makes a new artifact of
// a version reported since; an artifact built before it served or run on;
// OSV.dev out of reach taken as no report; and the re-scan revoking on a
// wrong answer, or never coming back to a graph it couldn't read; nobody
// told, or the wrong people told, when core revokes one or finds a new
// advisory: its builders and whoever approved it are, nobody else; and a
// new advisory told again on every run. OSV.dev and the npm registry are
// connect's fakes, behind the real connect Worker.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * An App whose graph (`pkg`, which depends on `dep`) an admin approved, as
 * a builder of every App, neither reported as malware when it was. With
 * `beforeApproval`, what happens between the resolve and the approval.
 */
const approvedApp = async (beforeApproval?: (dep: string) => Promise<void>) => {
  const admin = await personApi("admin");
  const builder = await personApi("builder");
  const { id: app } = await builder.api.apps.create({
    name: `App ${unique()}`,
  });
  const pkg = named("pkg");
  const dep = named("dep");
  await publish(plain(dep, "1.0.0"));
  await publish(plain(pkg, "1.0.0", { dependencies: { [dep]: "^1.0.0" } }));
  const { request } = await builder.api.dependencies.resolve(
    intentFor(app, { [pkg]: "1.0.0" })
  );
  await beforeApproval?.(dep);
  const { policyGeneration } = await admin.api.dependencies.waiting();
  await admin.api.dependencies.decide(request.id, {
    approved: true,
    reviewed: { graphHash: request.graphHash, policyGeneration },
  });
  /** Builds its browser target, under the policy generation now. */
  const build = async (): Promise<PackageBuild> => {
    const { policyGeneration: now } = await builder.api.dependencies.status({
      app,
    });
    return await builder.api.dependencies.build({
      app,
      graphHash: request.graphHash,
      target: "browser",
      policyGeneration: now,
    });
  };
  return { admin, builder, app, request, dep, build };
};

/** How a build went: `built`, or the code it was refused with. */
const outcomeOf = async (built: Promise<PackageBuild>): Promise<string> => {
  try {
    await built;
    return "built";
  } catch {
    const { code } = await failure(built);
    return code;
  }
};

type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The revocations `person` is told of, as their notifications list them:
 * what each is about (an App's or workflow's ID), the package and the
 * advisory.
 */
const toldOf = async (person: Person) => {
  const { notifications } = await person.api.notifications.list();
  return notifications.flatMap((notification) =>
    notification.type === "package_revoked"
      ? [
          {
            about:
              notification.subject.type === "app"
                ? notification.subject.app
                : notification.subject.workflow,
            package: notification.package,
            advisory: notification.advisory,
            read: notification.read,
          },
        ]
      : []
  );
};

/** A run of the re-scan well past any graph's last one. */
const recheckLater = async (): Promise<void> => {
  await rescanPackages(env, new Date(Date.now() + 2 * malwareRecheckMs));
};

/** A registry advisory of `dep` 1.0.0, not malware, with GitHub's ID `ghsa`. */
const advisoryOf = (ghsa: string) => ({
  id: 2_000_001,
  url: `https://github.com/advisories/${ghsa}`,
  title: "Prototype pollution",
  severity: "high",
  vulnerable_versions: "<1.0.1",
});

/** The `dependency.advisory_found` events of `graphHash`, by advisory. */
const advisoriesFound = (
  logged: Awaited<ReturnType<typeof auditedDuring>>,
  graphHash: string
): unknown[] =>
  logged
    .filter(
      ({ action, detail }) =>
        action === "dependency.advisory_found" && detail.graphHash === graphHash
    )
    .map(({ detail }) => detail.advisory);

/**
 * The new advisories `person` is told of, as their notifications list
 * them: what each is about, the package and the advisory.
 */
const advisedOf = async (person: Person) => {
  const { notifications } = await person.api.notifications.list();
  return notifications.flatMap((notification) =>
    notification.type === "package_advisory"
      ? [
          {
            about:
              notification.subject.type === "app"
                ? notification.subject.app
                : notification.subject.workflow,
            package: notification.package,
            advisory: notification.advisory,
          },
        ]
      : []
  );
};

describe("malware reported after an approval", () => {
  it("refuses a build of a new artifact of a version reported since, and fails closed when OSV.dev can't be read", async () => {
    const reported = await approvedApp();
    await reportToOsv(reported.dep, "1.0.0", "MAL-2026-30001");
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcomeOf(reported.build());
    });

    const unread = await approvedApp();
    await osvAnswers(unread.dep, 503);
    let unchecked = "";
    try {
      unchecked = await outcomeOf(unread.build());
    } finally {
      await osvAnswers(unread.dep, null);
    }
    // Once OSV.dev answers again and reports nothing, it builds.
    const later = await outcomeOf(unread.build());

    expect({
      refused,
      audited: events
        .filter(({ action }) => action === "dependency.malware_refused")
        .map(({ detail }) => ({
          package: detail.package,
          advisory: detail.advisory,
          at: detail.at,
          graphHash: detail.graphHash,
        })),
      unchecked,
      later,
    }).toStrictEqual({
      refused: "dependency.malware",
      audited: [
        {
          package: reported.dep,
          advisory: "MAL-2026-30001",
          at: "build",
          graphHash: reported.request.graphHash,
        },
      ],
      unchecked: "package.malware_unchecked",
      later: "built",
    });
  });

  it("revokes, on core's clock, an approval whose built artifact a later report covers: nothing of it is handed out again", async () => {
    const app = await approvedApp();
    const built = await outcomeOf(app.build());
    await reportToOsv(app.dep, "1.0.0", "MAL-2026-30002");
    const events = await auditedDuring(recheckLater);
    // The pinned artifact, built before the report, is refused now.
    const afterwards = await outcomeOf(app.build());
    const revoked = events.find(
      ({ action, detail }) =>
        action === "dependency.revoked" &&
        detail.graphHash === app.request.graphHash
    );

    expect({
      built,
      afterwards,
      revoked: {
        actor: revoked?.actor,
        target: revoked?.target,
        reason: revoked?.detail.reason,
        package: revoked?.detail.package,
        advisory: revoked?.detail.advisory,
        approvals: revoked?.detail.approvals,
      },
      findings: events
        .filter(
          ({ action, detail }) =>
            action === "dependency.malware_refused" &&
            detail.revocation === revoked?.id
        )
        .map(({ detail }) => [detail.package, detail.at]),
    }).toStrictEqual({
      built: "built",
      afterwards: "dependency.revoked",
      revoked: {
        actor: { type: "system" },
        target: { type: "dependency_request", id: app.request.id },
        reason: "malware",
        package: app.dep,
        advisory: "MAL-2026-30002",
        approvals: 1,
      },
      findings: [[app.dep, "recheck"]],
    });
  });

  it("tells an App's builders and whoever approved its packages that they were revoked as malware, and nobody else", async () => {
    const app = await approvedApp();
    const [outsider, user] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    await app.builder.api.apps.members.add(app.app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await reportToOsv(app.dep, "1.0.0", "MAL-2026-30004");
    await recheckLater();

    const [builderTold, adminTold, outsiderTold, userTold, waiting] =
      await Promise.all([
        toldOf(app.builder),
        toldOf(app.admin),
        toldOf(outsider),
        toldOf(user),
        app.builder.api.waiting.list(),
      ]);
    const told = {
      about: app.app,
      package: { name: app.dep, version: "1.0.0" },
      advisory: "MAL-2026-30004",
      read: false,
    };
    expect({
      builderTold,
      adminTold,
      outsiderTold,
      userTold,
      waiting: waiting.items.filter(({ kind }) => kind === "revokedPackage")
        .length,
    }).toStrictEqual({
      builderTold: [told],
      adminTold: [told],
      outsiderTold: [],
      userTold: [],
      waiting: 1,
    });
  });

  it("tells a workflow's builders, and nobody else", async () => {
    const [builder, outsider] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const { id: workflow } = await builder.api.workflowResources.create(
      `stats-${unique()}`
    );
    const dep = named("dep");
    await publish(plain(dep, "1.0.0"));
    const { request } = await builder.api.dependencies.resolve({
      workflow,
      sourceRevision: "rev-1",
      purpose: "Compute the weighted median of the quarter.",
      targets: ["computation"],
      dependencies: [{ name: dep, range: "1.0.0" }],
    });
    const { policyGeneration } = await builder.api.dependencies.waiting();
    await builder.api.dependencies.decide(request.id, {
      approved: true,
      reviewed: { graphHash: request.graphHash, policyGeneration },
    });
    await reportToOsv(dep, "1.0.0", "MAL-2026-30005");
    await recheckLater();

    const [builderTold, outsiderTold] = await Promise.all([
      toldOf(builder),
      toldOf(outsider),
    ]);
    expect({ builderTold, outsiderTold }).toStrictEqual({
      builderTold: [
        {
          about: workflow,
          package: { name: dep, version: "1.0.0" },
          advisory: "MAL-2026-30005",
          read: false,
        },
      ],
      outsiderTold: [],
    });
  });

  it("revokes nothing while OSV.dev can't be read, logs it, and revokes on the next run once it can", async () => {
    const app = await approvedApp();
    await outcomeOf(app.build());
    await reportToOsv(app.dep, "1.0.0", "MAL-2026-30003");
    const warn = vi.spyOn(console, "warn");
    await osvAnswers(app.dep, 503);
    let whileUnread = "";
    try {
      await recheckLater();
      whileUnread = await outcomeOf(app.build());
    } finally {
      await osvAnswers(app.dep, null);
    }
    const logged = warn.mock.calls.some(([entry]) =>
      JSON.stringify(entry).includes("dependencies.malware_unchecked")
    );
    warn.mockRestore();
    const toldWhileUnread = await toldOf(app.builder);
    await recheckLater();
    const nextRun = await outcomeOf(app.build());

    expect({ whileUnread, logged, toldWhileUnread, nextRun }).toStrictEqual({
      // Its pin still hands out what was built: nothing was revoked.
      whileUnread: "built",
      logged: true,
      toldWhileUnread: [],
      nextRun: "dependency.revoked",
    });
  });
});

describe("an advisory published after an approval", () => {
  it("is recorded and told to the App's builders once, on core's clock, and leaves the approval standing", async () => {
    const app = await approvedApp();
    const [outsider, user] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    await app.builder.api.apps.members.add(app.app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    // Known before the approval was asked for, its review would have
    // shown it; this one is new.
    await advise(app.dep, {
      id: 2_000_001,
      url: "https://github.com/advisories/GHSA-pppp-qqqq-rrrr",
      title: "Prototype pollution",
      severity: "high",
      vulnerable_versions: "<1.0.1",
    });
    const events = await auditedDuring(recheckLater);
    // The next run tells nothing again.
    const again = await auditedDuring(async () => {
      await rescanPackages(env, new Date(Date.now() + 5 * malwareRecheckMs));
    });
    const [builderTold, adminTold, outsiderTold, userTold, waiting] =
      await Promise.all([
        advisedOf(app.builder),
        advisedOf(app.admin),
        advisedOf(outsider),
        advisedOf(user),
        app.builder.api.waiting.list(),
      ]);
    const built = await outcomeOf(app.build());
    const found = (logged: typeof events) =>
      logged
        .filter(
          ({ action, detail }) =>
            action === "dependency.advisory_found" &&
            detail.graphHash === app.request.graphHash
        )
        .map(({ actor, target, detail }) => ({
          actor,
          target,
          package: detail.package,
          version: detail.version,
          advisory: detail.advisory,
          severity: detail.severity,
        }));
    const told = {
      about: app.app,
      package: { name: app.dep, version: "1.0.0" },
      advisory: "GHSA-pppp-qqqq-rrrr",
    };

    expect({
      found: found(events),
      foundAgain: found(again),
      builderTold,
      adminTold,
      outsiderTold,
      userTold,
      waiting: waiting.items.filter(({ kind }) => kind === "packageAdvisory")
        .length,
      built,
    }).toStrictEqual({
      found: [
        {
          actor: { type: "system" },
          target: { type: "app", id: app.app },
          package: app.dep,
          version: "1.0.0",
          advisory: "GHSA-pppp-qqqq-rrrr",
          severity: "high",
        },
      ],
      foundAgain: [],
      builderTold: [told],
      adminTold: [told],
      outsiderTold: [],
      userTold: [],
      waiting: 1,
      // An advisory warns; the builders decide. Only malware revokes.
      built: "built",
    });
  });

  it("tells nothing of an advisory known when the graph was approved, though its review never showed it", async () => {
    // Published after the resolve, before the approval: not among the
    // review's findings, but among what the approval was made with.
    const app = await approvedApp(async (dep) => {
      await advise(dep, advisoryOf("GHSA-kkkk-nnnn-wwww"));
    });

    const events = await auditedDuring(recheckLater);

    await expect(advisedOf(app.builder)).resolves.toStrictEqual([]);
    expect(advisoriesFound(events, app.request.graphHash)).toStrictEqual([]);
  });

  it("tells an advisory once when two runs race, and nothing once the graph ended meanwhile", async () => {
    const at = new Date(Date.now() + 2 * malwareRecheckMs);
    // Another run tells it just before this one's batch lands.
    const raced = await approvedApp();
    await advise(raced.dep, advisoryOf("GHSA-rrrr-cccc-eeee"));
    let ran = false;
    const twice = await auditedDuring(async () => {
      await rescanPackages(
        {
          ...env,
          DB: racingDb(async () => {
            if (!ran) {
              ran = true;
              await rescanPackages(env, at);
            }
          }),
        },
        at
      );
    });
    // Its approval revoked just before the batch lands.
    const ended = await approvedApp();
    await advise(ended.dep, advisoryOf("GHSA-gggg-hhhh-jjjj"));
    let revoked = false;
    const afterEnding = await auditedDuring(async () => {
      await rescanPackages(
        {
          ...env,
          DB: racingDb(async () => {
            if (!revoked) {
              revoked = true;
              const { policyGeneration, endings } =
                await ended.admin.api.dependencies.impact(ended.request.id);
              await ended.admin.api.dependencies.revoke(ended.request.id, {
                reviewed: {
                  graphHash: ended.request.graphHash,
                  policyGeneration,
                  approvalsDigest: endings.revoke.digest,
                },
                reason: "Not needed.",
              });
            }
          }),
        },
        new Date(Date.now() + 4 * malwareRecheckMs)
      );
    });

    expect({
      twice: advisoriesFound(twice, raced.request.graphHash),
      toldTwice: await advisedOf(raced.builder),
      afterEnding: advisoriesFound(afterEnding, ended.request.graphHash),
      toldAfterEnding: await advisedOf(ended.builder),
    }).toStrictEqual({
      twice: ["GHSA-rrrr-cccc-eeee"],
      toldTwice: [
        {
          about: raced.app,
          package: { name: raced.dep, version: "1.0.0" },
          advisory: "GHSA-rrrr-cccc-eeee",
        },
      ],
      afterEnding: [],
      toldAfterEnding: [],
    });
  });

  it("tells nothing, and fails nothing, when the graph ends between its reads", async () => {
    const ended = await approvedApp();
    await advise(ended.dep, advisoryOf("GHSA-mmmm-pppp-qqqq"));
    /** Revokes the graph, once, just before the run reads its packages. */
    let revoked = false;
    const revoke = async (): Promise<void> => {
      if (revoked) {
        return;
      }
      revoked = true;
      const { policyGeneration, endings } =
        await ended.admin.api.dependencies.impact(ended.request.id);
      await ended.admin.api.dependencies.revoke(ended.request.id, {
        reviewed: {
          graphHash: ended.request.graphHash,
          policyGeneration,
          approvalsDigest: endings.revoke.digest,
        },
        reason: "Not needed.",
      });
    };
    /** `statement`, bound: it revokes first when it is run. */
    const revokingFirst = (
      statement: D1PreparedStatement
    ): D1PreparedStatement =>
      new Proxy(statement, {
        get: (target, property): unknown => {
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? async (...args: unknown[]): Promise<unknown> => {
                await revoke();
                return await Promise.resolve(
                  Reflect.apply(value, target, args)
                );
              }
            : value;
        },
      });
    /** `statement`, whose read of `ended`'s graph by its approval revokes first. */
    const racing = (
      statement: D1PreparedStatement,
      query: string
    ): D1PreparedStatement =>
      new Proxy(statement, {
        get: (target, property): unknown => {
          if (property === "bind") {
            return (...values: unknown[]): D1PreparedStatement => {
              const bound = target.bind(...values);
              return query.includes('select "snapshot"') &&
                values.includes(ended.request.id)
                ? revokingFirst(bound)
                : bound;
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      });
    const db = new Proxy(env.DB, {
      get: (target, property): unknown => {
        if (property === "prepare") {
          return (query: string): D1PreparedStatement =>
            racing(target.prepare(query), query);
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const events = await auditedDuring(async () => {
      await rescanPackages(
        { ...env, DB: db },
        new Date(Date.now() + 6 * malwareRecheckMs)
      );
    });

    expect({
      revoked,
      found: advisoriesFound(events, ended.request.graphHash),
      told: await advisedOf(ended.builder),
    }).toStrictEqual({ revoked: true, found: [], told: [] });
  });

  it("tells advisories up to the approval's cap, then nothing more, and logs that it reached it", async () => {
    const app = await approvedApp();
    // The tests' cap is two (vite.config.ts): the third is never told.
    for (const ghsa of [
      "GHSA-aaaa-cccc-2222",
      "GHSA-aaaa-cccc-3333",
      "GHSA-aaaa-cccc-4444",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one advisory at a time
      await advise(app.dep, {
        ...advisoryOf(ghsa),
        id: Math.trunc(Number(ghsa.slice(-4))),
      });
    }
    const warn = vi.spyOn(console, "warn");
    let first: Awaited<ReturnType<typeof auditedDuring>> = [];
    let next: Awaited<ReturnType<typeof auditedDuring>> = [];
    let capped = 0;
    try {
      first = await auditedDuring(async () => {
        await rescanPackages(env, new Date(Date.now() + 8 * malwareRecheckMs));
      });
      next = await auditedDuring(async () => {
        await rescanPackages(env, new Date(Date.now() + 10 * malwareRecheckMs));
      });
      capped = warn.mock.calls.filter(([entry]) => {
        const logged = JSON.stringify(entry);
        return (
          logged.includes("dependencies.advisories_capped") &&
          logged.includes(app.request.graphHash)
        );
      }).length;
    } finally {
      warn.mockRestore();
    }

    const told = await advisedOf(app.builder);

    expect({
      first: advisoriesFound(first, app.request.graphHash),
      next: advisoriesFound(next, app.request.graphHash),
      told: told.length,
      capped,
    }).toStrictEqual({
      first: ["GHSA-aaaa-cccc-2222", "GHSA-aaaa-cccc-3333"],
      next: [],
      told: 1,
      capped: 2,
    });
  });
});
