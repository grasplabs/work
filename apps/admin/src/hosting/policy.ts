/**
 * Hosting policies and what a destination verifiably does (spec 38).
 * Geography and compliance are modelled apart from where a client runs: a
 * policy lists the capabilities it requires, a destination has each one
 * verified with the evidence observed. A client is placed only where every
 * requirement holds; a capability nothing verified is unknown, and
 * unknown is unsupported.
 *
 * Policies are code, not rows, for now: a new one, or a changed
 * requirement, is a reviewed change. Every read of a policy goes through
 * `hostingPolicyOf`, so where policies are kept can change without
 * touching what reads them. There is no FedRAMP policy:
 * `jurisdiction: "fedramp"` confers no authorization, and the option stays
 * out until its scope is qualified.
 */
import { z } from "zod";

/** What a destination can be verified to do, one surface each (spec 38). */
export const capabilities = [
  /** D1 databases are created in the EU jurisdiction, and verified after. */
  "d1.eu_jurisdiction",
  /** R2 buckets, backups and workflow streams included, are in the EU jurisdiction. */
  "r2.eu_jurisdiction",
  /** Durable Object ids come from the EU-restricted namespace, on creation and lookup. */
  "durable_objects.eu_jurisdiction",
  /** Operational logs and analytics hold no payloads or secret values. */
  "logs.payload_free",
  /** Model calls go through approved endpoints, with payload logging and shared caching off. */
  "models.approved_transport",
  /** How the provider replicates Worker code and secrets is recorded. */
  "secrets.replication_recorded",
  /** HTTP ingress and the whole core, connect and Loader chain run in the EU. */
  "execution.eu_ingress",
  /** Clocks, alarms, dynamic execution and callbacks run in the EU. */
  "execution.eu_background",
] as const;

export type Capability = (typeof capabilities)[number];

/**
 * Where a client can run (`hosting_destinations.kind`): Grasp's own
 * Workers for Platforms namespace, a Cloudflare account of the client's
 * own (`dedicated`), or plain workerd its operator runs (on-prem).
 */
export const destinationKinds = [
  "workers_for_platforms",
  "dedicated",
  "workerd",
] as const;

export type DestinationKind = (typeof destinationKinds)[number];

/**
 * Whether provisioning checks a destination of `kind` itself: Grasp's own
 * Workers for Platforms namespace, the only one of its kind an admin
 * records (src/hosting/inventory.ts), where the admin creates every
 * resource, deploys core and knows the platform.
 */
export const checksItself = (kind: DestinationKind): boolean =>
  kind === "workers_for_platforms";

/**
 * How a capability is verified:
 *
 * - `read_back`: in Grasp's own destination, provisioning creates the
 *   client's databases and buckets and reads back from Cloudflare the
 *   jurisdiction of each (src/hosting/provision.ts).
 * - `probe`: in Grasp's own destination, once core is deployed, core's
 *   probe makes an object id in each Durable Object namespace as it makes
 *   every one, and answers the jurisdiction it names
 *   (src/hosting/probe.ts): Cloudflare's API reports none.
 * - `release`: read from the release's manifest, in every destination,
 *   before anything of it is deployed (src/hosting/release-checks.ts).
 * - `platform`: in Grasp's own destination, a fact about the provider
 *   reviewed in code (`platformFacts`), attributed to the platform.
 * - `manual`: a person records what they checked.
 */
export type VerificationMethod =
  | "read_back"
  | "probe"
  | "release"
  | "platform"
  | "manual";

/** How Grasp's own destination verifies each capability without a person, where it can. */
const ownDestinationMethods: Readonly<
  Partial<Record<Capability, Exclude<VerificationMethod, "manual">>>
> = {
  "d1.eu_jurisdiction": "read_back",
  "r2.eu_jurisdiction": "read_back",
  "durable_objects.eu_jurisdiction": "probe",
  "logs.payload_free": "release",
  "models.approved_transport": "release",
  "secrets.replication_recorded": "platform",
};

/**
 * How `capability` is verified in a destination of `kind`: as Grasp's own
 * verifies it there; elsewhere a release check stays one, and anything
 * else is a person's.
 */
export const methodIn = (
  capability: Capability,
  kind: DestinationKind
): VerificationMethod => {
  const own = ownDestinationMethods[capability];
  if (own === undefined) {
    return "manual";
  }
  return checksItself(kind) || own === "release" ? own : "manual";
};

/** Whether provisioning observes it, so nobody records it beforehand. */
export const observedOnProvision = (method: VerificationMethod): boolean =>
  method === "read_back" || method === "probe" || method === "release";

/** Where a client's data is kept. Set when a resource is created; never relabelled. */
export type Jurisdiction = "eu";

export interface HostingPolicy {
  id: string;
  /** Its name, as staff and a client's progress read it. */
  name: string;
  /** Exactly what is verified, and nothing more. */
  description: string;
  storageJurisdiction: Jurisdiction;
  requires: readonly Capability[];
}

/** Every policy's id. */
export const hostingPolicyIds = ["eu-storage"] as const;

export type HostingPolicyId = (typeof hostingPolicyIds)[number];

export const hostingPolicyIdSchema = z.enum(hostingPolicyIds);

/**
 * The policies a client may be placed under. The first restricts where
 * application data is stored, not where requests run: it doesn't claim
 * that everything stays in the EU.
 */
