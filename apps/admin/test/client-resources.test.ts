import { gatewayScriptOf } from "@grasp-os/shared/connect-gateway";
import { clientsNamespace, platformWorkerName } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import golden from "../../../scripts/release/testdata/golden-manifest.json" with { type: "json" };
import { auditEvents } from "../src/db/schema.ts";
import {
  allocateClientResources,
  capabilityEvidence,
  clientInventory,
  InventoryError,
  placeClient,
  recordProviderId,
  renderClientWorker,
  saveDestination,
} from "../src/hosting/inventory.ts";
import type {
  ClientPlacement,
  ClientResource,
  DestinationInput,
} from "../src/hosting/inventory.ts";
import type { Evidence } from "../src/hosting/policy.ts";
import { importReleases } from "../src/releases/import.ts";
import {
  client,
  db,
  destination,
  evidence,
  placedClient,
  release,
  staff,
  verified,
} from "./hosting.ts";
import { publishRelease } from "./releases.ts";

/** A release CI published and the admin imported: one evidence can name. */
const importedRelease = async () => {
  const { manifest } = await publishRelease({ notes: "feat(core): verify" });
  await importReleases(env.RELEASES, db);
  return manifest;
};

/** Whether a Workers for Platforms destination in `namespace` saves, by an admin of `stage`. */
const saving = async (stage: Stage, namespace: string | null) =>
  await saveDestination(
    db,
    staff,
    {
      id: `eu-stage-${crypto.randomUUID().slice(0, 8)}`,
      kind: "workers_for_platforms",
      accountId: null,
      namespace,
      policies: ["eu-storage"],
      capabilities: verified({}, evidence),
    },
    stage
  ).then(
    () => "saved",
    (error: unknown) => (error instanceof InventoryError ? error.code : error)
  );

/**
 * Saves a new destination of `kind` whose evidence names `subject`: the
 * code it's refused with, if it is, and whether its evidence was kept.
 */
const save = async (
  subject: Evidence["subject"],
  kind: DestinationInput["kind"] = "workers_for_platforms"
) => {
  const id = `eu-subject-${crypto.randomUUID().slice(0, 8)}`;
  const refused = await saveDestination(
    db,
    staff,
    {
      id,
      kind,
      accountId: null,
      namespace:
        kind === "workers_for_platforms"
          ? clientsNamespace("production")
          : null,
      policies: ["eu-storage"],
      capabilities: verified({}, { ...evidence, subject }),
    },
    "production"
  ).then(
    () => null,
    (error: unknown) => (error instanceof InventoryError ? error.code : error)
  );
  const kept = await capabilityEvidence(db, id);
  return { error: refused, kept: kept.length > 0 };
};

/**
 * The manifest the release build makes of the real wrangler.jsonc of core
 * and connect: every binding they declare. Its golden test
 * (scripts/release/manifest-lib.test.ts) keeps it the configs' own.
 */
const realRelease = releaseManifestSchema.parse(golden);

/** What the provider reports for each database once created: its own uuid. */
const observeDatabases = async (
  inventory: readonly ClientResource[]
): Promise<ClientResource[]> => {
  for (const row of inventory) {
    if (row.kind === "d1_database") {
      // oxlint-disable-next-line no-await-in-loop -- a few databases
      await recordProviderId(db, "system", {
        clientId: row.clientId,
        role: row.role,
        physicalName: row.physicalName,
        providerId: crypto.randomUUID(),
      });
    }
  }
  return await clientInventory(db, inventory[0]?.clientId ?? "");
};

/** Each of `manifest`'s Workers rendered for a client, by app. */
const renderAll = (
  manifest: ReleaseManifest,
  placement: ClientPlacement,
  inventory: readonly ClientResource[]
) =>
  Object.fromEntries(
    Object.entries(manifest.workers).map(([app, worker]) => [
      app,
      renderClientWorker(worker, placement, inventory),
    ])
  );

