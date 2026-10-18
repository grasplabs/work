import { z } from "zod";

import type { AgentProposer } from "./apps.ts";
import { sha256Hex } from "./encoding.ts";
import { defineErrorFamily } from "./errors.ts";
import {
  appIdSchema,
  identifierMaxLength,
  workflowResourceIdSchema,
} from "./ids.ts";
import { canonicalJson } from "./json.ts";
import type {
  DependencyIntent,
  GraspLock,
  PackageBuild,
  PackageBuildRequest,
} from "./packages.ts";

// npm packages an App wants to use, and a person's approval of them. An
// agent or a builder asks core to resolve what the App's package.json
// names, and core's resolver proposes one exact graph: every package it
// brings, direct and transitive, each by exact version and integrity hash,
// as the registry has them. It is a request, and allows nothing. A person
// who holds `dependencies.approve` approves or denies the graph as a
// whole. Nothing here fetches, installs or runs a package; a package's own
// words in a graph (a licence, a finding's summary) are shown as text,
// never followed.

/**
 * What packages are requested for, approved for and locked for: an App,
 * or an independent workflow resource (its compute modules, target
 * `computation` only). Approvals are per subject: an App's approval
 * covers no workflow, and a workflow's no App.
 */
export type DependencySubject =
  | { type: "app"; id: string }
  | { type: "workflow"; id: string };

/** A subject as a caller names it: `{ app }` or `{ workflow }`, exactly one. */
export const dependencySubjectRefSchema = z.union([
  z.strictObject({ app: appIdSchema }),
  z.strictObject({ workflow: workflowResourceIdSchema }),
]);
export type DependencySubjectRef = z.input<typeof dependencySubjectRefSchema>;

/** The subject a caller's `{ app }` or `{ workflow }` names. */
export const subjectOfRef = (ref: {
  app?: string;
  workflow?: string;
}): DependencySubject =>
  ref.workflow === undefined
    ? { type: "app", id: ref.app ?? "" }
    : { type: "workflow", id: ref.workflow };

/** How a caller names `subject`: `{ app }` or `{ workflow }`. */
export const refOfSubject = (
  subject: DependencySubject
): DependencySubjectRef =>
  subject.type === "app" ? { app: subject.id } : { workflow: subject.id };

/** A subject as the API shows it: what it is, and its name now. */
export interface NamedDependencySubject {
  type: DependencySubject["type"];
  id: string;
  name: string;
}

/** The only target a workflow's packages may be requested for. */
export const workflowDependencyTarget = "computation";

/** Where a package's code may run. A graph is approved for some, never all by default. */
export const dependencyTargetSchema = z.enum([
  "browser",
  "server",
  "workflow",
  "computation",
]);
export type DependencyTarget = z.infer<typeof dependencyTargetSchema>;

/** The one registry packages come from. No git, file or tarball sources. */
export const npmRegistryOrigin = "https://registry.npmjs.org";

/** Most packages one graph names. */
export const dependencyMaxPackages = 1000;

/**
 * Most bytes of a request's content as core stores it (canonical JSON of
 * the graph, findings and refusals): measured, never taken from a count
 * the request states.
 */
export const dependencyMaxBytes = 512 * 1024;

/** Most findings, and most refused requirements, one request reports. */
export const dependencyMaxFindings = 200;
export const dependencyMaxRefused = 50;

/** Most packages one package depends on, and most peers it asks for. */
const maxEdges = 256;
const maxPeers = 32;

/** Most packages the platform provides as peers (React, the SDK, the UI kit). */
const maxPlatformPeers = 16;

/** An npm package name, scoped or not, as the registry allows them. */
export const packageNameSchema = z
  .string()
  .max(214)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u,
    "an npm package name"
  );

/** One exact version: never a range, a tag or a URL. */
export const exactVersionSchema = z
  .string()
  .max(128)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "an exact version"
  );

/**
 * The registry's SHA-512 of a tarball, as npm writes it (Subresource
 * Integrity): which bytes, not whether they are safe.
 */
export const integritySchema = z
  .string()
  .regex(/^sha512-[A-Za-z0-9+/]{86}==$/u, "a sha512 integrity hash");

/** One package of a graph, by name and exact version. */
export const packageRefSchema = z.strictObject({
  name: packageNameSchema,
  version: exactVersionSchema,
});
export type DependencyPackageRef = z.infer<typeof packageRefSchema>;

/** A package as one key: `name@version`. */
export const packageKey = ({ name, version }: DependencyPackageRef): string =>
  `${name}@${version}`;