const hostingPolicies = {
  "eu-storage": {
    id: "eu-storage",
    name: "EU storage",
    description:
      "Application data (D1, R2, Durable Objects) is stored in the EU jurisdiction; logs hold no payloads; models are reached only through approved transport; secret replication is recorded. Requests may run outside the EU.",
    storageJurisdiction: "eu",
    requires: [
      "d1.eu_jurisdiction",
      "r2.eu_jurisdiction",
      "durable_objects.eu_jurisdiction",
      "logs.payload_free",
      "models.approved_transport",
      "secrets.replication_recorded",
    ],
  },
} as const satisfies Record<HostingPolicyId, HostingPolicy>;

/** Policy `id`: the one place a policy is read from. */
export const hostingPolicyOf = (id: HostingPolicyId): HostingPolicy =>
  hostingPolicies[id];

/**
 * What a verification was observed against: the source commit, a candidate
 * or release built from it, or the hosting profile. A report that names
 * none of these proves nothing about what runs.
 */
const subjectSchema = z.strictObject({
  kind: z.enum(["source", "candidate", "release", "profile"]),
  id: z.string().min(1).max(200),
});

/**
 * What was observed: the procedure, against what, when, and where the
 * record of it is kept. A bare "it works" doesn't parse.
 */
export const evidenceSchema = z.strictObject({
  procedure: z.string().min(1).max(500),
  subject: subjectSchema,
  observedAt: z.iso.datetime(),
  /**
   * Who observed it: a staff member, `system` for provisioning's own
   * check, or `platform` for a fact reviewed in code (`platformFacts`).
   */
  recordedBy: z.union([z.email(), z.literal("system"), z.literal("platform")]),
  /** Where the full record is: a qualification issue, a test run, documentation. */
  record: z.url(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * A destination's capabilities: each verified with evidence, or found
 * unsupported (also with evidence, so it isn't asked again blindly).
 */
export const destinationCapabilitiesSchema = z.partialRecord(
  z.enum(capabilities),
  z.strictObject({
    status: z.enum(["verified", "unsupported"]),
    evidence: evidenceSchema,
  })
);

export type DestinationCapabilities = z.infer<
  typeof destinationCapabilitiesSchema
>;

/**
 * Facts about the provider behind Grasp's own destination (Workers for
 * Platforms on Grasp's Cloudflare account), reviewed in code against the
 * documentation each cites and attributed to the platform, not to a
 * person or a check: what a `platform` capability reads. A record for the
 * same capability takes its place (`knownCapabilities`), so one found not
 * to hold still keeps clients out.
 */
export const platformFacts: DestinationCapabilities = {
  "secrets.replication_recorded": {
    status: "verified",
    evidence: {
      procedure:
        "Cloudflare deploys a Worker's code and its secrets to every data centre in its network, encrypted, and not limited by a storage jurisdiction; Workers for Platforms user Workers and their secrets are deployed the same way. Jurisdictions restrict where D1, R2 and Durable Object data is stored, which the other checks cover.",
      subject: { kind: "profile", id: "cloudflare" },
      observedAt: "2026-10-29T00:00:00.000Z",
      recordedBy: "platform",
      record:
        "https://developers.cloudflare.com/workers/configuration/secrets/",
    },
  },
};

/**
 * What is known of a destination of `kind`'s capabilities: what was
 * recorded for it, over the platform's facts in Grasp's own.
 */
export const knownCapabilities = (
  recorded: DestinationCapabilities,
  kind: DestinationKind
): DestinationCapabilities =>
  checksItself(kind) ? { ...platformFacts, ...recorded } : recorded;

/** A destination as a policy judges it. */
export interface JudgedDestination {
  kind: DestinationKind;
  /** The policies it is recorded serving. */
  policies: readonly string[];
  capabilities: DestinationCapabilities;
}

/**
 * Where one requirement stands in a destination: checked and found so
 * (`verified`), or not (`unsupported`); still to be checked by a person
 * (`needs_checking`); or checked by provisioning itself when it runs
 * (`checked_on_provision`).
 */
export type RequirementState =
  | "verified"
  | "unsupported"
  | "needs_checking"
  | "checked_on_provision";

/** Where `capability` stands in `destination`, how it is verified there, and the evidence it rests on. */
export const requirementState = (
  capability: Capability,
  destination: JudgedDestination
): {
  state: RequirementState;
  method: VerificationMethod;
  entry: DestinationCapabilities[Capability];
} => {
  const method = methodIn(capability, destination.kind);
  const entry = knownCapabilities(destination.capabilities, destination.kind)[
    capability
  ];
  if (entry !== undefined) {
    return { state: entry.status, method, entry };
  }
  return {
    state: observedOnProvision(method)
      ? "checked_on_provision"
      : "needs_checking",
    method,
    entry,
  };
};

/** Why a destination can't take a client under a policy. */
export type PlacementProblem =
  | { kind: "policy_not_allowed" }
  | { kind: "capability_unsupported"; capability: Capability }
  | { kind: "capability_unknown"; capability: Capability };

/**
 * Everything that keeps `destination` from taking a client under
 * `policy`: empty when it can. A requirement provisioning observes itself
 * keeps nothing out until it is found not to hold: the run observes it,
 * and stops if it isn't so.
 */
export const placementProblems = (
  policy: HostingPolicy,
  destination: JudgedDestination
): PlacementProblem[] => {
  const problems: PlacementProblem[] = [];
  if (!destination.policies.includes(policy.id)) {
    problems.push({ kind: "policy_not_allowed" });
  }
  for (const capability of policy.requires) {
    const { state } = requirementState(capability, destination);
    if (state === "needs_checking") {
      problems.push({ kind: "capability_unknown", capability });
    } else if (state === "unsupported") {
      problems.push({ kind: "capability_unsupported", capability });
    }
  }
  return problems;
};
