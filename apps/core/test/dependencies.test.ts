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
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  admitDependencies,
  decideDependency,
  proposeForTests,
} from "../src/dependencies/requests.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  personalChatsOf,
  says,
  setObjectEnv,
  transcript,
} from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { actingFor, envOf } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { intentFor, named, plain, publish } from "./npm.ts";
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

// npm packages for an App need its builder's approval, from its threat
// model (src/dependencies/requests.ts). Each case below is a way it could
// go wrong, most of them on purpose: packages used before anyone approved
// them, the agent approving for itself, someone who doesn't build the App
// approving (a builder of another App among them), someone deciding after
// they stopped building it, an approval replayed for another graph or
// App, the source moving on, and a request too large or not exact. Known
// malware approved anyway is packages.test.ts's.

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
  findingsTotal: 0,
  refused: [],
  ...changes,
});

/**
 * Proposes `proposal` as `person`, as the resolver does once it resolved a
 * graph (src/packages/resolve.ts): nobody can hand in a graph of their own.
 */
const proposeAs = async (
  person: Person,
  proposal: DependencyProposal
): Promise<DependencyRequest> =>
  await proposeForTests(env, await person.api.whoami(), proposal);

/** Calls `method` of an RPC stub whatever its type says, as any client can. */
const callAnyway = async (
  stub: object,
  method: string,
  ...args: unknown[]
): Promise<unknown> => {
  const call: unknown = Reflect.get(stub, method);
  if (typeof call !== "function") {
    throw new TypeError(`No ${method} to call`);
  }
  return await Reflect.apply(call, stub, args);
};

/** A builder with a new App of theirs. */
const builderWithApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: `App ${unique()}` });
  return { builder, app: id };
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

/** Approving `asked` as it was proposed: its graph, under its generation. */
const reviewing = (asked: DependencyRequest) => ({
  approved: true,
  reviewed: {
    graphHash: asked.graphHash,
    policyGeneration: asked.policyGeneration,
  },
});

const builderActor = (person: Person) =>
  ({ type: "person", userId: person.userId }) as const;