/**
 * A peer a package asks for: the range it states, and the exact version
 * that meets it, the platform's own or a package of the graph; null for
 * one left unmet.
 */
const peerSchema = z.strictObject({
  name: packageNameSchema,
  range: z.string().min(1).max(128),
  resolved: exactVersionSchema.nullable(),
});

/** One package of the graph, as resolved. */
const packageSchema = z.strictObject({
  name: packageNameSchema,
  version: exactVersionSchema,
  origin: z.literal(npmRegistryOrigin),
  /** The registry's SHA-512 of its tarball: which bytes, not whether they are safe. */
  integrity: integritySchema,
  /** The licence it reports, as it reports it; null when it reports none. */
  license: z.string().min(1).max(128).nullable(),
  /** The packages it depends on, each one of the graph. */
  dependencies: z.array(packageRefSchema).max(maxEdges),
  peers: z.array(peerSchema).max(maxPeers),
});
export type DependencyPackage = z.infer<typeof packageSchema>;

/** Each `name@version` in `refs` that comes more than once. */
const repeated = (refs: readonly DependencyPackageRef[]): string[] => {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const ref of refs) {
    const key = packageKey(ref);
    if (seen.has(key)) {
      twice.add(key);
    }
    seen.add(key);
  }
  return [...twice];
};

/**
 * The packages of the graph a package leads to: its dependencies and the
 * peers a package of the graph meets. One on a package the platform
 * provides, at the platform's own version, is an edge the review shows
 * but never a copy in the graph.
 */
const graphEdges = (
  node: DependencyPackage | undefined,
  platformPeers: Readonly<Record<string, string>>
): DependencyPackageRef[] => [
  ...(node?.dependencies ?? []).filter(
    (ref) => platformPeers[ref.name] !== ref.version
  ),
  ...(node?.peers ?? []).flatMap(({ name, resolved }) =>
    resolved !== null && platformPeers[name] !== resolved
      ? [{ name, version: resolved }]
      : []
  ),
];

/**
 * One resolved graph: the packages the source asks for (`direct`), every
 * package that brings (`packages`, the direct ones included) with its
 * edges, and the exact versions the platform provides as peers. Whole and
 * closed: every edge leads to a package of the graph, every package is
 * reached from a direct one, and none is a second copy of what the
 * platform provides.
 */
export const dependencyGraphSchema = z
  .strictObject({
    direct: z.array(packageRefSchema).min(1).max(dependencyMaxPackages),
    packages: z.array(packageSchema).min(1).max(dependencyMaxPackages),
    platformPeers: z.record(packageNameSchema, exactVersionSchema),
  })
  .superRefine(({ direct, packages, platformPeers }, context) => {
    const issue = (path: string, message: string): void => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (Object.keys(platformPeers).length > maxPlatformPeers) {
      issue("platformPeers", `At most ${maxPlatformPeers} platform peers`);
    }
    for (const key of repeated(packages)) {
      issue("packages", `${key} is listed twice`);
    }
    for (const key of repeated(direct)) {
      issue("direct", `${key} is listed twice`);
    }
    const byKey = new Map(packages.map((node) => [packageKey(node), node]));
    for (const node of packages) {
      if (Object.hasOwn(platformPeers, node.name)) {
        issue("packages", `${node.name} is provided by the platform`);
      }
      // Each edge and each peer once: a list with one twice would be
      // another graph by its hash, and the same one to whoever reads it.
      for (const key of repeated(node.dependencies)) {
        issue("packages", `${packageKey(node)} depends on ${key} twice`);
      }
      const peerNames = node.peers.map(({ name }) => name);
      if (new Set(peerNames).size !== peerNames.length) {
        issue("packages", `${packageKey(node)} names a peer twice`);
      }
    }
    const reached = new Set<string>();
    const queue: string[] = [];
    const follow = (from: string, ref: DependencyPackageRef): void => {
      const key = packageKey(ref);
      if (!byKey.has(key)) {
        issue(from, `${key} isn't a package of the graph`);
        return;
      }
      if (!reached.has(key)) {
        reached.add(key);
        queue.push(key);
      }
    };
    for (const ref of direct) {
      follow("direct", ref);
    }
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
      const node = byKey.get(key);
      for (const ref of graphEdges(node, platformPeers)) {
        follow("packages", ref);
      }
    }
    for (const key of byKey.keys()) {
      if (!reached.has(key)) {
        issue("packages", `${key} isn't reached from a direct dependency`);
      }
    }
  });
