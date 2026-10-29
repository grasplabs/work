import { clientsNamespace } from "@grasp-os/shared/names";
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import golden from "../../../scripts/release/testdata/golden-manifest.json" with { type: "json" };
import type { StaffAlert } from "../src/alerts.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { auditEvents, clientProvisions, releases } from "../src/db/schema.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import { destinationOf } from "../src/hosting/inventory.ts";
import {
  runClientProvision,
  startClientProvision,
} from "../src/hosting/operation.ts";
import { destinationChoices } from "../src/hosting/placement.ts";
import type { DestinationCapabilities } from "../src/hosting/policy.ts";
import { releaseFindings } from "../src/hosting/release-checks.ts";
import { claimRun } from "../src/runners.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, placedClient, staff } from "./hosting.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Grasp's own destination checks every requirement of its policy itself
// (src/hosting/policy.ts): no person records anything for it. How that
// can fail, each tried below:
// - A requirement counted as met that nothing observed, or observed as
//   someone it wasn't.
// - A release that logs payloads, or reaches models some other way,
//   provisioned anyway, or something created before it is refused.
// - Core's Durable Objects made outside the EU, and the client published
//   regardless, or the next client placed there too.
// - Evidence written again by every client.

const token = "test-deployer-token-own-evidence-5b1e";
const cloudflare = mockCloudflareApi(token);
const namespace = clientsNamespace("production");
const secrets: DeploySecrets = {
  routerKey: "test-router-key",
  clientKey: "test-client-key",
  shared: { connect: { COMPOSIO_API_KEY: "composio" } },
};
const domain = "grasp.test";

/** The binding kinds Workers for Platforms documents for user Workers. */
const documented = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/** A release a client in the namespace runs, imported; `adjust` changes core. */
const imported = async (
  spec: Partial<ReleaseSpec> = {},
  adjust: (core: WorkerEntry) => WorkerEntry = (core) => core
): Promise<ReleaseManifest> => {
  // Core binds its connect, as the real one does: through the gateway.
  const bindsConnect = (entry: WorkerEntry): WorkerEntry => ({
    ...entry,
    bindings: [
      ...entry.bindings.filter(({ type }) => documented.has(type)),
      { type: "service", name: "CONNECT", service: "grasp-os-connect" },
    ],
  });
  const built = await buildRelease({
    notes: "feat(core): checked",
    crons: [],
    ...spec,
  });
  const { core } = built.manifest.workers;
  if (core === undefined) {
    throw new Error("The test release has no core");
  }
  const manifest: ReleaseManifest = {
    ...built.manifest,
    workers: {
      ...built.manifest.workers,
      core: adjust(
        bindsConnect({
          ...core,
          durableObjectMigrations: [
            { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
          ],
        })
      ),
    },
  };
  await putBlobs(built);
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    limitEvidence: built.limitEvidenceText ?? null,
    builtAt: now,
    importedAt: now,
  });
  return manifest;
};

/** Grasp's own destination on a new account, recorded claiming nothing, as the admin records it. */
const ownDestination = async (capabilities: DestinationCapabilities = {}) => {
  const account = cloudflare.addAccount();
  account.namespaces.set(namespace, new Map());
  const destinationId = await destination({
    kind: "workers_for_platforms",
    accountId: account.id,
    namespace,
    capabilities,
  });
  return { account, destinationId };
};

