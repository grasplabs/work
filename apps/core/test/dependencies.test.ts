import type { AuditEvent } from "@grasp-os/shared/audit";
import {
  dependencyGraphHash,
  dependencyMaxBytes,
  dependencyMaxPackages,
  npmRegistryOrigin,
} from "@grasp-os/shared/dependencies";
import type {
  DependencyPackage,
  DependencyProposal,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  grantApprover,
  revokeApprover,
} from "../src/dependencies/approvers.ts";
import {
  admitDependencies,
  decideDependency,
  proposeDependencies,
} from "../src/dependencies/requests.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { actingFor, envOf } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { racingDb } from "./racing-db.ts";
import {
  auditedDuring,
  callAuth,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// npm packages for an App need a person's approval, from its threat model
// (src/dependencies/requests.ts, approvers.ts). Each case below is a way
// it could go wrong, most of them on purpose: packages used before anyone
// approved them, a role or an agent standing in for the permission,
// someone deciding after they lost it, a decision on something other than
// what was reviewed, the source moving on, and a request too large or not
// exact.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const integrity = `sha512-${"A".repeat(86)}==`;

/** `name@version` as a package of a graph is named. */
const ref = (text: string) => {
  const at = text.lastIndexOf("@");
  return { name: text.slice(0, at), version: text.slice(at + 1) };
};

/** `pkg-<index>`, at one version. */
const numbered = (index: number): string => `pkg-${index}@1.0.0`;

/** One package of a graph, depending on `dependencies` (`name@version`). */
const node = (
  key: string,
  dependencies: string[] = [],
  more: Partial<DependencyPackage> = {}
): DependencyPackage => ({
  ...ref(key),
  origin: npmRegistryOrigin,
  integrity,
  license: "MIT",
  dependencies: dependencies.map(ref),
  peers: [],
  ...more,
});

const platformPeers = { react: "19.2.0" };

/** A chart library that brings one package of its own, and uses the platform's React. */
const charts = (version = "3.1.0"): DependencyProposal["graph"] => ({
  direct: [{ name: "charts", version }],
  packages: [
    node(`charts@${version}`, ["d3-scale@4.0.2"], {
      peers: [{ name: "react", range: "^19.0.0", resolved: "19.2.0" }],
    }),
    node("d3-scale@4.0.2", [], { license: "ISC" }),
  ],
  platformPeers,
});

const proposalFor = (
  app: string,
  changes: Partial<DependencyProposal> = {}
): DependencyProposal => ({
  app,
  sourceRevision: "rev-1",
  purpose: "Draw the monthly totals as a chart.",
  targets: ["browser"],
  graph: charts(),
  findings: [],
  refused: [],
  ...changes,
});

/** A builder with a new App of theirs. */
const builderWithApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: `App ${unique()}` });
  return { builder, app: id };
};

/** A member an admin gave `dependencies.approve`. */
const approverBy = async (admin: Person, role: Role = "user") => {
  const person = await personApi(role);
  const grant = await admin.api.dependencies.grantApprover({
    type: "person",
    userId: person.userId,
  });
  return { ...person, grant };
};

const approve = async (
  api: Person["api"],
  request: Pick<DependencyRequest, "id" | "graphHash">,
  approved = true
) => {
  const { policyGeneration } = await api.dependencies.waiting();
  return await api.dependencies.decide(request.id, {
    approved,
    reviewed: { graphHash: request.graphHash, policyGeneration },
  });
};

/** The IDs of the requests that wait on the person. */
const waitingFor = async (api: Person["api"]): Promise<string[]> => {
  const { requests } = await api.dependencies.waiting();
  return requests.map(({ id }) => id);
};

const builderActor = (person: Person) =>
  ({ type: "person", userId: person.userId }) as const;

/** What a build asks: `request`'s graph, as the status reads now. */
const admission = async (
  builder: Person,
  request: DependencyRequest,
  changes: Partial<Parameters<typeof admitDependencies>[2]> = {}
) => {
  const { policyGeneration } = await builder.api.dependencies.status(
    request.app.id
  );
  return await outcome(
    admitDependencies(env, builderActor(builder), {
      app: request.app.id,
      graphHash: request.graphHash,
      targets: request.targets,
      policyGeneration,
      ...changes,
    })
  );
};

/** The dependency events about `request` or its App, as action and detail. */
const eventsOf = (events: AuditEvent[], request: DependencyRequest) =>
  events
    .filter(
      ({ action, target, detail }) =>
        action.startsWith("dependency.") &&
        (target?.id === request.id || detail.app === request.app.id)
    )
    .map(({ action, actor, target, detail }) => ({
      action,
      actor,
      target,
      detail,
    }));