export type DependencyGraph = z.infer<typeof dependencyGraphSchema>;

/**
 * Something reported about a package, for the person who decides: a
 * licence to look at, or a known vulnerability. Evidence, not proof: a
 * graph without findings isn't shown to be safe.
 */
const findingSchema = z.strictObject({
  kind: z.enum(["license", "security"]),
  package: packageRefSchema,
  severity: z.enum(["info", "low", "moderate", "high", "critical"]),
  /** What names it elsewhere, such as an advisory's ID. */
  id: z.string().min(1).max(128).nullable(),
  summary: z.string().min(1).max(300),
});
export type DependencyFinding = z.infer<typeof findingSchema>;

/** Something a package needs to run that the platform refuses, such as an install script. */
const refusedSchema = z.strictObject({
  package: packageRefSchema,
  requirement: z.string().min(1).max(200),
});
export type DependencyRefusal = z.infer<typeof refusedSchema>;

/**
 * The revision of the source a graph was resolved from, as whoever
 * resolved it names it: provenance, kept with the request. What is
 * approved is the graph: the same graph at a later revision needs no
 * new approval, and a change of what the source asks for is another
 * graph, with another hash.
 */
const sourceRevisionSchema = z
  .string()
  .regex(/^[\w.:-]{1,128}$/u, "a source revision");

const uniqueTargets = z
  .array(dependencyTargetSchema)
  .min(1)
  .refine((targets) => new Set(targets).size === targets.length, {
    message: "Each target once",
  });

/**
 * What core's resolver proposes: one graph, for one App at one source
 * revision. Never taken from a client.
 */
export const dependencyProposalSchema = z
  .strictObject({
    /** Whose graph it is: an App's, or a workflow's (exactly one). */
    app: appIdSchema.optional(),
    workflow: workflowResourceIdSchema.optional(),
    sourceRevision: sourceRevisionSchema,
    /** Why the App needs them, in the proposer's words. */
    purpose: z.string().trim().min(1).max(500),
    /** Where the packages would run. */
    targets: uniqueTargets,
    graph: dependencyGraphSchema,
    findings: z.array(findingSchema).max(dependencyMaxFindings),
    refused: z.array(refusedSchema).max(dependencyMaxRefused),
  })
  .superRefine(
    ({ app, workflow, targets, graph, findings, refused }, context) => {
      if ((app === undefined) === (workflow === undefined)) {
        context.addIssue({
          code: "custom",
          path: ["app"],
          message: "Either an App or a workflow, not both",
        });
      }
      if (
        workflow !== undefined &&
        targets.some((target) => target !== workflowDependencyTarget)
      ) {
        context.addIssue({
          code: "custom",
          path: ["targets"],
          message: `A workflow's packages are for ${workflowDependencyTarget} only`,
        });
      }
      const known = new Set(graph.packages.map(packageKey));
      const check = (path: string, refs: DependencyPackageRef[]): void => {
        for (const ref of refs) {
          if (!known.has(packageKey(ref))) {
            context.addIssue({
              code: "custom",
              path: [path],
              message: `${packageKey(ref)} isn't a package of the graph`,
            });
          }
        }
      };
      check(
        "findings",
        findings.map((finding) => finding.package)
      );
      check(
        "refused",
        refused.map((entry) => entry.package)
      );
    }
  );
/** A proposal as the resolver makes it, with a plain string App ID. */
export type DependencyProposal = z.input<typeof dependencyProposalSchema>;

const byPackage = (a: DependencyPackageRef, b: DependencyPackageRef): number =>
  packageKey(a) < packageKey(b) ? -1 : 1;

/**
 * The graph with everything in one order, so the same graph always reads
 * (and hashes) the same, however its lists were sent.
 */
export const canonicalGraph = ({
  direct,
  packages,
  platformPeers,
}: DependencyGraph): DependencyGraph => ({
  direct: direct.toSorted(byPackage),
  packages: packages.toSorted(byPackage).map((node) => ({
    ...node,
    dependencies: node.dependencies.toSorted(byPackage),
    peers: node.peers.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
  })),
  platformPeers,
});

/**
 * What names a graph: the SHA-256 of its canonical JSON, over every
 * package, version, origin, integrity hash, licence, edge and peer, and
 * the platform's peers. It says which graph, never that the graph is safe.
 */
export const dependencyGraphHash = async (
  graph: DependencyGraph
): Promise<string> => await sha256Hex(canonicalJson(canonicalGraph(graph)));