/** Runs provisioning a new client placed in `destinationId` on `manifest` to its end, telling staff into `told`. */
const provisioned = async (
  account: ReturnType<typeof cloudflare.addAccount>,
  destinationId: string,
  manifest: ReleaseManifest,
  told: StaffAlert[] = []
) => {
  const { clientId } = await placedClient(destinationId);
  const runId = await claimRun(
    db,
    staff,
    clientId,
    null,
    { action: "client.provision_placed", clientId },
    { kind: "provision_placed", runId: `${clientId}-p1` }
  );
  if (runId === undefined) {
    throw new Error("The run wasn't claimed");
  }
  const held = { clientId, runId };
  await startClientProvision(db, staff, held, manifest.releaseId);
  // A run that stops records why, and throws: what it recorded is read below.
  const stopped = await runClientProvision(
    {
      api: cloudflareApi({ token, retryDelayMs: 0 }),
      db,
      store: env.RELEASES,
      secrets,
      router: {
        hosts: env.ROUTER_HOSTS,
        domain,
        smoke: { retryDelayMs: 0 },
        namespace,
        dispatcher: cloudflare.dispatcher(account.id, namespace),
      },
      observe: { retryDelayMs: 0 },
      alert: async (alert) => {
        told.push(alert);
        await Promise.resolve();
      },
    },
    held
  ).then(
    () => null,
    (error: unknown) => error
  );
  const operation = await db
    .select({
      status: clientProvisions.status,
      step: clientProvisions.step,
      error: clientProvisions.error,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  return { clientId, operation, stopped };
};

/** What the destination's record says of each capability: its status and who observed it. */
const recordedOf = async (destinationId: string) => {
  const { capabilities } = await destinationOf(db, destinationId);
  return Object.fromEntries(
    Object.entries(capabilities).map(([capability, entry]) => [
      capability,
      `${entry?.status ?? "unknown"} by ${entry?.evidence.recordedBy ?? "nobody"}`,
    ])
  );
};

/** Where each requirement stands on the checklist, and by whom. */
const checklistOf = async (destinationId: string) => {
  const choices = await destinationChoices(db, "eu-storage");
  const own = choices.find(({ id }) => id === destinationId);
  return Object.fromEntries(
    (own?.checks ?? []).map(({ capability, state, evidence, byHand }) => [
      capability,
      `${state} by ${evidence?.recordedBy ?? "nobody"}${byHand ? ", by hand" : ""}`,
    ])
  );
};

/** How many evidence records `destinationId` has had written, audited. */
const evidenceWrites = async (destinationId: string): Promise<number> => {
  const events = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.target, destinationId),
        eq(auditEvents.action, "destination.evidence")
      )
    );
  return events.length;
};