/** Every name and provider id `inventory` holds. */
const physical = (inventory: readonly ClientResource[]) =>
  inventory.flatMap(({ physicalName, providerId }) =>
    providerId === null ? [physicalName] : [physicalName, providerId]
  );

const nameOf = (inventory: readonly ClientResource[], role: string) =>
  inventory.find((row) => row.role === role);

const bindingOf = (
  worker: ReturnType<typeof renderClientWorker> | undefined,
  name: string
) => worker?.bindings.find((binding) => binding.name === name);

/**
 * The resource rendered `binding` of `worker` names: a database's id, a
 * bucket's or script's name, a class within the Worker's own script.
 * Undefined for a binding that names none.
 */
const boundTo = (
  worker: ReturnType<typeof renderClientWorker>,
  binding: Record<string, unknown>
): string | undefined => {
  switch (binding.type) {
    case "d1": {
      return String(binding.id);
    }
    case "r2_bucket": {
      return String(binding.bucket_name);
    }
    case "service": {
      return String(binding.service);
    }
    case "durable_object_namespace": {
      return `${worker.scriptName}:${String(binding.class_name)}`;
    }
    default: {
      return undefined;
    }
  }
};

/** Every string anywhere in `value`. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
};

/** The code `render` throws, or null when it doesn't. */
const codeOf = (render: () => unknown): string | null => {
  try {
    render();
    return null;
  } catch (error) {
    return error instanceof InventoryError ? error.code : String(error);
  }
};