/**
 * Where a request stands. Pending: asked, allows nothing. Approved: a
 * person approved exactly this graph, for this App and these targets.
 * Denied: a person refused it. A pending request another proposal for the
 * App replaces is gone: only the audit log keeps it.
 *
 * Once approved, a person may end the approval (spec 19.3.1). Retired: a
 * lifecycle decision. Nothing new is built with the graph, and what was
 * built with it before (the artifacts its lock pinned) keeps working.
 * Revoked: a security decision. Nothing of the graph is built, handed out
 * or served any more. Neither is ever approved again: a person approves
 * the graph again as a new request.
 */
export type DependencyRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "retired"
  | "revoked";

/** Most direct packages, and most findings, a request shows in a list. */
export const dependencySummaryDirect = 8;
export const dependencySummaryFindings = 5;

/**
 * The little of a request a list shows without its whole graph: the first
 * direct packages (`name@version`, in order) and the gravest findings.
 * `counts` says how many there are in all.
 */
export interface DependencySummary {
  direct: string[];
  findings: DependencyFinding[];
}

/** A request, without its packages. */
export interface DependencyRequest {
  id: string;
  /** Whose graph it is: an App or a workflow, by its name now. */
  subject: NamedDependencySubject;
  status: DependencyRequestStatus;
  /** The revision of the source the graph was resolved from: provenance. */
  sourceRevision: string;
  purpose: string;
  targets: DependencyTarget[];
  /** What names its graph (`dependencyGraphHash`). */
  graphHash: string;
  /** How many packages it asks for directly, brings in all, and what was reported of them. */
  counts: {
    direct: number;
    packages: number;
    findings: number;
    refused: number;
  };
  /** What a list shows of its packages and findings. */
  summary: DependencySummary;
  /**
   * Who asked, and when (ISO 8601). What the request says of its packages
   * (versions, hashes, peers) is what core's resolver read from the
   * registry; a licence is as the package states it.
   */
  requestedBy: { userId: string; name: string };
  requestedAt: string;
  /** The chat's agent that proposed it, acting for `requestedBy`; null for a person's own. */
  requestedVia: AgentProposer | null;
  /** The policy generation it was asked under. */
  policyGeneration: number;
  /** Who decided, when, and why if they said; only once approved or denied. */
  decided?: {
    by: { userId: string; name: string };
    at: string;
    reason: string | null;
    /** The policy generation the decision was made under. */
    policyGeneration: number;
  };
  /** Who retired or revoked the approval, when and why; only once they did. */
  ended?: {
    by: { userId: string; name: string };
    at: string;
    reason: string;
    /** The policy generation it moved on to as it ended. */
    policyGeneration: number;
  };
}

/** A request with everything a person reviews before deciding. */
export interface DependencyReview extends DependencyRequest {
  graph: DependencyGraph;
  findings: DependencyFinding[];
  refused: DependencyRefusal[];
  /**
   * What it changes of the graph approved for the App when it was asked:
   * the packages it adds, those it no longer brings, and those with the
   * same name and version whose bytes or origin differ (`changed`). Null
   * when none was approved yet: then every package is new.
   */
  previous: {
    request: string;
    added: DependencyPackageRef[];
    removed: DependencyPackageRef[];
    changed: DependencyPackageRef[];
  } | null;
}

/** What waits on a person who approves dependencies. */
export interface DependenciesWaiting {
  /** The policy generation now: a decision names the one it was made under. */
  policyGeneration: number;
  requests: DependencyRequest[];
}

/** How an App's dependencies stand. */
export interface DependencyStatus {
  policyGeneration: number;
  /** The request waiting for a decision, if any. */
  pending: DependencyRequest | null;
  /**
   * The approval it got last, if any. Earlier ones still hold for their
   * own graphs: whether a graph is approved is the admission check's to
   * say.
   */
  approved: DependencyRequest | null;
}

/** Most approvals `DependenciesApi.approvals` lists for an App: the newest. */
export const dependencyApprovalsListed = 50;

/** An App's approvals in force, for its builders and whoever may end them. */
export interface DependencyApprovals {
  /** The policy generation now. */
  policyGeneration: number;
  /** Whether the reader holds `dependencies.approve` now, so may retire or revoke them. */
  decides: boolean;
  /** The App or workflow, by its name: all a reader who doesn't build it is told of it. */
  subject: NamedDependencySubject;
  /** Approved or retired, the newest decision first; at most {@link dependencyApprovalsListed}. */
  approvals: DependencyRequest[];
}