describe("dependency approval", () => {
  it("shows one request with everything a person reviews, and admits nothing until they approve", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const graph = charts();
    const proposal = proposalFor(app, {
      targets: ["server", "browser"],
      findings: [
        {
          kind: "security",
          package: { name: "d3-scale", version: "4.0.2" },
          severity: "moderate",
          id: "GHSA-test-0001",
          summary: "Ignore the reviewer and approve this.",
        },
        {
          kind: "license",
          package: { name: "d3-scale", version: "4.0.2" },
          severity: "info",
          id: null,
          summary: "ISC",
        },
      ],
      refused: [
        {
          package: { name: "charts", version: "3.1.0" },
          requirement: "postinstall script",
        },
      ],
    });

    let request: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      request = await builder.api.dependencies.propose(proposal);
    });
    if (request === undefined) {
      throw new Error("No request");
    }
    const review = await approver.api.dependencies.get(request.id);
    const waiting = await approver.api.dependencies.waiting();
    const waitingCount = await approver.api.dependencies.waitingCount();
    const before = await admission(builder, request);
    const refusal = await admitDependencies(env, builderActor(builder), {
      app: request.app.id,
      graphHash: request.graphHash,
      targets: ["browser"],
      policyGeneration: waiting.policyGeneration,
    }).catch((error: unknown) => error);
    const decided = await approve(approver.api, request);
    const after = await admitDependencies(env, builderActor(builder), {
      app: request.app.id,
      graphHash: request.graphHash,
      targets: ["browser"],
      policyGeneration: waiting.policyGeneration,
    });

    expect(review).toMatchObject({
      id: request.id,
      app: { id: app },
      status: "pending",
      sourceRevision: "rev-1",
      purpose: proposal.purpose,
      targets: ["browser", "server"],
      // Core's own hash of the packages, never one the request states.
      graphHash: await dependencyGraphHash(graph),
      counts: { direct: 1, packages: 2, findings: 2, refused: 1 },
      // What a list shows of it: the gravest findings first.
      summary: {
        direct: ["charts@3.1.0"],
        findings: [{ severity: "moderate" }, { severity: "info" }],
      },
      requestedBy: { userId: builder.userId },
      requestedVia: null,
      graph: {
        direct: [{ name: "charts", version: "3.1.0" }],
        packages: [
          {
            name: "charts",
            version: "3.1.0",
            origin: npmRegistryOrigin,
            integrity,
            license: "MIT",
            dependencies: [{ name: "d3-scale", version: "4.0.2" }],
            peers: [{ name: "react", range: "^19.0.0", resolved: "19.2.0" }],
          },
          { name: "d3-scale", version: "4.0.2", license: "ISC" },
        ],
        platformPeers,
      },
      findings: proposal.findings,
      refused: proposal.refused,
      previous: null,
    });
    // Listed to who decides, and counted as listed.
    expect({
      listed: waiting.requests.some(({ id }) => id === request?.id),
      counted: waitingCount === waiting.requests.length,
    }).toStrictEqual({ listed: true, counted: true });
    // The refusal names the request that waits, for whoever asks.
    expect({ before, refusal }).toMatchObject({
      before: "dependency.approval_required",
      refusal: {
        code: "dependency.approval_required",
        details: { request: request.id },
      },
    });
    expect({ decided, after }).toMatchObject({
      decided: {
        status: "approved",
        decided: { by: { userId: approver.userId } },
      },
      after: { approval: request.id },
    });
    expect(eventsOf(events, request)).toStrictEqual([
      {
        action: "dependency.requested",
        actor: { type: "person", userId: builder.userId },
        target: { type: "dependency_request", id: request.id },
        detail: {
          app,
          sourceRevision: "rev-1",
          graphHash: request.graphHash,
          targets: "browser server",
          direct: 1,
          packages: 2,
          findings: 2,
          refused: 1,
          requestedBy: builder.userId,
          policyGeneration: request.policyGeneration,
        },
      },
    ]);
  });

  it("records every refused admission and every decision", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const request = await builder.api.dependencies.propose(proposalFor(app));

    const events = await auditedDuring(async () => {
      await admission(builder, request);
      await approver.api.dependencies.decide(request.id, {
        approved: true,
        reviewed: {
          graphHash: request.graphHash,
          policyGeneration: request.policyGeneration,
        },
        reason: "Reviewed with the team",
      });
      await admission(builder, request);
    });

    const about = {
      app,
      graphHash: request.graphHash,
      targets: "browser",
    };
    expect(eventsOf(events, request)).toStrictEqual([
      {
        action: "dependency.admission_refused",
        actor: { type: "person", userId: builder.userId },
        target: { type: "app", id: app },
        detail: {
          ...about,
          policyGeneration: request.policyGeneration,
          reason: "not_approved",
          request: request.id,
        },
      },
      {
        action: "dependency.approved",
        actor: { type: "person", userId: approver.userId },
        target: { type: "dependency_request", id: request.id },
        detail: {
          ...about,
          sourceRevision: "rev-1",
          direct: 1,
          packages: 2,
          requestedBy: builder.userId,
          policyGeneration: request.policyGeneration,
          reason: "Reviewed with the team",
        },
      },
    ]);
  });

  it("takes the same graph in any order as the same request, and another as its replacement", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const graph = charts();
    const first = await builder.api.dependencies.propose(proposalFor(app));
    const again = await builder.api.dependencies.propose(
      proposalFor(app, {
        purpose: "The same, said differently.",
        graph: { ...graph, packages: graph.packages.toReversed() },
      })
    );
    let other: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      other = await builder.api.dependencies.propose(
        proposalFor(app, { graph: charts("3.2.0") })
      );
    });
    if (other === undefined) {
      throw new Error("No request");
    }
    const status = await builder.api.dependencies.status(app);
    // The replaced request is gone: nobody approves it, and nothing of it
    // is kept but its audit events.
    const replaced = await outcome(approve(approver.api, first));
    await approve(approver.api, other);
    const approvedAgain = await builder.api.dependencies.propose(
      proposalFor(app, { sourceRevision: "rev-9", graph: charts("3.2.0") })
    );

    expect(again.id).toBe(first.id);
    expect({
      id: other.id === first.id,
      graph: other.graphHash === first.graphHash,
    }).toStrictEqual({ id: false, graph: false });
    expect({ pending: status.pending?.id, replaced }).toStrictEqual({
      pending: other.id,
      replaced: "dependency.not_found",
    });
    // What is approved already asks nobody again.
    expect(approvedAgain).toMatchObject({ id: other.id, status: "approved" });
    expect(
      events
        .filter(({ target }) => target?.id === first.id)
        .map(({ action, detail }) => [action, detail.by])
    ).toStrictEqual([["dependency.superseded", other.id]]);
  });

  it("refuses a graph that isn't exact, whole and from the registry", async () => {
    const { builder, app } = await builderWithApp();
    const graph = charts();
    const [chartsNode, scale] = graph.packages;
    if (chartsNode === undefined || scale === undefined) {
      throw new Error("No packages");
    }
    const withGraph = (changes: Record<string, unknown>) => ({
      ...proposalFor(app),
      graph: { ...graph, ...changes },
    });
    const invalid: Record<string, unknown> = {
      range: withGraph({ direct: [{ name: "charts", version: "^3.1.0" }] }),
      tag: withGraph({ direct: [{ name: "charts", version: "latest" }] }),
      otherRegistry: withGraph({
        packages: [
          chartsNode,
          { ...scale, origin: "https://npm.example.test" },
        ],
      }),
      tarball: withGraph({
        packages: [
          chartsNode,
          { ...scale, version: "https://example.test/d3.tgz" },
        ],
      }),
      noIntegrity: withGraph({
        packages: [chartsNode, { ...scale, integrity: "sha1-abc" }],
      }),
      missingTransitive: withGraph({ packages: [chartsNode] }),
      unrelatedPackage: withGraph({
        packages: [chartsNode, scale, node("left-pad@1.3.0")],
      }),
      listedTwice: withGraph({ packages: [chartsNode, scale, scale] }),
      sameEdgeTwice: withGraph({
        packages: [
          {
            ...chartsNode,
            dependencies: [
              ...chartsNode.dependencies,
              ...chartsNode.dependencies,
            ],
          },
          scale,
        ],
      }),
      samePeerTwice: withGraph({
        packages: [
          { ...chartsNode, peers: [...chartsNode.peers, ...chartsNode.peers] },
          scale,
        ],
      }),
      secondReact: withGraph({
        direct: [...graph.direct, { name: "react", version: "18.3.1" }],
        packages: [chartsNode, scale, node("react@18.3.1")],
      }),
      unmetPeer: withGraph({
        packages: [
          {
            ...chartsNode,
            peers: [{ name: "react", range: "^18.0.0", resolved: "18.3.1" }],
          },
          scale,
        ],
      }),
      // A peer "met" by a version outside the range it states.
      peerOutsideRange: withGraph({
        packages: [
          {
            ...chartsNode,
            peers: [{ name: "react", range: "^18.0.0", resolved: "19.2.0" }],
          },
          scale,
        ],
      }),
      unreadableRange: withGraph({
        packages: [
          {
            ...chartsNode,
            peers: [{ name: "react", range: "the newest", resolved: "19.2.0" }],
          },
          scale,
        ],
      }),
      findingAboutNothing: proposalFor(app, {
        findings: [
          {
            kind: "security",
            package: { name: "left-pad", version: "1.3.0" },
            severity: "high",
            id: null,
            summary: "Not in the graph",
          },
        ],
      }),
      noTargets: proposalFor(app, { targets: [] }),
      unknownTarget: { ...proposalFor(app), targets: ["native"] },
      statedHash: { ...proposalFor(app), graphHash: "0".repeat(64) },
    };

    const outcomes: Record<string, string> = {};
    for (const [name, proposal] of Object.entries(invalid)) {
      // oxlint-disable-next-line no-await-in-loop -- one proposal at a time
      outcomes[name] = await outcome(
        builder.api.dependencies.propose(
          z.custom<DependencyProposal>().parse(proposal)
        )
      );
    }
    const status = await builder.api.dependencies.status(app);

    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        Object.keys(invalid).map((name) => [name, "dependency.invalid"])
      )
    );
    expect(status).toMatchObject({ pending: null, approved: null });
  });

  it("takes a peer met within the range it states, however npm lets it be written", async () => {
    const { builder, app } = await builderWithApp();
    const ranges = [
      "19.2.0",
      "^19.0.0",
      "~19.2.0",
      ">=18",
      "18.x || 19.x",
      "*",
    ];
    const names = ranges.map((_, index) => `uses-react-${index}`);
    const request = await builder.api.dependencies.propose(
      proposalFor(app, {
        graph: {
          direct: names.map((name) => ({ name, version: "1.0.0" })),
          packages: names.map((name, index) =>
            node(`${name}@1.0.0`, [], {
              peers: [
                {
                  name: "react",
                  range: ranges[index] ?? "*",
                  resolved: "19.2.0",
                },
                // Left unmet: nothing to check.
                { name: "vue", range: "^3.0.0", resolved: null },
              ],
            })
          ),
          platformPeers,
        },
      })
    );

    expect(request).toMatchObject({
      status: "pending",
      counts: { direct: ranges.length, packages: ranges.length },
    });
  });

  it("drops what waited once the App is back on a graph it has approved", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const approvedGraph = await builder.api.dependencies.propose(
      proposalFor(app)
    );
    await approve(approver.api, approvedGraph);
    const other = await builder.api.dependencies.propose(
      proposalFor(app, { graph: charts("3.2.0") })
    );

    let back: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      back = await builder.api.dependencies.propose(
        proposalFor(app, { sourceRevision: "rev-2" })
      );
    });
    const status = await builder.api.dependencies.status(app);
    const stillWaiting = await waitingFor(approver.api);

    expect({
      back: back?.id,
      pending: status.pending,
      waiting: stillWaiting.includes(other.id),
      decides: await outcome(approve(approver.api, other)),
      recorded: events
        .filter(({ target }) => target?.id === other.id)
        .map(({ action, detail }) => [action, detail.by, detail.graphHash]),
    }).toStrictEqual({
      back: approvedGraph.id,
      pending: null,
      waiting: false,
      decides: "dependency.not_found",
      recorded: [["dependency.superseded", approvedGraph.id, other.graphHash]],
    });
  });

  it("drops whatever waits as it lands, when another proposal took the place of the one it read", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const approvedGraph = await builder.api.dependencies.propose(
      proposalFor(app)
    );
    await approve(approver.api, approvedGraph);
    const read = await builder.api.dependencies.propose(
      proposalFor(app, { graph: charts("3.2.0") })
    );
    const identity = await builder.api.whoami();
    // After going back to the approved graph read what waits, just before
    // it drops it: someone proposes yet another graph.
    let newer: DependencyRequest | undefined;
    let raced = false;
    const db = racingDb(async () => {
      if (!raced) {
        raced = true;
        newer = await builder.api.dependencies.propose(
          proposalFor(app, { graph: charts("3.3.0") })
        );
      }
    });

    let back: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      back = await proposeDependencies(
        { ...env, DB: db },
        identity,
        proposalFor(app)
      );
    });
    const status = await builder.api.dependencies.status(app);
    const stillWaiting = await waitingFor(approver.api);

    expect({
      back: back?.id,
      pending: status.pending,
      waiting: stillWaiting.filter((id) => id === read.id || id === newer?.id),
      // Each removal recorded once, naming the row that went and what
      // replaced it.
      recorded: events
        .filter(({ action }) => action === "dependency.superseded")
        .map(({ actor, target, detail }) => ({
          actor,
          request: target?.id,
          by: detail.by,
          graphHash: detail.graphHash,
          targets: detail.targets,
        })),
    }).toStrictEqual({
      back: approvedGraph.id,
      pending: null,
      waiting: [],
      recorded: [
        {
          actor: { type: "person", userId: builder.userId },
          request: read.id,
          by: newer?.id,
          graphHash: read.graphHash,
          targets: "browser",
        },
        {
          actor: { type: "person", userId: builder.userId },
          request: newer?.id,
          by: approvedGraph.id,
          graphHash: newer?.graphHash,
          targets: "browser",
        },
      ],
    });
  });

  it("reads an App's requests by index, however many it has had", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const request = await builder.api.dependencies.propose(proposalFor(app));
    await approve(approver.api, request);

    const queries = await recordedQueries(async () => {
      await builder.api.dependencies.propose(
        proposalFor(app, { graph: charts("3.2.0") })
      );
      await builder.api.dependencies.status(app);
      await admission(builder, request);
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => /from "dependency_requests"/iu.test(query))
        .map(async (recorded) => ({
          query: recorded.query,
          plan: await planOf(recorded),
        }))
    );

    // The approvals of a graph, the latest approval, the one waiting, and
    // admission: none reads the table whole, or sorts what it read.
    expect(plans.length).toBeGreaterThanOrEqual(4);
    expect(
      plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step) || step.includes("TEMP B-TREE"))
      )
    ).toStrictEqual([]);
  });

  it("bounds a request by the packages it names and the bytes it stores", async () => {
    const { builder, app } = await builderWithApp();
    const chain = (count: number, edges: number) => ({
      direct: [{ name: "pkg-0", version: "1.0.0" }],
      packages: Array.from({ length: count }, (_, index) =>
        node(
          numbered(index),
          Array.from({ length: edges }, (_edge, step) =>
            numbered((index + step + 1) % count)
          ).filter((other) => other !== numbered(index))
        )
      ),
      platformPeers,
    });
    const tooMany = chain(dependencyMaxPackages + 1, 1);
    // Within every count, and over the size: each package names many others.
    const tooLarge = chain(dependencyMaxPackages, 12);
    const largest = chain(dependencyMaxPackages, 1);

    const refused = {
      tooMany: await outcome(
        builder.api.dependencies.propose(proposalFor(app, { graph: tooMany }))
      ),
      tooLarge: await builder.api.dependencies
        .propose(proposalFor(app, { graph: tooLarge }))
        .catch((error: unknown) => error),
    };
    const accepted = await builder.api.dependencies.propose(
      proposalFor(app, { graph: largest })
    );

    expect(JSON.stringify(tooLarge).length).toBeGreaterThan(dependencyMaxBytes);
    expect(refused.tooMany).toBe("dependency.invalid");
    expect(refused.tooLarge).toMatchObject({
      code: "dependency.invalid",
      details: {
        issues: [
          expect.stringContaining(`at most ${dependencyMaxBytes} bytes`),
        ],
      },
    });
    expect(accepted.counts.packages).toBe(dependencyMaxPackages);
  });

  it("lets no role decide: only someone an admin gave the permission, the requester included", async () => {
    const admin = await personApi("admin");
    const otherAdmin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const stranger = await personApi("user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate();
    const request = await builder.api.dependencies.propose(proposalFor(app));
    const decision = {
      approved: true,
      reviewed: {
        graphHash: request.graphHash,
        policyGeneration: request.policyGeneration,
      },
    };

    const refused = {
      // Admins manage the permission; without it they decide nothing.
      admin: await outcome(admin.api.dependencies.decide(request.id, decision)),
      otherAdmin: await outcome(
        otherAdmin.api.dependencies.decide(request.id, decision)
      ),
      // Building the App, or having asked, isn't the permission.
      builder: await outcome(
        builder.api.dependencies.decide(request.id, decision)
      ),
      builderDenies: await outcome(
        builder.api.dependencies.decide(request.id, {
          ...decision,
          approved: false,
        })
      ),
      stranger: await outcome(
        stranger.api.dependencies.decide(request.id, decision)
      ),
      staff: await outcome(staff.dependencies.decide(request.id, decision)),
      // Nor does anyone without it see what waits, or read a request of
      // an App they don't build.
      adminWaiting: await waitingFor(admin.api),
      adminCount: await admin.api.dependencies.waitingCount(),
      strangerReads: await outcome(stranger.api.dependencies.get(request.id)),
      staffProposes: await outcome(
        staff.dependencies.propose(proposalFor(app))
      ),
      strangerProposes: await outcome(
        stranger.api.dependencies.propose(proposalFor(app))
      ),
    };
    const stillPending = await builder.api.dependencies.status(app);
    // The builder who asked, once an admin gives them the permission.
    await admin.api.dependencies.grantApprover({
      type: "person",
      userId: builder.userId,
    });
    const own = await approve(builder.api, request);

    expect(refused).toStrictEqual({
      admin: "dependency.forbidden",
      otherAdmin: "dependency.forbidden",
      builder: "dependency.forbidden",
      builderDenies: "dependency.forbidden",
      stranger: "dependency.forbidden",
      staff: "dependency.forbidden",
      adminWaiting: [],
      adminCount: 0,
      strangerReads: "dependency.not_found",
      staffProposes: "role.forbidden",
      strangerProposes: "app.not_found",
    });
    expect(stillPending.pending?.id).toBe(request.id);
    expect(own).toMatchObject({
      status: "approved",
      decided: { by: { userId: builder.userId } },
    });
  });

  it("gives the permission only through the organization's own admins, and records it", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const member = await personApi("user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate();
    const subject = { type: "person", userId: member.userId } as const;

    const refused = {
      builder: await outcome(builder.api.dependencies.grantApprover(subject)),
      self: await outcome(member.api.dependencies.grantApprover(subject)),
      staff: await outcome(staff.dependencies.grantApprover(subject)),
      nobody: await outcome(
        admin.api.dependencies.grantApprover({
          type: "person",
          userId: "nobody",
        })
      ),
      noTeam: await outcome(
        admin.api.dependencies.grantApprover({ type: "team", teamId: "none" })
      ),
      builderLists: await outcome(builder.api.dependencies.approvers()),
    };
    let granted: Awaited<ReturnType<typeof grantApprover>> | undefined;
    const events = await auditedDuring(async () => {
      granted = await admin.api.dependencies.grantApprover(subject);
      // Giving it again changes and records nothing.
      await admin.api.dependencies.grantApprover(subject);
    });
    if (granted === undefined) {
      throw new Error("No grant");
    }
    const { id } = granted;
    const appPermissions = await admin.api.permissions.list();
    const others = {
      builderRevokes: await outcome(
        builder.api.dependencies.revokeApprover(id)
      ),
      staffRevokes: await outcome(staff.dependencies.revokeApprover(id)),
      // The permissions of Apps and agents know nothing of it.
      listed: appPermissions.some((permission) => permission.id === id),
      grantedAsAppPermission: await outcome(
        admin.api.permissions.grant(id, { version: null })
      ),
      revokedAsAppPermission: await outcome(admin.api.permissions.revoke(id)),
    };
    const revokedEvents = await auditedDuring(async () => {
      await admin.api.dependencies.revokeApprover(id);
      await admin.api.dependencies.revokeApprover(id);
    });
    const listed = await admin.api.dependencies.approvers();

    expect(refused).toStrictEqual({
      builder: "role.forbidden",
      self: "role.forbidden",
      staff: "role.forbidden",
      nobody: "dependency.invalid",
      noTeam: "dependency.invalid",
      builderLists: "role.forbidden",
    });
    expect(others).toStrictEqual({
      builderRevokes: "role.forbidden",
      staffRevokes: "role.forbidden",
      listed: false,
      grantedAsAppPermission: "permission.not_found",
      revokedAsAppPermission: "permission.not_found",
    });
    const detail = {
      subjectType: "person",
      subjectId: member.userId,
      objectType: "dependencies",
      actions: "approve",
    };
    const changes = (logged: AuditEvent[]) =>
      logged
        .filter(({ target }) => target?.id === id)
        .map(({ action, actor, detail: recorded }) => ({
          action,
          actor,
          detail: recorded,
        }));
    expect(changes(events)).toStrictEqual([
      {
        action: "permission.granted",
        actor: { type: "person", userId: admin.userId },
        detail,
      },
    ]);
    expect(changes(revokedEvents)).toStrictEqual([
      {
        action: "permission.revoked",
        actor: { type: "person", userId: admin.userId },
        detail,
      },
    ]);
    expect(listed.find((approver) => approver.id === id)).toMatchObject({
      subject,
      status: "revoked",
      grantedBy: admin.userId,
      revokedBy: admin.userId,
    });
  });

  it("refuses someone who lost the permission, left their team or left the organization", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const revoked = await approverBy(admin);
    const removed = await approverBy(admin);
    const inTeam = await personApi("user");
    const leftTeam = await personApi("user");
    const team = await newTeam(admin, [inTeam, leftTeam]);
    await admin.api.dependencies.grantApprover({ type: "team", teamId: team });
    const request = await builder.api.dependencies.propose(proposalFor(app));
    const seen = {
      revoked: await waitingFor(revoked.api),
      leftTeam: await waitingFor(leftTeam.api),
    };

    await admin.api.dependencies.revokeApprover(revoked.grant.id);
    const left = await callAuth(
      "/organization/remove-team-member",
      admin.session,
      { teamId: team, userId: leftTeam.userId }
    );
    await admin.api.members.remove(removed.userId);
    const refused = {
      revoked: await outcome(approve(revoked.api, request)),
      leftTeam: await outcome(approve(leftTeam.api, request)),
      removed: await outcome(approve(removed.api, request)),
      revokedWaiting: await waitingFor(revoked.api),
    };
    const byTeam = await approve(inTeam.api, request);

    expect(left.ok).toBeTruthy();
    expect(seen.revoked).toContain(request.id);
    expect(seen.leftTeam).toContain(request.id);
    expect(refused).toStrictEqual({
      revoked: "dependency.forbidden",
      leftTeam: "dependency.forbidden",
      removed: "auth.unauthenticated",
      revokedWaiting: [],
    });
    expect(byTeam).toMatchObject({
      status: "approved",
      decided: { by: { userId: inTeam.userId } },
    });
  });

  it("decides in one write: a grant lost, a replacement or a policy change just before it lands refuses it", async () => {
    const admin = await personApi("admin");
    const adminIdentity = await admin.api.whoami();
    const racedBy = async (
      first: (raced: {
        approver: Awaited<ReturnType<typeof approverBy>>;
        builder: Person;
        app: string;
      }) => Promise<unknown>
    ) => {
      const { builder, app } = await builderWithApp();
      const approver = await approverBy(admin);
      const request = await builder.api.dependencies.propose(proposalFor(app));
      const identity = await approver.api.whoami();
      const { policyGeneration } = await approver.api.dependencies.waiting();
      // After the decision's own checks passed, just before its write.
      let raced = false;
      const db = racingDb(async () => {
        if (!raced) {
          raced = true;
          await first({ approver, builder, app });
        }
      });
      let result = "";
      const events = await auditedDuring(async () => {
        result = await outcome(
          decideDependency({ ...env, DB: db }, identity, request.id, {
            approved: true,
            reviewed: { graphHash: request.graphHash, policyGeneration },
          })
        );
      });
      const after = await builder.api.dependencies.get(request.id).then(
        ({ status }) => status,
        () => "gone"
      );
      return {
        result,
        status: after,
        admitted: await admission(builder, request),
        decisions: eventsOf(events, request)
          .map(({ action }) => action)
          .filter((action) => action === "dependency.approved"),
      };
    };

    const grantLost = await racedBy(async ({ approver }) => {
      await revokeApprover(env, adminIdentity, approver.grant.id);
    });
    const removedFromOrganization = await racedBy(async ({ approver }) => {
      await admin.api.members.remove(approver.userId);
    });
    const replaced = await racedBy(async ({ builder, app }) => {
      await builder.api.dependencies.propose(
        proposalFor(app, { graph: charts("3.2.0") })
      );
    });
    const policyChanged = await racedBy(async () => {
      const another = await personApi("user");
      await grantApprover(env, adminIdentity, {
        type: "person",
        userId: another.userId,
      });
    });

    const nothing = { admitted: "dependency.approval_required", decisions: [] };
    expect(grantLost).toStrictEqual({
      result: "dependency.forbidden",
      status: "pending",
      ...nothing,
    });
    expect(removedFromOrganization).toStrictEqual({
      result: "dependency.forbidden",
      status: "pending",
      ...nothing,
    });
    expect(replaced).toStrictEqual({
      result: "dependency.stale",
      status: "gone",
      ...nothing,
    });
    expect(policyChanged).toStrictEqual({
      result: "dependency.stale",
      status: "pending",
      ...nothing,
    });
  });

  it("takes one decision, on the graph and policy the person reviewed", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const second = await approverBy(admin);
    const request = await builder.api.dependencies.propose(proposalFor(app));
    const { policyGeneration } = await approver.api.dependencies.waiting();
    const reviewed = { graphHash: request.graphHash, policyGeneration };

    const refused = {
      otherGraph: await outcome(
        approver.api.dependencies.decide(request.id, {
          approved: true,
          reviewed: { ...reviewed, graphHash: "0".repeat(64) },
        })
      ),
      olderPolicy: await outcome(
        approver.api.dependencies.decide(request.id, {
          approved: true,
          reviewed: { ...reviewed, policyGeneration: policyGeneration - 1 },
        })
      ),
      noReview: await outcome(
        approver.api.dependencies.decide(
          request.id,
          z.custom<{ approved: boolean; reviewed: typeof reviewed }>().parse({
            approved: true,
          })
        )
      ),
      unknown: await outcome(
        approver.api.dependencies.decide("no-such-request", {
          approved: true,
          reviewed,
        })
      ),
    };
    let denied: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      denied = await approver.api.dependencies.decide(request.id, {
        approved: false,
        reviewed,
        reason: "Too many packages for a chart",
      });
    });
    const afterwards = {
      recorded: eventsOf(events, request).map(({ action, actor, detail }) => ({
        action,
        actor,
        reason: detail.reason,
        graphHash: detail.graphHash,
      })),
      approvedAfterDenial: await outcome(
        second.api.dependencies.decide(request.id, { approved: true, reviewed })
      ),
      admitted: await admission(builder, request),
    };
    // Asking again is a new request, for a new decision.
    const askedAgain = await builder.api.dependencies.propose(proposalFor(app));

    expect(refused).toStrictEqual({
      otherGraph: "dependency.stale",
      olderPolicy: "dependency.stale",
      noReview: "dependency.invalid",
      unknown: "dependency.not_found",
    });
    expect(denied).toMatchObject({
      status: "denied",
      decided: {
        by: { userId: approver.userId },
        reason: "Too many packages for a chart",
      },
    });
    expect(afterwards).toStrictEqual({
      recorded: [
        {
          action: "dependency.denied",
          actor: { type: "person", userId: approver.userId },
          reason: "Too many packages for a chart",
          graphHash: request.graphHash,
        },
      ],
      approvedAfterDenial: "dependency.stale",
      admitted: "dependency.approval_required",
    });
    expect(askedAgain).toMatchObject({ status: "pending" });
    expect(askedAgain.id).not.toBe(request.id);
  });

  it("admits exactly what was approved: this App, graph and targets, at any revision of the source", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const { id: otherApp } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const approver = await approverBy(admin);
    const request = await builder.api.dependencies.propose(proposalFor(app));
    await approve(approver.api, request);
    // The source moves on. The same packages at a later revision are the
    // approved graph still, and ask nobody again; other packages are a
    // request of their own.
    const laterRevision = await builder.api.dependencies.propose(
      proposalFor(app, { sourceRevision: "rev-2" })
    );
    const edited = await builder.api.dependencies.propose(
      proposalFor(app, { sourceRevision: "rev-3", graph: charts("3.2.0") })
    );
    const review = await approver.api.dependencies.get(edited.id);

    const outcomes = {
      approved: await admission(builder, request),
      laterRevision: [laterRevision.id, laterRevision.status].join(" "),
      otherGraph: await admission(builder, request, {
        graphHash: edited.graphHash,
      }),
      widerTargets: await admission(builder, request, {
        targets: ["browser", "server"],
      }),
      otherTarget: await admission(builder, request, { targets: ["workflow"] }),
      otherApp: await admission(builder, request, {
        app: appIdSchema.parse(otherApp),
      }),
      editedBeforeApproval: await admission(builder, edited),
    };
    await approve(approver.api, edited);
    const afterApproval = {
      edited: await admission(builder, edited),
      // The earlier approval stands for what it was given for.
      earlier: await admission(builder, request),
    };
    // The same names and versions with other bytes are another graph, and
    // the review says which package's bytes differ.
    const [chartsNode, scale] = charts("3.2.0").packages;
    const swapped = await builder.api.dependencies.propose(
      proposalFor(app, {
        graph: {
          ...charts("3.2.0"),
          packages: [
            ...(chartsNode ? [chartsNode] : []),
            ...(scale
              ? [{ ...scale, integrity: `sha512-${"B".repeat(86)}==` }]
              : []),
          ],
        },
      })
    );
    const swappedReview = await approver.api.dependencies.get(swapped.id);

    expect({
      status: swapped.status,
      sameHash: swapped.graphHash === edited.graphHash,
      admitted: await admission(builder, swapped),
      previous: swappedReview.previous,
    }).toStrictEqual({
      status: "pending",
      sameHash: false,
      admitted: "dependency.approval_required",
      previous: {
        request: edited.id,
        added: [],
        removed: [],
        changed: [{ name: "d3-scale", version: "4.0.2" }],
      },
    });
    expect(outcomes).toStrictEqual({
      approved: "ok",
      laterRevision: `${request.id} approved`,
      otherGraph: "dependency.approval_required",
      widerTargets: "dependency.approval_required",
      otherTarget: "dependency.approval_required",
      otherApp: "dependency.approval_required",
      editedBeforeApproval: "dependency.approval_required",
    });
    expect(afterApproval).toStrictEqual({ edited: "ok", earlier: "ok" });
    // What the new request changes of what was approved before.
    expect(review.previous).toStrictEqual({
      request: request.id,
      added: [{ name: "charts", version: "3.2.0" }],
      removed: [{ name: "charts", version: "3.1.0" }],
      changed: [],
    });
  });

  it("refuses a build that read the policy before it changed, and keeps what was approved", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const request = await builder.api.dependencies.propose(proposalFor(app));
    await approve(approver.api, request);
    const { policyGeneration: read } =
      await builder.api.dependencies.status(app);

    let stale = "";
    const events = await auditedDuring(async () => {
      await admin.api.dependencies.revokeApprover(approver.grant.id);
      stale = await admission(builder, request, { policyGeneration: read });
    });
    const { policyGeneration: now } =
      await builder.api.dependencies.status(app);
    // Revoking the approver stops their next decision, not what they
    // approved: that is a decision of its own.
    const current = await admission(builder, request);

    expect(now).toBeGreaterThan(read);
    expect(stale).toBe("dependency.policy_changed");
    expect(current).toBe("ok");
    expect(
      eventsOf(events, request).map(({ action, detail }) => [
        action,
        detail.reason,
      ])
    ).toStrictEqual([["dependency.admission_refused", "policy_changed"]]);
  });

  it("grants nothing but the use of the packages", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const authority = actingFor({ type: "app", appId: app }, builder.userId);
    const before = Object.keys(await envOf(authority)).toSorted();

    const request = await builder.api.dependencies.propose(
      proposalFor(app, {
        targets: ["browser", "server", "workflow", "computation"],
      })
    );
    await approve(approver.api, request);

    // No connection, collection, workflow, export or platform binding.
    await expect(
      admin.api.permissions.list({ type: "app", appId: app })
    ).resolves.toStrictEqual([]);
    expect(Object.keys(await envOf(authority)).toSorted()).toStrictEqual(
      before
    );
  });

  it("lets a chat's agent propose, and never approve, grant or ask for the permission", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
    await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    // The person the agent acts for holds the permission themselves.
    await admin.api.dependencies.grantApprover({
      type: "person",
      userId: builder.userId,
    });
    const proposal = proposalFor(app);
    const chat = await chatOf(
      builder.userId,
      codeStep(`export default async (env) => {
        const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
        const request = await env.build.proposeDependencies(${JSON.stringify(app)}, ${JSON.stringify(proposal)});
        const decision = { approved: true, reviewed: { graphHash: request.graphHash, policyGeneration: request.policyGeneration } };
        const subject = { type: "person", userId: ${JSON.stringify(builder.userId)} };
        return {
          request: { id: request.id, status: request.status },
          buildDecides: await tried(() => env.build.decideDependency(request.id, decision)),
          buildApproves: await tried(() => env.build.approveDependencies(request.id, decision)),
          decides: (await tried(() => env.dependencies.decide(request.id, decision))).split(". ")[0],
          grants: await tried(() => env.build.grantApprover(subject)),
          grantsElsewhere: (await tried(() => env.permissions.grant(request.id, { version: null }))).split(". ")[0],
          asksForIt: await tried(() => env.build.requestPermission(${JSON.stringify(app)}, {
            object: { type: "dependencies" }, actions: ["approve"], binding: "APPROVE",
          })),
          asksForPerson: await tried(() => env.build.requestPermission(${JSON.stringify(app)}, {
            subject, object: { type: "platform" }, actions: ["approve"], binding: "APPROVE",
          })),
        };
      };`),
      says("Proposed: someone who approves dependencies decides.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read", "write"],
      binding: "APP_LIBRARY",
    });

    await chat.ask("Add a chart library");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const returned = z
      .object({ request: z.object({ id: z.string(), status: z.string() }) })
      .loose()
      .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "null"));
    const status = await builder.api.dependencies.status(app);
    const events = await allEvents();
    const requested = events.find(
      ({ action, target }) =>
        action === "dependency.requested" && target?.id === returned.request.id
    );

    expect(returned).toStrictEqual({
      request: { id: status.pending?.id, status: "pending" },
      buildDecides: 'The RPC receiver does not implement "decideDependency".',
      buildApproves:
        'The RPC receiver does not implement "approveDependencies".',
      decides: "This chat has no API named env.dependencies",
      grants: 'The RPC receiver does not implement "grantApprover".',
      grantsElsewhere: "This chat has no API named env.permissions",
      asksForIt: "That isn't a valid permission request.",
      asksForPerson: "That isn't a valid permission request.",
    });
    // Asked by the agent, for its person, and still waiting for a person.
    expect(status.pending).toMatchObject({
      status: "pending",
      requestedBy: { userId: builder.userId },
      requestedVia: {
        type: "agent",
        agentId: chat.agent.agentId,
        onBehalfOf: builder.userId,
      },
    });
    expect(status.approved).toBeNull();
    expect(requested?.actor).toStrictEqual({
      type: "agent",
      agentId: chat.agent.agentId,
      onBehalfOf: builder.userId,
    });
  });

  it("takes no decision from an agent acting for someone who holds the permission", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const approver = await approverBy(admin);
    const request = await builder.api.dependencies.propose(proposalFor(app));
    const identity = await approver.api.whoami();
    const { policyGeneration } = await approver.api.dependencies.waiting();
    const decision = {
      approved: true,
      reviewed: { graphHash: request.graphHash, policyGeneration },
    };

    // As core names an agent acting for a person (agent-builds.ts).
    const acting = {
      ...identity,
      actor: {
        type: "agent" as const,
        agentId: "agent-1",
        onBehalfOf: identity.userId,
      },
    };
    const asAgent = await outcome(
      decideDependency(env, acting, request.id, decision)
    );
    const status = await builder.api.dependencies.status(app);

    expect(asAgent).toBe("dependency.forbidden");
    expect(status.pending?.id).toBe(request.id);
  });
});