describe("placing a client", () => {
  it("is refused unless the destination verified every requirement of the policy", async () => {
    const unknown = await destination({
      capabilities: verified({ "logs.payload_free": "unknown" }),
    });
    const unsupported = await destination({
      capabilities: verified({ "d1.eu_jurisdiction": "unsupported" }),
    });
    const otherPolicies = await destination({ policies: [] });
    const clientId = await client();
    const place = async (destinationId: string) =>
      await placeClient(db, staff, {
        clientId,
        destinationId,
        policyId: "eu-storage",
      }).catch((error: unknown) => error);

    await expect(place(unknown)).resolves.toMatchObject({
      code: "placement_refused",
      problems: [
        { kind: "capability_unknown", capability: "logs.payload_free" },
      ],
    });
    await expect(place(unsupported)).resolves.toMatchObject({
      code: "placement_refused",
      problems: [
        { kind: "capability_unsupported", capability: "d1.eu_jurisdiction" },
      ],
    });
    await expect(place(otherPolicies)).resolves.toMatchObject({
      code: "placement_refused",
      problems: [{ kind: "policy_not_allowed" }],
    });
    await expect(place("nowhere")).resolves.toMatchObject({
      code: "destination_unknown",
    });
    await expect(clientInventory(db, clientId)).resolves.toStrictEqual([]);
  });

  it("records a Workers for Platforms destination only in its admin's own stage's namespace, in either direction", async () => {
    expect({
      stagingIntoProduction: await saving(
        "staging",
        clientsNamespace("production")
      ),
      productionIntoStaging: await saving(
        "production",
        clientsNamespace("staging")
      ),
      none: await saving("production", null),
      own: [
        await saving("production", clientsNamespace("production")),
        await saving("staging", clientsNamespace("staging")),
      ],
    }).toStrictEqual({
      stagingIntoProduction: "destination_other_stage",
      productionIntoStaging: "destination_other_stage",
      none: "destination_other_stage",
      own: ["saved", "saved"],
    });
  });

  it("doesn't take a verification without what it was observed against", async () => {
    const { subject: _, ...unanchored } = evidence;
    await expect(
      destination({
        capabilities: {
          "d1.eu_jurisdiction": {
            status: "verified",
            // @ts-expect-error -- evidence that names nothing it was observed on
            evidence: unanchored,
          },
        },
      })
    ).rejects.toThrow("evidence");
  });

  it("doesn't take evidence about anything the admin can't check", async () => {
    const imported = await importedRelease();
    await expect(
      Promise.all([
        save({ kind: "release", id: imported.releaseId }),
        save({ kind: "source", id: imported.commit }),
        save({ kind: "profile", id: "cloudflare" }),
        save({ kind: "profile", id: "workerd" }, "workerd"),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 4 }, () => ({ error: null, kept: true }))
    );
    await expect(
      Promise.all([
        save({ kind: "release", id: "r000000001-abcdef0" }),
        save({ kind: "source", id: "0".repeat(40) }),
        save({ kind: "candidate", id: imported.releaseId }),
        save({ kind: "profile", id: "workerd" }),
        save({ kind: "profile", id: "cloudflare" }, "workerd"),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 5 }, () => ({
        error: "evidence_subject_unknown",
        kept: false,
      }))
    );
  });

  it("keeps the evidence of every save, and audits what each names", async () => {
    const { releaseId } = await importedRelease();
    const destinationId = await destination();
    const observed: Evidence = {
      ...evidence,
      subject: { kind: "release", id: releaseId },
      observedAt: "2026-10-21T09:00:00.000Z",
      record: "https://ci.grasp.test/runs/42?token=not-for-the-log#step-3",
    };
    await saveDestination(
      db,
      staff,
      {
        id: destinationId,
        kind: "workers_for_platforms",
        accountId: null,
        namespace: clientsNamespace("production"),
        policies: ["eu-storage"],
        capabilities: verified({ "logs.payload_free": "unknown" }, observed),
      },
      "production"
    );

    const history = await capabilityEvidence(db, destinationId);
    const declared = history.filter(
      ({ capability }) => capability === "logs.payload_free"
    );
    expect(
      declared.map(
        ({ status, subjectKind, subjectId, record, declaredBy }) => ({
          status,
          subject: subjectKind === null ? null : `${subjectKind}:${subjectId}`,
          record,
          declaredBy,
        })
      )
    ).toStrictEqual([
      {
        status: "verified",
        subject: "profile:cloudflare",
        record: evidence.record,
        declaredBy: staff.email,
      },
      {
        status: "unknown",
        subject: null,
        record: null,
        declaredBy: staff.email,
      },
    ]);
    expect(
      history.findLast(({ capability }) => capability === "d1.eu_jurisdiction")
    ).toMatchObject({
      status: "verified",
      subjectKind: "release",
      subjectId: releaseId,
      record: observed.record,
      observedAt: new Date(observed.observedAt),
      recordedBy: observed.recordedBy,
    });

    const [saved] = await db
      .select({ actor: auditEvents.actor, detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "destination.save"),
          eq(auditEvents.target, destinationId)
        )
      )
      .orderBy(desc(auditEvents.at))
      .limit(1);
    const detail: unknown = JSON.parse(saved?.detail ?? "{}");
    expect({ actor: saved?.actor, detail }).toMatchObject({
      actor: staff.email,
      detail: {
        "evidence.d1.eu_jurisdiction": `verified release:${releaseId} https://ci.grasp.test/runs/42`,
      },
    });
    // The unknown capability has no evidence, and the record's token stays out.
    expect(detail).not.toHaveProperty(["evidence.logs.payload_free"]);
    expect(saved?.detail).not.toContain("not-for-the-log");
  });

  it("happens once, however often it's asked at the same time, and moving is a migration", async () => {
    const destinationId = await destination();
    const elsewhere = await destination();
    const clientId = await client();
    const placements = await Promise.all(
      Array.from(
        { length: 3 },
        async () =>
          await placeClient(db, staff, {
            clientId,
            destinationId,
            policyId: "eu-storage",
          })
      )
    );
    expect(
      new Set(placements.map(({ deploymentId }) => deploymentId)).size
    ).toBe(1);
    expect(placements[0]?.deploymentId).not.toContain(clientId);

    await expect(
      placeClient(db, staff, {
        clientId,
        destinationId: elsewhere,
        policyId: "eu-storage",
      })
    ).rejects.toMatchObject({ code: "placement_changed" });
  });
});