/** What a person decides, and what they reviewed as they did. */
export const dependencyDecisionSchema = z.strictObject({
  approved: z.boolean(),
  reviewed: z.strictObject({
    graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
    policyGeneration: z.int().nonnegative(),
  }),
  reason: z.string().trim().min(1).max(identifierMaxLength).optional(),
});
export type DependencyDecision = z.input<typeof dependencyDecisionSchema>;

/**
 * What names a set of approvals as a person reviewed it: the SHA-256 of
 * their IDs, each once, sorted, one per line. A decision names the set by
 * this however many approvals it holds, so ending one is never refused
 * for its size.
 */
export const dependencyApprovalsDigest = async (
  ids: readonly string[]
): Promise<string> => await sha256Hex([...new Set(ids)].toSorted().join("\n"));

/** Most approvals `DependencyImpact.approvals` lists: the newest. */
export const dependencyImpactListed = 50;

/** How many subjects a page of the approvers' list of approvals in force shows. */
export const dependencySubjectsListed = 100;

/**
 * The Apps and workflows that hold approvals in force (approved or
 * retired), for someone who holds `dependencies.approve` now: each by its
 * name, with how many approvals it holds, the newest decision first.
 */
export interface DependencySubjectsInForce {
  /** Whether the reader holds `dependencies.approve` now; none listed otherwise. */
  decides: boolean;
  /** At most {@link dependencySubjectsListed}: one page. */
  subjects: {
    subject: NamedDependencySubject;
    approvals: number;
    decidedAt: string;
  }[];
  /** Where the next page starts (`inForce(next)`); null on the last. */
  next: string | null;
}

/**
 * What a person decides when they retire or revoke an approved graph, and
 * what they reviewed as they did: the graph, the approvals it would end
 * and the policy generation they read its impact under
 * (`DependencyImpact`). Why is required: it is
 * what the audit trail and the App's builders are told.
 */
export const dependencyEndingSchema = z.strictObject({
  reviewed: z.strictObject({
    graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
    policyGeneration: z.int().nonnegative(),
    /**
     * The digest of the approvals the impact said this decision ends
     * (`DependencyImpact.endings`, `dependencyApprovalsDigest`): it ends
     * exactly those, or nothing.
     */
    approvalsDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  reason: z.string().trim().min(1).max(identifierMaxLength),
});
export type DependencyEnding = z.input<typeof dependencyEndingSchema>;

/** One artifact built from a graph, as its lock pins it. */
export interface DependencyImpactArtifact {
  target: DependencyTarget;
  /** The compiler release that built it. */
  compiler: string;
  /** Its SHA-256, as the lock pins it. */
  hash: string;
  /** When it was pinned or last handed out (ISO 8601). */
  pinnedAt: string;
}

/**
 * What retiring or revoking an App's approved graph would touch, for the
 * person deciding to read first: every approval of the graph that would
 * end, and the artifacts built from it. Retiring keeps those artifacts
 * working and builds nothing new; revoking stops them all. No release,
 * screen or workflow loads packages yet, so these are all there is.
 */
export interface DependencyImpact {
  /** The policy generation now: a decision names the one it was read under. */
  policyGeneration: number;
  subject: NamedDependencySubject;
  graphHash: string;
  /**
   * The approvals of the graph still in force (approved or retired), the
   * newest decision first, at most {@link dependencyImpactListed}.
   */
  approvals: DependencyRequest[];
  /**
   * What each decision would end, all of it however many the list shows:
   * how many approvals, and their digest, which the decision names.
   * Retiring ends those approved; revoking, retired ones too.
   */
  endings: Record<"retire" | "revoke", { approvals: number; digest: string }>;
  artifacts: DependencyImpactArtifact[];
}

/** Who may hold `dependencies.approve`: a member, or everyone in a team. */
export const dependencyApproverSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("person"),
    userId: z.string().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal("team"),
    teamId: z.string().min(1).max(128),
  }),
]);
export type DependencyApproverSubject = z.infer<
  typeof dependencyApproverSubjectSchema
>;