/** What a build asks: `request`'s graph, as the status reads now. */
const admission = async (
  builder: Person,
  request: DependencyRequest,
  changes: Partial<Parameters<typeof admitDependencies>[2]> = {}
) => {
  const { policyGeneration } = await builder.api.dependencies.status({
    app: request.subject.id,
  });
  return await outcome(
    admitDependencies(env, builderActor(builder), {
      app: request.subject.id,
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
        (target?.id === request.id || detail.app === request.subject.id)
    )
    .map(({ action, actor, target, detail }) => ({
      action,
      actor,
      target,
      detail,
    }));

describe("dependency approval", () => {
  it("shows one request with everything a person reviews, and admits nothing until they approve", async () => {
    const { builder, app } = await builderWithApp();
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
      // More were found than the request keeps: the count says so.
      findingsTotal: 5,
      refused: [
        {
          package: { name: "charts", version: "3.1.0" },
          requirement: "postinstall script",
        },
      ],
    });

    let request: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      request = await proposeAs(builder, proposal);
    });
    if (request === undefined) {
      throw new Error("No request");
    }
    const review = await builder.api.dependencies.get(request.id);
    const waiting = await builder.api.dependencies.waiting();
    const before = await admission(builder, request);
    const refusal = await admitDependencies(env, builderActor(builder), {
      app: request.subject.id,
      graphHash: request.graphHash,
      targets: ["browser"],
      policyGeneration: waiting.policyGeneration,
    }).catch((error: unknown) => error);
    const decided = await approve(builder.api, request);
    const after = await admitDependencies(env, builderActor(builder), {
      app: request.subject.id,
      graphHash: request.graphHash,
      targets: ["browser"],
      policyGeneration: waiting.policyGeneration,
    });

    expect(review).toMatchObject({
      id: request.id,
      subject: { type: "app", id: app },
      status: "pending",
      sourceRevision: "rev-1",
      purpose: proposal.purpose,
      targets: ["browser", "server"],
      // Core's own hash of the packages, never one the request states.
      graphHash: await dependencyGraphHash(graph),
      counts: { direct: 1, packages: 2, findings: 5, refused: 1 },
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
    // Listed to who decides.
    expect(waiting.requests.some(({ id }) => id === request?.id)).toBeTruthy();
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
        decided: { by: { userId: builder.userId } },
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
          findings: 5,
          refused: 1,
          requestedBy: builder.userId,
          policyGeneration: request.policyGeneration,
        },
      },
    ]);
  });

  it("records each refused admission once, and every decision", async () => {
    const { builder, app } = await builderWithApp();
    const request = await proposeAs(builder, proposalFor(app));

    const events = await auditedDuring(async () => {
      // The same refusal, again and again, however it is asked: one row in
      // the trail for each reason.
      await admission(builder, request);
      await admission(builder, request);
      await admission(builder, request, { targets: ["browser", "browser"] });
      await admission(builder, request, { policyGeneration: 1000 });
      await admission(builder, request, { policyGeneration: 1001 });
      await builder.api.dependencies.decide(request.id, {
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
        action: "dependency.admission_refused",
        actor: { type: "person", userId: builder.userId },
        target: { type: "app", id: app },
        detail: {
          ...about,
          policyGeneration: 1000,
          reason: "policy_changed",
          request: request.id,
        },
      },
      {
        action: "dependency.approved",
        actor: { type: "person", userId: builder.userId },
        target: { type: "dependency_request", id: request.id },
        detail: {
          ...about,
          sourceRevision: "rev-1",
          direct: 1,
          packages: 2,
          requestedBy: builder.userId,
          selfDecided: true,
          policyGeneration: request.policyGeneration,
          reason: "Reviewed with the team",
        },
      },
    ]);
  });

  it("records no refused admission of a graph nobody proposed, however often it is asked for", async () => {
    const { builder, app } = await builderWithApp();
    const request = await proposeAs(builder, proposalFor(app));
    const madeUp = { ...request, graphHash: "f".repeat(64) };
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    let outcomes: string[] = [];
    let warned: unknown[] = [];
    let events: AuditEvent[] = [];
    try {
      events = await auditedDuring(async () => {
        outcomes = await Promise.all(
          Array.from(
            { length: 5 },
            async () => await admission(builder, madeUp)
          )
        );
      });
      warned = warn.mock.calls.map(([fields]: unknown[]) => fields);
    } finally {
      warn.mockRestore();
    }

    expect({
      outcomes,
      recorded: eventsOf(events, request),
      logged: warned.filter(
        (fields) =>
          typeof fields === "object" &&
          fields !== null &&
          Reflect.get(fields, "event") === "dependencies.admission_refused" &&
          Reflect.get(fields, "graphHash") === madeUp.graphHash
      ).length,
    }).toStrictEqual({
      outcomes: Array.from({ length: 5 }, () => "dependency.approval_required"),
      recorded: [],
      logged: 5,
    });
  });

  it("takes the same graph in any order as the same request, and another as its replacement", async () => {
    const { builder, app } = await builderWithApp();
    const graph = charts();
    const first = await proposeAs(builder, proposalFor(app));
    const again = await proposeAs(
      builder,
      proposalFor(app, {
        purpose: "The same, said differently.",
        graph: { ...graph, packages: graph.packages.toReversed() },
      })
    );
    let other: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      other = await proposeAs(
        builder,
        proposalFor(app, { graph: charts("3.2.0") })
      );
    });
    if (other === undefined) {
      throw new Error("No request");
    }
    const status = await builder.api.dependencies.status({ app });
    // The replaced request is gone: nobody approves it, and nothing of it
    // is kept but its audit events.
    const replaced = await outcome(approve(builder.api, first));
    await approve(builder.api, other);
    const approvedAgain = await proposeAs(
      builder,
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
      fewerFoundThanKept: proposalFor(app, {
        findings: [
          {
            kind: "license",
            package: { name: "d3-scale", version: "4.0.2" },
            severity: "info",
            id: null,
            summary: "ISC",
          },
        ],
        findingsTotal: 0,
      }),
      noTargets: proposalFor(app, { targets: [] }),
      unknownTarget: { ...proposalFor(app), targets: ["native"] },
      statedHash: { ...proposalFor(app), graphHash: "0".repeat(64) },
    };

    const outcomes: Record<string, string> = {};
    for (const [name, proposal] of Object.entries(invalid)) {
      // oxlint-disable-next-line no-await-in-loop -- one proposal at a time
      outcomes[name] = await outcome(
        proposeAs(builder, z.custom<DependencyProposal>().parse(proposal))
      );
    }
    const status = await builder.api.dependencies.status({ app });

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
    const request = await proposeAs(
      builder,
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
    const { builder, app } = await builderWithApp();
    const approvedGraph = await proposeAs(builder, proposalFor(app));
    await approve(builder.api, approvedGraph);
    const other = await proposeAs(
      builder,
      proposalFor(app, { graph: charts("3.2.0") })
    );

    let back: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      back = await proposeAs(
        builder,
        proposalFor(app, { sourceRevision: "rev-2" })
      );
    });
    const status = await builder.api.dependencies.status({ app });
    const stillWaiting = await waitingFor(builder.api);

    expect({
      back: back?.id,
      pending: status.pending,
      waiting: stillWaiting.includes(other.id),
      decides: await outcome(approve(builder.api, other)),
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
    const { builder, app } = await builderWithApp();
    const approvedGraph = await proposeAs(builder, proposalFor(app));
    await approve(builder.api, approvedGraph);
    const read = await proposeAs(
      builder,
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
        newer = await proposeAs(
          builder,
          proposalFor(app, { graph: charts("3.3.0") })
        );
      }
    });

    let back: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      back = await proposeForTests(
        { ...env, DB: db },
        identity,
        proposalFor(app)
      );
    });
    const status = await builder.api.dependencies.status({ app });
    const stillWaiting = await waitingFor(builder.api);

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
    const { builder, app } = await builderWithApp();
    const request = await proposeAs(builder, proposalFor(app));
    await approve(builder.api, request);

    const queries = await recordedQueries(async () => {
      await proposeAs(builder, proposalFor(app, { graph: charts("3.2.0") }));
      await builder.api.dependencies.status({ app });
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
    const tooLarge = chain(dependencyMaxPackages, 24);
    const largest = chain(dependencyMaxPackages, 1);

    const refused = {
      tooMany: await outcome(
        proposeAs(builder, proposalFor(app, { graph: tooMany }))
      ),
      tooLarge: await proposeAs(
        builder,
        proposalFor(app, { graph: tooLarge })
      ).catch((error: unknown) => error),
    };
    const accepted = await proposeAs(
      builder,
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

  it("lets only a builder of the App decide its packages, and records every refusal", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    // B's builder, who builds nothing of A.
    const { builder: otherBuilder, app: otherApp } = await builderWithApp();
    const stranger = await personApi("builder");
    const user = await personApi("user");
    const coBuilder = await personApi("builder");
    const team = await newTeam(admin, [coBuilder]);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await builder.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate();
    const request = await proposeAs(builder, proposalFor(app));
    const otherRequest = await proposeAs(
      otherBuilder,
      proposalFor(otherApp, { graph: charts("3.2.0") })
    );
    const decision = reviewing(request);

    let refused: Record<string, unknown> = {};
    const events = await auditedDuring(async () => {
      refused = {
        // A member it isn't shared with, though their role builds.
        stranger: await outcome(
          stranger.api.dependencies.decide(request.id, decision)
        ),
        // Someone who only uses it.
        user: await outcome(user.api.dependencies.decide(request.id, decision)),
        // B's builder on A's request, and A's builder on B's.
        otherBuilder: await outcome(
          otherBuilder.api.dependencies.decide(request.id, decision)
        ),
        builderForOtherApp: await outcome(
          builder.api.dependencies.decide(
            otherRequest.id,
            reviewing(otherRequest)
          )
        ),
        staff: await outcome(staff.dependencies.decide(request.id, decision)),
        // IDs nobody has, however many: refused, and never audited.
        madeUp: await outcome(
          stranger.api.dependencies.decide(crypto.randomUUID(), decision)
        ),
        notAnId: await outcome(
          stranger.api.dependencies.decide("not an id", decision)
        ),
      };
    });
    const unseen = {
      // Nor does anyone who doesn't build it see what waits, or read it.
      strangerWaiting: await waitingFor(stranger.api),
      strangerReads: await outcome(stranger.api.dependencies.get(request.id)),
      // Nor resolve for an App: staff never, and only its builders.
      staffResolves: await outcome(
        staff.dependencies.resolve(intentFor(app, { charts: "^3.0.0" }))
      ),
      strangerResolves: await outcome(
        stranger.api.dependencies.resolve(intentFor(app, { charts: "^3.0.0" }))
      ),
      // And nobody hands in a graph of their own: only the resolver
      // proposes one.
      builderProposes: await outcome(
        callAnyway(builder.api.dependencies, "propose", proposalFor(app))
      ),
    };
    const stillPending = await builder.api.dependencies.status({ app });
    // Who builds it through a team decides, as its owner would.
    const byCoBuilder = await approve(coBuilder.api, request);

    expect(refused).toStrictEqual({
      stranger: "dependency.not_found",
      user: "dependency.not_found",
      otherBuilder: "dependency.not_found",
      builderForOtherApp: "dependency.not_found",
      staff: "role.forbidden",
      madeUp: "dependency.not_found",
      notAnId: "dependency.not_found",
    });
    expect(unseen).toStrictEqual({
      strangerWaiting: [],
      strangerReads: "dependency.not_found",
      staffResolves: "role.forbidden",
      strangerResolves: "app.not_found",
      // Refused as any method the API doesn't have.
      builderProposes: "internal.unexpected",
    });
    expect(
      events
        .filter(({ action }) => action === "dependency.decision_refused")
        .map(({ actor, target, detail }) => [
          actor.type === "person" ? actor.userId : actor.type,
          target?.id,
          detail.reason,
        ])
    ).toStrictEqual([
      [stranger.userId, request.id, "dependency.not_found"],
      [user.userId, request.id, "dependency.not_found"],
      [otherBuilder.userId, request.id, "dependency.not_found"],
      [builder.userId, otherRequest.id, "dependency.not_found"],
    ]);
    expect(stillPending.pending?.id).toBe(request.id);
    expect(byCoBuilder).toMatchObject({
      status: "approved",
      decided: { by: { userId: coBuilder.userId } },
    });
  });

  it("lists to a builder the requests they asked for, and lets them approve their own", async () => {
    const { builder, app } = await builderWithApp();
    const coBuilder = await personApi("builder");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: coBuilder.userId,
      role: "builder",
    });
    const request = await proposeAs(builder, proposalFor(app));

    const listed = {
      asker: await waitingFor(builder.api),
      // A co-builder decides it, but it waits on whoever asked.
      coBuilder: await waitingFor(coBuilder.api),
    };
    let own: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      own = await approve(builder.api, request);
    });

    expect(listed).toStrictEqual({ asker: [request.id], coBuilder: [] });
    expect(own).toMatchObject({
      status: "approved",
      decided: { by: { userId: builder.userId } },
    });
    expect(
      eventsOf(events, request).map(({ action, actor, detail }) => ({
        action,
        actor,
        selfDecided: detail.selfDecided,
      }))
    ).toStrictEqual([
      {
        action: "dependency.approved",
        actor: { type: "person", userId: builder.userId },
        selfDecided: true,
      },
    ]);
    await expect(waitingFor(builder.api)).resolves.toStrictEqual([]);
  });

  it("refuses a builder once the App is no longer theirs to build: unshared, off the team or out of the organization", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    const unshared = await personApi("builder");
    const removed = await personApi("builder");
    const inTeam = await personApi("builder");
    const leftTeam = await personApi("builder");
    const team = await newTeam(admin, [inTeam, leftTeam]);
    for (const member of [unshared, removed]) {
      // oxlint-disable-next-line no-await-in-loop -- one share at a time
      await builder.api.apps.members.add(app, {
        type: "person",
        id: member.userId,
        role: "builder",
      });
    }
    await builder.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    const request = await proposeAs(builder, proposalFor(app));
    const read = {
      unshared: await outcome(unshared.api.dependencies.get(request.id)),
      leftTeam: await outcome(leftTeam.api.dependencies.get(request.id)),
    };

    await builder.api.apps.members.remove(app, {
      type: "person",
      id: unshared.userId,
    });
    const left = await callAuth(
      "/organization/remove-team-member",
      admin.session,
      { teamId: team, userId: leftTeam.userId }
    );
    await admin.api.members.remove(removed.userId);
    const refused = {
      unshared: await outcome(approve(unshared.api, request)),
      leftTeam: await outcome(approve(leftTeam.api, request)),
      removed: await outcome(approve(removed.api, request)),
    };
    const byTeam = await approve(inTeam.api, request);

    expect(left.ok).toBeTruthy();
    expect(read).toStrictEqual({ unshared: "ok", leftTeam: "ok" });
    expect(refused).toStrictEqual({
      unshared: "dependency.not_found",
      leftTeam: "dependency.not_found",
      removed: "auth.unauthenticated",
    });
    expect(byTeam).toMatchObject({
      status: "approved",
      decided: { by: { userId: inTeam.userId } },
    });
  });

  it("decides in one write: leaving the organization, being unshared or demoted, the App archived, a replacement or a policy change just before it lands refuses it", async () => {
    const admin = await personApi("admin");
    interface Raced {
      approver: Person;
      builder: Person;
      app: string;
    }
    const racedBy = async (
      first: (raced: Raced) => Promise<unknown>,
      /** Just after the decision's write: before anything reads after it. */
      then?: (raced: Raced) => Promise<unknown>
    ) => {
      const { builder, app } = await builderWithApp();
      // A co-builder decides, so the owner can still act on the App.
      const approver = await personApi("builder");
      await builder.api.apps.members.add(app, {
        type: "person",
        id: approver.userId,
        role: "builder",
      });
      const request = await proposeAs(builder, proposalFor(app));
      const identity = await approver.api.whoami();
      const { policyGeneration } = await approver.api.dependencies.waiting();
      // After the decision's own checks passed, just before its write.
      let raced = false;
      let followed = false;
      const db = racingDb(
        async () => {
          if (!raced) {
            raced = true;
            await first({ approver, builder, app });
          }
        },
        async () => {
          if (!followed) {
            followed = true;
            await then?.({ approver, builder, app });
          }
        }
      );
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
        // Each refusal of who decided, on the record with why.
        refused: eventsOf(events, request)
          .filter(({ action }) => action === "dependency.decision_refused")
          .map(({ detail }) => detail.reason),
      };
    };
    // Another App's approval, retired as the decision runs: the policy
    // generation moves on.
    const { builder: elsewhere, app: elsewhereApp } = await builderWithApp();
    const ended = await proposeAs(elsewhere, proposalFor(elsewhereApp));
    await approve(elsewhere.api, ended);

    const removedFromOrganization = await racedBy(async ({ approver }) => {
      await admin.api.members.remove(approver.userId);
    });
    // Unshared while the registry and OSV.dev were read: no longer a builder.
    const unshared = await racedBy(async ({ approver, builder, app }) => {
      await builder.api.apps.members.remove(app, {
        type: "person",
        id: approver.userId,
      });
    });
    // Demoted to a role that doesn't build: no longer a builder of it.
    const demoted = await racedBy(async ({ approver }) => {
      await admin.api.members.setRole(approver.userId, "user");
    });
    // The App archived: read-only, nothing is decided for it.
    const archived = await racedBy(async ({ builder, app }) => {
      await builder.api.apps.archive(app);
    });
    const replaced = await racedBy(async ({ builder, app }) => {
      await proposeAs(builder, proposalFor(app, { graph: charts("3.2.0") }));
    });
    // Replaced just before the write, and unshared just after it: refused
    // for what the write saw, never for what changed after.
    const replacedThenUnshared = await racedBy(
      async ({ builder, app }) => {
        await proposeAs(builder, proposalFor(app, { graph: charts("3.2.0") }));
      },
      async ({ approver, builder, app }) => {
        await builder.api.apps.members.remove(app, {
          type: "person",
          id: approver.userId,
        });
      }
    );
    const policyChanged = await racedBy(async () => {
      const impact = await elsewhere.api.dependencies.impact(ended.id);
      await elsewhere.api.dependencies.retire(ended.id, {
        reviewed: {
          graphHash: impact.graphHash,
          policyGeneration: impact.policyGeneration,
          approvalsDigest: impact.endings.retire.digest,
        },
        reason: "Replaced.",
      });
    });

    const nothing = { admitted: "dependency.approval_required", decisions: [] };
    const forbidden = {
      result: "dependency.forbidden",
      status: "pending",
      ...nothing,
      refused: ["dependency.forbidden"],
    };
    expect({
      removedFromOrganization,
      unshared,
      demoted,
      archived,
      replaced,
      replacedThenUnshared,
      policyChanged,
    }).toStrictEqual({
      removedFromOrganization: forbidden,
      unshared: forbidden,
      demoted: forbidden,
      archived: {
        result: "app.archived",
        status: "pending",
        ...nothing,
        refused: [],
      },
      replaced: {
        result: "dependency.stale",
        status: "gone",
        ...nothing,
        refused: [],
      },
      replacedThenUnshared: {
        result: "dependency.stale",
        status: "gone",
        ...nothing,
        refused: [],
      },
      policyChanged: {
        result: "dependency.stale",
        status: "pending",
        ...nothing,
        refused: [],
      },
    });
  });

  it("takes one decision, on the graph and policy the person reviewed", async () => {
    const { builder, app } = await builderWithApp();
    const second = await personApi("builder");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: second.userId,
      role: "builder",
    });
    // Another of the builder's Apps, asking for other packages.
    const { id: otherApp } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const request = await proposeAs(builder, proposalFor(app));
    const otherRequest = await proposeAs(
      builder,
      proposalFor(otherApp, { graph: charts("3.2.0") })
    );
    const { policyGeneration } = await builder.api.dependencies.waiting();
    const reviewed = { graphHash: request.graphHash, policyGeneration };

    const refused = {
      otherGraph: await outcome(
        builder.api.dependencies.decide(request.id, {
          approved: true,
          reviewed: { ...reviewed, graphHash: "0".repeat(64) },
        })
      ),
      // A review of another App's graph, replayed on this request, and
      // this one's on the other's.
      otherAppsGraph: await outcome(
        builder.api.dependencies.decide(request.id, {
          approved: true,
          reviewed: { ...reviewed, graphHash: otherRequest.graphHash },
        })
      ),
      replayedOnOtherApp: await outcome(
        builder.api.dependencies.decide(otherRequest.id, {
          approved: true,
          reviewed,
        })
      ),
      olderPolicy: await outcome(
        builder.api.dependencies.decide(request.id, {
          approved: true,
          reviewed: { ...reviewed, policyGeneration: policyGeneration - 1 },
        })
      ),
      noReview: await outcome(
        builder.api.dependencies.decide(
          request.id,
          z.custom<{ approved: boolean; reviewed: typeof reviewed }>().parse({
            approved: true,
          })
        )
      ),
      unknown: await outcome(
        builder.api.dependencies.decide("no-such-request", {
          approved: true,
          reviewed,
        })
      ),
    };
    let denied: DependencyRequest | undefined;
    const events = await auditedDuring(async () => {
      denied = await builder.api.dependencies.decide(request.id, {
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
    const askedAgain = await proposeAs(builder, proposalFor(app));

    expect(refused).toStrictEqual({
      otherGraph: "dependency.stale",
      otherAppsGraph: "dependency.stale",
      replayedOnOtherApp: "dependency.stale",
      olderPolicy: "dependency.stale",
      noReview: "dependency.invalid",
      unknown: "dependency.not_found",
    });
    expect(denied).toMatchObject({
      status: "denied",
      decided: {
        by: { userId: builder.userId },
        reason: "Too many packages for a chart",
      },
    });
    expect(afterwards).toStrictEqual({
      recorded: [
        {
          action: "dependency.denied",
          actor: { type: "person", userId: builder.userId },
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
    const { builder, app } = await builderWithApp();
    const { id: otherApp } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const request = await proposeAs(builder, proposalFor(app));
    await approve(builder.api, request);
    // The source moves on. The same packages at a later revision are the
    // approved graph still, and ask nobody again; other packages are a
    // request of their own.
    const laterRevision = await proposeAs(
      builder,
      proposalFor(app, { sourceRevision: "rev-2" })
    );
    const edited = await proposeAs(
      builder,
      proposalFor(app, { sourceRevision: "rev-3", graph: charts("3.2.0") })
    );
    const review = await builder.api.dependencies.get(edited.id);

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
    await approve(builder.api, edited);
    const afterApproval = {
      edited: await admission(builder, edited),
      // The earlier approval stands for what it was given for.
      earlier: await admission(builder, request),
    };
    // The same names and versions with other bytes are another graph, and
    // the review says which package's bytes differ.
    const [chartsNode, scale] = charts("3.2.0").packages;
    const swapped = await proposeAs(
      builder,
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
    const swappedReview = await builder.api.dependencies.get(swapped.id);

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
    const { builder, app } = await builderWithApp();
    const { builder: elsewhere, app: elsewhereApp } = await builderWithApp();
    const request = await proposeAs(builder, proposalFor(app));
    await approve(builder.api, request);
    const ended = await proposeAs(elsewhere, proposalFor(elsewhereApp));
    await approve(elsewhere.api, ended);
    const { policyGeneration: read } = await builder.api.dependencies.status({
      app,
    });

    let stale = "";
    const events = await auditedDuring(async () => {
      // Another App's approval retired: the generation moves on.
      const impact = await elsewhere.api.dependencies.impact(ended.id);
      await elsewhere.api.dependencies.retire(ended.id, {
        reviewed: {
          graphHash: impact.graphHash,
          policyGeneration: impact.policyGeneration,
          approvalsDigest: impact.endings.retire.digest,
        },
        reason: "Replaced.",
      });
      stale = await admission(builder, request, { policyGeneration: read });
    });
    const { policyGeneration: now } = await builder.api.dependencies.status({
      app,
    });
    // What this App had approved stands: that is a decision of its own.
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
    const authority = actingFor({ type: "app", appId: app }, builder.userId);
    const before = Object.keys(await envOf(authority)).toSorted();

    const request = await proposeAs(
      builder,
      proposalFor(app, {
        targets: ["browser", "server", "workflow", "computation"],
      })
    );
    await approve(builder.api, request);

    // No connection, collection, workflow, export or platform binding.
    await expect(
      admin.api.permissions.list({ type: "app", appId: app })
    ).resolves.toStrictEqual([]);
    expect(Object.keys(await envOf(authority)).toSorted()).toStrictEqual(
      before
    );
  });

  it("stores no request or lock for a chat's agent whose run ran out of time while the graph was fetched", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
    await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const intent = intentFor(app, { [dates]: "^1.0.0" });
    const chat = await chatOf(
      builder.userId,
      codeStep(`export default async (self, env) => {
        await env.build.resolveDependencies(${JSON.stringify(app)}, ${JSON.stringify(intent)});
      };`),
      says("It ran out of time.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read"],
      binding: "APP_LIBRARY",
    });
    // The registry answers two seconds late; the run has a second.
    const { CONNECT: connect } = env;
    const slow = new Proxy(connect, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "npmMetadata" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            await scheduler.wait(2000);
            return await Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    await setObjectEnv(chat.stub, { CODE_RUN_TIMEOUT_MS: "1000" });
    env.CONNECT = slow;
    try {
      await chat.ask("Add a date library");
    } finally {
      env.CONNECT = connect;
      await setObjectEnv(chat.stub, { CODE_RUN_TIMEOUT_MS: "" });
    }

    // The resolve goes on past the run's end; what it would store is
    // refused as it commits: no request, no lock.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events
            .filter(
              ({ action, detail }) =>
                action === "agent.call" &&
                detail.chat === chat.chat.id &&
                detail.reason === "agent.run_ended"
            )
            .map(({ detail }) => detail.method)
        ).toStrictEqual(["build.resolveDependencies"]);
      },
      { timeout: 30_000, interval: 200 }
    );
    await expect(
      builder.api.dependencies.status({ app })
    ).resolves.toMatchObject({
      pending: null,
      approved: null,
    });
  });

  it("lets a chat's agent ask, never approve: its builder approves on the chat's card, and the agent is told", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
    await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const proposal = proposalFor(app);
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const intent = intentFor(app, { [dates]: "^1.0.0" });
    const chats = await personalChatsOf(
      builder.userId,
      codeStep(`export default async (self, env) => {
        const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
        const { request } = await env.build.resolveDependencies(${JSON.stringify(app)}, ${JSON.stringify(intent)});
        const decision = { approved: true, reviewed: { graphHash: request.graphHash, policyGeneration: 0 } };
        return {
          request: { id: request.id, status: request.status },
          proposes: await tried(() => env.build.proposeDependencies(${JSON.stringify(app)}, ${JSON.stringify(proposal)})),
          buildDecides: await tried(() => env.build.decideDependency(request.id, decision)),
          buildApproves: await tried(() => env.build.approveDependencies(request.id, decision)),
          decides: (await tried(() => env.dependencies.decide(request.id, decision))).split(". ")[0],
          chatDecides: (await tried(() => env.chats.packageRequests(request.id))).split(". ")[0],
          grantsElsewhere: (await tried(() => env.permissions.grant(request.id, { version: null }))).split(". ")[0],
          asksForIt: await tried(() => env.build.requestPermission(${JSON.stringify(app)}, {
            object: { type: "dependencies" }, actions: ["approve"], binding: "APPROVE",
          })),
        };
      };`),
      says("Proposed: you approve the packages on the card.")
    );
    await requestGranted(idp, admin, {
      subject: chats.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read"],
      binding: "APP_LIBRARY",
    });
    const { chat, ask } = await chats.newChat();
    const elsewhere = await chats.newChat();

    await ask("Add a date library");

    const [result] = await codeResults(chats.stub, chat.id);
    const returned = z
      .object({ request: z.object({ id: z.string(), status: z.string() }) })
      .loose()
      .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "null"));
    const status = await builder.api.dependencies.status({ app });
    // The card: what waits in this chat, and nothing in another.
    const card = await builder.api.chats.packageRequests(chat.id);
    const otherChat = await builder.api.chats.packageRequests(
      elsewhere.chat.id
    );
    const [shown] = card.requests;
    if (shown === undefined) {
      throw new Error("No card");
    }
    const events = await auditedDuring(async () => {
      await builder.api.dependencies.decide(shown.id, {
        approved: true,
        reviewed: {
          graphHash: shown.graphHash,
          policyGeneration: card.policyGeneration,
        },
      });
    });
    const messages: unknown[] = await transcript(chats.stub, chat.id);
    const notes = messages.flatMap((message) => {
      const note = z
        .object({ role: z.literal("system"), content: z.string() })
        .safeParse(message);
      return note.success ? [note.data.content] : [];
    });

    expect(returned).toStrictEqual({
      request: { id: status.pending?.id, status: "pending" },
      proposes: 'The RPC receiver does not implement "proposeDependencies".',
      buildDecides: 'The RPC receiver does not implement "decideDependency".',
      buildApproves:
        'The RPC receiver does not implement "approveDependencies".',
      decides: "This chat has no API named env.dependencies",
      chatDecides: "This chat has no API named env.chats",
      grantsElsewhere: "This chat has no API named env.permissions",
      asksForIt: "That isn't a valid permission request.",
    });
    // Asked by the agent, for its person, and waiting for them on the card.
    expect(status.pending).toMatchObject({
      status: "pending",
      requestedBy: { userId: builder.userId },
      requestedVia: {
        type: "agent",
        agentId: chats.agent.agentId,
        onBehalfOf: builder.userId,
        chatId: chat.id,
      },
    });
    expect({
      card: card.requests.map(({ id }) => id),
      otherChat: otherChat.requests,
      approved: events
        .filter(({ action }) => action === "dependency.approved")
        .map(({ actor, target }) => [actor, target?.id]),
    }).toStrictEqual({
      card: [returned.request.id],
      otherChat: [],
      approved: [
        [{ type: "person", userId: builder.userId }, returned.request.id],
      ],
    });
    const afterwards = await builder.api.chats.packageRequests(chat.id);
    expect({
      told: notes.includes(
        `The npm packages you asked for (request ${returned.request.id}) were approved: the App may use them now.`
      ),
      waiting: afterwards.requests,
    }).toStrictEqual({ told: true, waiting: [] });
  });

  it("takes no decision from an agent acting for the App's builder, and records the refusal", async () => {
    const { builder, app } = await builderWithApp();
    const request = await proposeAs(builder, proposalFor(app));
    const identity = await builder.api.whoami();
    const { policyGeneration } = await builder.api.dependencies.waiting();
    const decision = {
      approved: true,
      reviewed: { graphHash: request.graphHash, policyGeneration },
    };
    const agent = {
      type: "agent" as const,
      agentId: "agent-1",
      onBehalfOf: identity.userId,
    };

    // As core names an agent acting for a person (agent-builds.ts): as
    // the actor, and as what it writes records it.
    const asActor = { ...identity, actor: agent };
    const asVia = {
      ...identity,
      via: { ...agent, workspaceId: "workspace-1", chatId: "chat-1" },
    };

    let refused: string[] = [];
    const events = await auditedDuring(async () => {
      refused = [
        await outcome(decideDependency(env, asActor, request.id, decision)),
        await outcome(decideDependency(env, asVia, request.id, decision)),
      ];
    });
    const status = await builder.api.dependencies.status({ app });

    expect(refused).toStrictEqual([
      "dependency.forbidden",
      "dependency.forbidden",
    ]);
    expect(status.pending?.id).toBe(request.id);
    expect(
      events
        .filter(({ action }) => action === "dependency.decision_refused")
        .map(({ actor, detail }) => [actor.type, detail.reason])
    ).toStrictEqual([
      ["agent", "dependency.forbidden"],
      ["person", "dependency.forbidden"],
    ]);
  });
});