describe("a client's resources", () => {
  it("are its own in a destination it shares, under the release's same names", async () => {
    const destinationId = await destination();
    const manifest = await release();
    const a = await placedClient(destinationId);
    const b = await placedClient(destinationId);
    const inventoryA = await observeDatabases(
      await allocateClientResources(db, staff, {
        clientId: a.clientId,
        manifest,
        operationId: "op-a",
      })
    );
    const inventoryB = await observeDatabases(
      await allocateClientResources(db, staff, {
        clientId: b.clientId,
        manifest,
        operationId: "op-b",
      })
    );

    // The same logical roles for both...
    expect(inventoryA.map(({ role }) => role)).toStrictEqual(
      inventoryB.map(({ role }) => role)
    );
    // Every role the release names, each named by the scheme
    // (@grasp-os/shared/names): grasp-<deployment id>-<component and
    // purpose>, a class within its script.
    const id = a.placement.deploymentId;
    expect(
      Object.fromEntries(
        inventoryA.map(({ role, physicalName }) => [role, physicalName])
      )
    ).toStrictEqual({
      "d1:grasp-os-connect": `grasp-${id}-connect-db`,
      "d1:grasp-os-core": `grasp-${id}-core-db`,
      "d1:grasp-os-knowledge": `grasp-${id}-core-knowledge`,
      "do:grasp-os-core:AuditLog": `grasp-${id}-core:AuditLog`,
      "do:grasp-os-core:Workspace": `grasp-${id}-core:Workspace`,
      "r2:grasp-os-audit-archive": `grasp-${id}-core-audit`,
      "r2:grasp-os-files": `grasp-${id}-core-files`,
      "worker:grasp-os-connect": `grasp-${id}-connect`,
      "worker:grasp-os-core": `grasp-${id}-core`,
    });
    // ...and not one physical resource in common.
    const shared = physical(inventoryA).filter((name) =>
      physical(inventoryB).includes(name)
    );
    expect(shared).toStrictEqual([]);
    for (const row of [...inventoryA, ...inventoryB]) {
      expect(row.jurisdiction).toBe("eu");
      expect(row.physicalName).not.toContain(row.clientId);
      expect(row.physicalName.length).toBeLessThanOrEqual(
        row.kind === "durable_object_class" ? 127 : 63
      );
    }

    const { core: coreA, connect: connectA } = renderAll(
      manifest,
      a.placement,
      inventoryA
    );
    const { core: coreB } = renderAll(manifest, b.placement, inventoryB);
    // Core binds its own connect, databases and buckets, all of them a's.
    expect({
      script: coreA?.scriptName,
      connect: bindingOf(coreA, "CONNECT")?.service,
      db: bindingOf(coreA, "DB")?.id,
      files: bindingOf(coreA, "FILES"),
    }).toStrictEqual({
      script: nameOf(inventoryA, "worker:grasp-os-core")?.physicalName,
      connect: connectA?.scriptName,
      db: nameOf(inventoryA, "d1:grasp-os-core")?.providerId,
      files: {
        type: "r2_bucket",
        name: "FILES",
        bucket_name: nameOf(inventoryA, "r2:grasp-os-files")?.physicalName,
        jurisdiction: "eu",
      },
    });
    expect(bindingOf(coreB, "DB")?.id).not.toBe(bindingOf(coreA, "DB")?.id);
  });

  it("are all a client's Workers bind, for every binding the real core and connect declare", async () => {
    const destinationId = await destination();
    const a = await placedClient(destinationId);
    const b = await placedClient(destinationId);
    const allocate = async (clientId: string) =>
      await observeDatabases(
        await allocateClientResources(db, staff, {
          clientId,
          manifest: realRelease,
          operationId: "op",
        })
      );
    const inventoryA = await allocate(a.clientId);
    const inventoryB = await allocate(b.clientId);
    expect(inventoryA.map(({ role }) => role)).toStrictEqual(
      inventoryB.map(({ role }) => role)
    );
    expect(
      physical(inventoryA).filter((name) => physical(inventoryB).includes(name))
    ).toStrictEqual([]);

    const renderedA = renderAll(realRelease, a.placement, inventoryA);
    const renderedB = renderAll(realRelease, b.placement, inventoryB);
    for (const [rendered, inventory] of [
      [renderedA, inventoryA],
      [renderedB, inventoryB],
    ] as const) {
      // What its Workers are and bind is exactly what it has...
      expect(
        new Set(
          Object.values(rendered).flatMap((worker) => [
            worker.scriptName,
            ...worker.bindings.flatMap(
              (binding) => boundTo(worker, binding) ?? []
            ),
          ])
        )
      ).toStrictEqual(
        new Set(
          inventory.map((row) =>
            row.kind === "d1_database" ? row.providerId : row.physicalName
          )
        )
      );
      // ...a binding that names none of it is the release's own, as is...
      for (const [app, worker] of Object.entries(rendered)) {
        expect(
          worker.bindings.filter(
            (binding) => boundTo(worker, binding) === undefined
          )
        ).toStrictEqual(
          realRelease.workers[app]?.bindings.filter(
            (binding) => boundTo(worker, binding) === undefined
          )
        );
      }
      // ...and no placeholder is left.
      expect(
        stringsIn(rendered).filter((value) => value.startsWith("$"))
      ).toStrictEqual([]);
    }
    // Core's and connect's databases are both bound as DB, each its own.
    expect({
      core: bindingOf(renderedA.core, "DB")?.id,
      connect: bindingOf(renderedA.connect, "DB")?.id,
    }).toStrictEqual({
      core: nameOf(inventoryA, "d1:grasp-os-core")?.providerId,
      connect: nameOf(inventoryA, "d1:grasp-os-connect")?.providerId,
    });
  });

  it("are added to for a later release, and a class it deletes stays enumerable", async () => {
    const destinationId = await destination();
    const { clientId, placement } = await placedClient(destinationId);
    const first = await release();
    const before = await allocateClientResources(db, staff, {
      clientId,
      manifest: first,
      operationId: "op-1",
    });
    const second = await release([
      { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
      { tag: "v2", deleted_classes: ["AuditLog"] },
      { tag: "v3", new_sqlite_classes: ["Onboarding"] },
    ]);
    // Twice, as a retried operation runs it again.
    await allocateClientResources(db, staff, {
      clientId,
      manifest: second,
      operationId: "op-2",
    });
    const after = await allocateClientResources(db, staff, {
      clientId,
      manifest: second,
      operationId: "op-2",
    });

    const unchanged = before.filter(
      ({ role }) => role !== "do:grasp-os-core:AuditLog"
    );
    expect(
      after.filter((row) => unchanged.some(({ role }) => role === row.role))
    ).toStrictEqual(unchanged);
    expect(
      after
        .filter(({ kind }) => kind === "durable_object_class")
        .map(({ role, lifecycle, operationId }) => ({
          role,
          lifecycle,
          operationId,
        }))
    ).toStrictEqual([
      {
        role: "do:grasp-os-core:AuditLog",
        lifecycle: "tombstoned",
        operationId: "op-1",
      },
      {
        role: "do:grasp-os-core:Onboarding",
        lifecycle: "allocated",
        operationId: "op-2",
      },
      {
        role: "do:grasp-os-core:Workspace",
        lifecycle: "allocated",
        operationId: "op-1",
      },
    ]);

    // A release that binds the deleted class can't be rendered, and one
    // that brings it back isn't allocated onto its old identity.
    const { core } = second.workers;
    if (core === undefined) {
      throw new Error("The test release has no core");
    }
    const observed = await observeDatabases(after);
    expect(() =>
      renderClientWorker(
        {
          ...core,
          bindings: [
            ...core.bindings,
            {
              type: "durable_object_namespace",
              name: "AUDIT_LOG",
              class_name: "AuditLog",
            },
          ],
        },
        placement,
        observed
      )
    ).toThrow(expect.objectContaining({ code: "resource_missing" }));
    await expect(
      allocateClientResources(db, staff, {
        clientId,
        manifest: await release([
          { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
          { tag: "v2", deleted_classes: ["AuditLog"] },
          { tag: "v3", new_sqlite_classes: ["Onboarding", "AuditLog"] },
        ]),
        operationId: "op-3",
      })
    ).rejects.toMatchObject({ code: "resource_conflict" });
  });

  it("are allocated once when two operations allocate them at the same time", async () => {
    const destinationId = await destination();
    const { clientId } = await placedClient(destinationId);
    const manifest = await release();
    const [first, second] = await Promise.all(
      ["op-x", "op-y"].map(
        async (operationId) =>
          await allocateClientResources(db, staff, {
            clientId,
            manifest,
            operationId,
          })
      )
    );
    expect(second).toStrictEqual(first);
  });

  it("stop being allocated once the destination withdraws a capability the policy needs", async () => {
    const destinationId = await destination();
    const { clientId } = await placedClient(destinationId);
    await saveDestination(
      db,
      staff,
      {
        id: destinationId,
        kind: "workers_for_platforms",
        accountId: null,
        namespace: clientsNamespace("production"),
        policies: ["eu-storage"],
        capabilities: verified({ "r2.eu_jurisdiction": "unsupported" }),
      },
      "production"
    );
    await expect(
      allocateClientResources(db, staff, {
        clientId,
        manifest: await release(),
        operationId: "op",
      })
    ).rejects.toMatchObject({ code: "placement_refused" });
    await expect(clientInventory(db, clientId)).resolves.toStrictEqual([]);

    // Verified again, on the release it was observed against: the latest
    // evidence is what allocation reads, and what the history ends with.
    const { releaseId } = await importedRelease();
    await saveDestination(
      db,
      staff,
      {
        id: destinationId,
        kind: "workers_for_platforms",
        accountId: null,
        namespace: clientsNamespace("production"),
        policies: ["eu-storage"],
        capabilities: verified(
          {},
          { ...evidence, subject: { kind: "release", id: releaseId } }
        ),
      },
      "production"
    );
    await expect(
      allocateClientResources(db, staff, {
        clientId,
        manifest: await release(),
        operationId: "op",
      })
    ).resolves.not.toStrictEqual([]);
    const history = await capabilityEvidence(db, destinationId);
    const latest = new Map(
      history.map((row) => [
        row.capability,
        { status: row.status, subjectId: row.subjectId },
      ])
    );
    expect(latest.get("r2.eu_jurisdiction")).toStrictEqual({
      status: "verified",
      subjectId: releaseId,
    });
    expect(latest.get("execution.eu_ingress")).toStrictEqual({
      status: "unknown",
      subjectId: null,
    });
  });

  it("are refused for a bucket outside the policy's jurisdiction, one the naming scheme doesn't name, or a class moved by a rename", async () => {
    const destinationId = await destination();
    const { clientId } = await placedClient(destinationId);
    const manifest = await release();
    const { core } = manifest.workers;
    if (core === undefined) {
      throw new Error("The test release has no core");
    }
    const allocate = async (
      bindings: typeof core.bindings,
      migrations = core.durableObjectMigrations
    ) =>
      await allocateClientResources(db, staff, {
        clientId,
        manifest: {
          ...manifest,
          workers: {
            ...manifest.workers,
            core: { ...core, bindings, durableObjectMigrations: migrations },
          },
        },
        operationId: "op",
      }).catch((error: unknown) => error);

    await expect(
      allocate([
        ...core.bindings,
        {
          type: "r2_bucket",
          name: "BACKUPS",
          bucket_name: "grasp-os-backups",
          jurisdiction: "fedramp",
        },
      ])
    ).resolves.toMatchObject({ code: "bucket_jurisdiction" });
    await expect(
      allocate([
        ...core.bindings,
        {
          type: "r2_bucket",
          name: "BACKUPS",
          bucket_name: "grasp-os-backups",
          jurisdiction: "eu",
        },
      ])
    ).resolves.toMatchObject({ code: "resource_unnamed" });
    await expect(
      allocate(core.bindings, [
        ...core.durableObjectMigrations,
        {
          tag: "v2",
          renamed_classes: [{ from: "AuditLog", to: "AuditTrail" }],
        },
      ])
    ).resolves.toMatchObject({ code: "unsupported_durable_object_migration" });
    await expect(clientInventory(db, clientId)).resolves.toStrictEqual([]);
  });
});

describe("rendering a client's Worker", () => {
  // Two clients in one destination, each with the real release's resources.
  const setUp = async () => {
    const destinationId = await destination();
    const a = await placedClient(destinationId);
    const b = await placedClient(destinationId);
    const allocate = async (clientId: string) =>
      await observeDatabases(
        await allocateClientResources(db, staff, {
          clientId,
          manifest: realRelease,
          operationId: "op",
        })
      );
    const { core } = realRelease.workers;
    if (core === undefined) {
      throw new Error("The real release has no core");
    }
    return {
      core,
      a: { ...a, inventory: await allocate(a.clientId) },
      b: { ...b, inventory: await allocate(b.clientId) },
    };
  };

  it("refuses another client's resource, swapped in however", async () => {
    const { core, a, b } = await setUp();
    const swapped = (role: string) =>
      a.inventory.map((row) =>
        row.role === role
          ? (b.inventory.find((other) => other.role === role) ?? row)
          : row
      );
    const roles = [
      "d1:grasp-os-core",
      "r2:grasp-os-files",
      "worker:grasp-os-connect",
      "do:grasp-os-core:Workspace",
      "worker:grasp-os-core",
    ];
    expect(
      Object.fromEntries(
        roles.map((role) => [
          role,
          codeOf(() => renderClientWorker(core, a.placement, swapped(role))),
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(roles.map((role) => [role, "foreign_resource"]))
    );
    // b's whole inventory under a's placement, and a's under b's own.
    expect(() => renderClientWorker(core, a.placement, b.inventory)).toThrow(
      expect.objectContaining({ code: "foreign_resource" })
    );
    expect(() =>
      renderClientWorker(
        core,
        { ...b.placement, clientId: a.clientId },
        a.inventory
      )
    ).toThrow(expect.objectContaining({ code: "foreign_resource" }));
  });

  it("refuses a binding it can't map, before anything is uploaded", async () => {
    const { core, a } = await setUp();
    const render = (binding: (typeof core.bindings)[number]) => () =>
      renderClientWorker(
        { ...core, bindings: [...core.bindings, binding] },
        a.placement,
        a.inventory
      );
    expect(
      render({
        type: "workflow",
        name: "WORKFLOWS",
        workflow_name: "grasp-os-workflows",
        class_name: "WorkflowDispatcher",
      })
    ).toThrow(expect.objectContaining({ code: "unsupported_binding" }));
    expect(
      render({
        type: "durable_object_namespace",
        name: "OTHER",
        class_name: "Workspace",
        script_name: "grasp-os-connect",
      })
    ).toThrow(expect.objectContaining({ code: "unsupported_binding" }));
    expect(
      render({
        type: "send_email",
        name: "MAIL",
        destination_address: "$MAIL_TO",
      })
    ).toThrow(expect.objectContaining({ code: "unknown_placeholder" }));
    expect(render({ type: "d1", name: "EXTRA", id: "$D1_EXTRA_ID" })).toThrow(
      expect.objectContaining({ code: "unknown_placeholder" })
    );
    expect(
      render({ type: "service", name: "OTHER", service: "grasp-os-router" })
    ).toThrow(expect.objectContaining({ code: "resource_missing" }));
  });

  it("binds a service through the connect gateway in a namespace, with props naming only the client's own script, which the gateway accepts", async () => {
    const { core, a, b } = await setUp();
    const connectBinding = (inventory: typeof a.inventory) =>
      renderClientWorker(core, a.placement, inventory, {
        connectGateway: platformWorkerName("connect-gateway", "production"),
      }).bindings.find(({ name }) => name === "CONNECT");
    const ownConnect = a.inventory.find(
      ({ role }) => role === "worker:grasp-os-connect"
    )?.physicalName;

    const bound = connectBinding(a.inventory);
    // The connect script the admin generated for a's new placement is one
    // the gateway reaches (@grasp-os/shared/connect-gateway).
    expect({ bound, accepted: gatewayScriptOf(bound?.props) }).toStrictEqual({
      bound: {
        type: "service",
        name: "CONNECT",
        service: platformWorkerName("connect-gateway", "production"),
        props: { script: ownConnect },
      },
      accepted: ownConnect,
    });
    // Another client's inventory never names a script for a's core.
    expect(() => connectBinding(b.inventory)).toThrow(
      expect.objectContaining({ code: "foreign_resource" })
    );
    // The gateway forwards to a script's default entrypoint alone.
    expect(() =>
      renderClientWorker(
        {
          ...core,
          bindings: core.bindings.map((binding) =>
            binding.name === "CONNECT"
              ? { ...binding, entrypoint: "Admin" }
              : binding
          ),
        },
        a.placement,
        a.inventory,
        { connectGateway: platformWorkerName("connect-gateway", "production") }
      )
    ).toThrow(expect.objectContaining({ code: "unsupported_binding" }));
  });

  it("refuses any binding that would take the Durable Objects out of the EU", async () => {
    const { a } = await setUp();
    const name = "DURABLE_OBJECT_JURISDICTION";
    const bindings = [
      { type: "plain_text", name, text: "none" },
      { type: "json", name, json: "none" },
      { type: "secret_text", name, text: "none" },
      // Not even the EU, nor a kind that carries no value: unset is the EU.
      { type: "plain_text", name, text: "eu" },
      { type: "version_metadata", name },
    ];
    const workers = Object.values(realRelease.workers);
    expect(
      workers.flatMap((worker) =>
        bindings.map((binding) =>
          codeOf(() =>
            renderClientWorker(
              { ...worker, bindings: [...worker.bindings, binding] },
              a.placement,
              a.inventory
            )
          )
        )
      )
    ).toStrictEqual(
      Array.from(
        { length: workers.length * bindings.length },
        () => "durable_object_jurisdiction"
      )
    );
  });

  it("refuses a database the provider hasn't been observed to have", async () => {
    const destinationId = await destination();
    const manifest = await release();
    const { clientId, placement } = await placedClient(destinationId);
    const inventory = await allocateClientResources(db, staff, {
      clientId,
      manifest,
      operationId: "op",
    });
    const { core } = manifest.workers;
    if (core === undefined) {
      throw new Error("The test release has no core");
    }
    expect(() => renderClientWorker(core, placement, inventory)).toThrow(
      expect.objectContaining({ code: "resource_missing" })
    );

    // Once observed, its id doesn't change.
    const database = inventory.find(({ kind }) => kind === "d1_database");
    if (database === undefined) {
      throw new Error("No database allocated");
    }
    const observed = {
      clientId,
      role: database.role,
      physicalName: database.physicalName,
    };
    await recordProviderId(db, "system", { ...observed, providerId: "uuid-1" });
    await recordProviderId(db, "system", { ...observed, providerId: "uuid-1" });
    await expect(
      recordProviderId(db, "system", { ...observed, providerId: "uuid-2" })
    ).rejects.toMatchObject({ code: "resource_conflict" });
  });
});