/** Why a dependency call was refused. */
export const dependencyErrors = defineErrorFamily({
  "dependency.invalid": "That isn't a valid dependency request.",
  "dependency.not_found": "There's no such dependency request.",
  "dependency.forbidden":
    "Only someone an admin gave the permission to approve dependencies decides this.",
  "dependency.stale":
    "This request changed, was decided or was replaced since you opened it. Open it again before deciding.",
  "dependency.approval_required":
    "These packages aren't approved for this App or workflow. Someone with the permission to approve dependencies decides.",
  "dependency.policy_changed":
    "Who approves dependencies, or what is approved, changed. Read the status again.",
  "dependency.retired":
    "These packages were retired for this App or workflow: what was built with them keeps working, but nothing new is built. Someone with the permission to approve dependencies can approve them again.",
  "dependency.revoked":
    "These packages were revoked for this App or workflow and can't be used. Someone with the permission to approve dependencies can approve them again after a new review.",
});

/** Someone who holds `dependencies.approve`, as the API returns it. */
export interface DependencyApprover {
  /** The grant's ID. */
  id: string;
  subject: DependencyApproverSubject;
  /** The member's or team's name, as it is now; null once it is gone. */
  name: string | null;
  status: "active" | "revoked";
  /** User IDs, and when (ISO 8601). */
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

/**
 * A signed-in person's dependency requests and approvals, over `/rpc`:
 * every call checks the session, and who the person is now. Nothing here
 * is offered to an agent, a workflow or App code.
 */
export interface DependenciesApi {
  /**
   * Resolves what an App's package.json asks for into an exact graph
   * from the npm registry, checks every package's bytes without running
   * them, and proposes it, for one of its builders: a request that waits
   * for a decision and allows nothing. The same graph again is the same
   * request; another one for the App takes a waiting one's place. The only
   * way a request is made: none is taken as a client states it.
   */
  resolve: (intent: DependencyIntent) => Promise<{
    request: DependencyRequest;
    lock: GraspLock;
  }>;
  /**
   * Builds one target of an App's approved graph into an artifact (or
   * returns the one built before), for one of its builders: only what
   * was approved, under the policy generation the caller read.
   */
  build: (request: PackageBuildRequest) => Promise<PackageBuild>;
  /** How an App's or a workflow's dependencies stand, for its builders. */
  status: (subject: DependencySubjectRef) => Promise<DependencyStatus>;
  /**
   * The requests waiting on the person: every pending one, if they hold
   * `dependencies.approve` now; none otherwise.
   */
  waiting: () => Promise<DependenciesWaiting>;
  /** How many wait on the person: what `waiting` would list. */
  waitingCount: () => Promise<number>;
  /** One request in full, for whoever may decide it or builds its App. */
  get: (request: string) => Promise<DependencyReview>;
  /**
   * Approves or denies a pending request, once. Only a member who holds
   * `dependencies.approve` as the decision lands, never Grasp staff; no
   * role gives it. Refused with `dependency.stale` when the request is no
   * longer the one reviewed.
   */
  decide: (
    request: string,
    decision: DependencyDecision
  ) => Promise<DependencyRequest>;
  /**
   * An App's or a workflow's approvals in force (approved or retired), for one of its
   * builders or someone who holds `dependencies.approve` now.
   */
  approvals: (subject: DependencySubjectRef) => Promise<DependencyApprovals>;
  /**
   * Every App and workflow holding approvals in force, for someone who
   * holds `dependencies.approve` now; none for anyone else.
   */
  inForce: (cursor?: string) => Promise<DependencySubjectsInForce>;
  /**
   * What retiring or revoking the graph of approval `request` would touch,
   * for someone who holds `dependencies.approve` now.
   */
  impact: (request: string) => Promise<DependencyImpact>;
  /**
   * Retires the graph of approval `request` for its App: nothing new is
   * built with it, and what was built keeps working. Only a member who
   * holds `dependencies.approve` as it lands, on the graph and policy
   * generation they reviewed; audited. Returns the approvals it ended.
   */
  retire: (
    request: string,
    ending: DependencyEnding
  ) => Promise<DependencyRequest[]>;
  /**
   * Revokes the graph of approval `request` for its App, retired or not:
   * nothing of it is built, handed out or served any more. As `retire`
   * for who may and what is checked.
   */
  revoke: (
    request: string,
    ending: DependencyEnding
  ) => Promise<DependencyRequest[]>;
  /** Who holds `dependencies.approve`, revoked ones included. Admins only. */
  approvers: () => Promise<DependencyApprover[]>;
  /**
   * Gives a member or a team `dependencies.approve`. Admins only, never
   * Grasp staff; audited. An admin needs it too, and may give it to
   * themselves.
   */
  grantApprover: (
    subject: DependencyApproverSubject
  ) => Promise<DependencyApprover>;
  /** Revokes it: their next decision is refused. Admins only; audited. */
  revokeApprover: (id: string) => Promise<DependencyApprover>;
}