describe("Grasp's own destination checking its policy itself", () => {
  useStoreSecrets({ deployer: token });
  // A run that stops logs why.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("verifies all six requirements with no person: read back, the probe, the release and the platform's record, and writes nothing again for the next client", async () => {
    const manifest = await imported();
    const { account, destinationId } = await ownDestination();
    const before = await checklistOf(destinationId);

    const first = await provisioned(account, destinationId, manifest);
    const written = await evidenceWrites(destinationId);
    const second = await provisioned(account, destinationId, manifest);

    const { capabilities } = await destinationOf(db, destinationId);
    expect({
      before,
      first: first.operation?.status,
      second: second.operation?.status,
      recorded: await recordedOf(destinationId),
      after: await checklistOf(destinationId),
      durableObjects: capabilities[
        "durable_objects.eu_jurisdiction"
      ]?.evidence.procedure.endsWith("and each id names the eu jurisdiction."),
      logs: capabilities["logs.payload_free"]?.evidence.subject,
      written,
      writtenAgain: (await evidenceWrites(destinationId)) - written,
    }).toStrictEqual({
      // Nothing for a person to do, before any client: the platform's
      // record stands for secret replication.
      before: {
        "d1.eu_jurisdiction": "checked_on_provision by nobody",
        "r2.eu_jurisdiction": "checked_on_provision by nobody",
        "durable_objects.eu_jurisdiction": "checked_on_provision by nobody",
        "logs.payload_free": "checked_on_provision by nobody",
        "models.approved_transport": "checked_on_provision by nobody",
        "secrets.replication_recorded": "verified by platform",
      },
      first: "done",
      second: "done",
      recorded: {
        "logs.payload_free": "verified by system",
        "models.approved_transport": "verified by system",
        "d1.eu_jurisdiction": "verified by system",
        "r2.eu_jurisdiction": "verified by system",
        "durable_objects.eu_jurisdiction": "verified by system",
      },
      after: {
        "d1.eu_jurisdiction": "verified by system",
        "r2.eu_jurisdiction": "verified by system",
        "durable_objects.eu_jurisdiction": "verified by system",
        "logs.payload_free": "verified by system",
        "models.approved_transport": "verified by system",
        "secrets.replication_recorded": "verified by platform",
      },
      durableObjects: true,
      logs: { kind: "release", id: manifest.releaseId },
      written: 5,
      writtenAgain: 0,
    });
  });

  it.each([
    {
      shows: "invocation logs on in core",
      spec: {},
      adjust: (core: WorkerEntry): WorkerEntry => ({
        ...core,
        observability: { enabled: true, logs: { invocation_logs: true } },
      }),
    },
    {
      shows: "no model transport declared",
      spec: { modelTransport: null },
      adjust: (core: WorkerEntry): WorkerEntry => core,
    },
    {
      shows: "a gateway that may log prompts",
      spec: {
        modelTransport: {
          via: "ai_gateway" as const,
          payloadLogging: true,
          cache: false,
        },
      },
      adjust: (core: WorkerEntry): WorkerEntry => core,
    },
  ])(
    "refuses a release with $shows before anything is created, and records nothing against the destination",
    async ({ spec, adjust }) => {
      const manifest = await imported(spec, adjust);
      const { account, destinationId } = await ownDestination();
      const calls = cloudflare.calls.length;

      const { operation } = await provisioned(account, destinationId, manifest);

      expect({
        operation,
        created: cloudflare.calls
          .slice(calls)
          .filter(({ method }) => method === "POST").length,
        recorded: await recordedOf(destinationId),
      }).toStrictEqual({
        operation: {
          status: "failed",
          step: null,
          error: "release_check_failed",
        },
        created: 0,
        recorded: {},
      });
    }
  );

  it("stops at the probe when core makes Durable Object ids outside the EU, marks the destination, tells staff, and places no one there after", async () => {
    const manifest = await imported();
    const { account, destinationId } = await ownDestination();
    account.coreProbe = { durableObjects: { AUDIT_LOG: null } };
    const told: StaffAlert[] = [];

    const { clientId, operation } = await provisioned(
      account,
      destinationId,
      manifest,
      told
    );
    const choices = await destinationChoices(db, "eu-storage");
    const recorded = await recordedOf(destinationId);

    expect({
      operation,
      published: await env.ROUTER_HOSTS.get(`${clientId}.${domain}`),
      durableObjects: recorded["durable_objects.eu_jurisdiction"],
      told: told.map(({ kind }) => kind),
      problems: choices.find(({ id }) => id === destinationId)?.problems,
    }).toStrictEqual({
      operation: {
        status: "failed",
        step: "secrets",
        error: "durable_objects_outside_jurisdiction",
      },
      published: null,
      durableObjects: "unsupported by system",
      told: ["hosting_check_failed"],
      problems: [
        {
          kind: "capability_unsupported",
          capability: "durable_objects.eu_jurisdiction",
        },
      ],
    });
  });
});

describe("what the real release shows by itself", () => {
  it("is payload-free logs and approved model transport, read from the manifest the release build writes", () => {
    const real = releaseManifestSchema.parse(golden);
    const { connect } = real.workers;
    if (connect === undefined) {
      throw new Error("The real release has no connect");
    }
    const loggingConnect: ReleaseManifest = {
      ...real,
      workers: {
        ...real.workers,
        connect: {
          ...connect,
          observability: { logs: { invocation_logs: true } },
        },
      },
    };

    expect({
      real: releaseFindings(real).map(({ capability, holds }) => [
        capability,
        holds,
      ]),
      loggingConnect: releaseFindings(loggingConnect).find(
        ({ capability }) => capability === "logs.payload_free"
      )?.holds,
    }).toStrictEqual({
      real: [
        ["logs.payload_free", true],
        ["models.approved_transport", true],
      ],
      loggingConnect: false,
    });
  });
});
