import type { ReleaseManifest } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import {
  allocateClientResources,
  clientInventory,
  placeClient,
  recordProviderId,
  InventoryError,
  renderClientWorker,
  saveDestination,
} from "../src/hosting/inventory.ts";
import type {
  ClientPlacement,
  ClientResource,
  DestinationInput,
} from "../src/hosting/inventory.ts";
import { hostingPolicies } from "../src/hosting/policy.ts";
import type {
  Capability,
  DestinationCapabilities,
} from "../src/hosting/policy.ts";
import { buildRelease } from "./releases.ts";

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

const evidence = {
  procedure:
    "Created a D1 database, R2 bucket and Durable Object in the EU and read back their jurisdiction",
  subject: { kind: "release", id: "r000000001-abcdef0" },
  observedAt: "2026-10-20T10:00:00.000Z",
  recordedBy: "staff@grasp.test",
  record: "https://linear.app/grasp-os/issue/GRA-430",
} as const;

const verified = (
  except: Partial<Record<Capability, "unsupported" | "unknown">> = {}
): DestinationCapabilities =>
  Object.fromEntries(
    hostingPolicies["eu-storage"].requires
      .filter((capability) => except[capability] !== "unknown")
      .map((capability) => [
        capability,
        { status: except[capability] ?? "verified", evidence },
      ])
  );

let destinations = 0;
/** A new destination serving `eu-storage`, with every requirement verified unless said. */
const destination = async (
  input: Partial<DestinationInput> = {}
): Promise<string> => {
  destinations += 1;
  const id = `eu-${crypto.randomUUID().slice(0, 8)}-${destinations}`;
  await saveDestination(db, staff, {
    id,
    kind: "workers_for_platforms",
    accountId: crypto.randomUUID().replaceAll("-", ""),
    namespace: "production",
    policies: ["eu-storage"],
    capabilities: verified(),
    ...input,
  });
  return id;
};

/** A new client record, as provisioning makes one. */
const client = async (): Promise<string> => {
  const id = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(clients).values({
    id,
    name: id,
    accountId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

/** A release whose core binds as the real one does, with `classes` migrations. */
const release = async (
  durableObjectMigrations: ReleaseManifest["workers"][string]["durableObjectMigrations"] = [
    { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
  ]
): Promise<ReleaseManifest> => {
  const { manifest } = await buildRelease({ notes: "feat(core): test" });
  const { core } = manifest.workers;
  if (core === undefined) {
    throw new Error("The test release has no core");
  }
  return {
    ...manifest,
    workers: {
      ...manifest.workers,
      core: {
        ...core,
        durableObjectMigrations,
        bindings: [
          ...core.bindings.filter((binding) => binding.type !== "workflow"),
          { type: "worker_loader", name: "LOADER" },
          { type: "ai", name: "AI" },
          { type: "send_email", name: "EMAIL" },
        ],
      },
    },
  };
};

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

const placedClient = async (destinationId: string) => {
  const clientId = await client();
  const placement = await placeClient(db, staff, {
    clientId,
    destinationId,
    policyId: "eu-storage",
  });
  return { clientId, placement };
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
    expect(inventoryA.map(({ role }) => role)).toStrictEqual([
      "d1:grasp-os-connect",
      "d1:grasp-os-core",
      "d1:grasp-os-knowledge",
      "do:grasp-os-core:AuditLog",
      "do:grasp-os-core:Workspace",
      "r2:grasp-os-audit-archive",
      "r2:grasp-os-files",
      "worker:grasp-os-connect",
      "worker:grasp-os-core",
    ]);
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
    await saveDestination(db, staff, {
      id: destinationId,
      kind: "workers_for_platforms",
      accountId: null,
      namespace: "production",
      policies: ["eu-storage"],
      capabilities: verified({ "r2.eu_jurisdiction": "unsupported" }),
    });
    await expect(
      allocateClientResources(db, staff, {
        clientId,
        manifest: await release(),
        operationId: "op",
      })
    ).rejects.toMatchObject({ code: "placement_refused" });
    await expect(clientInventory(db, clientId)).resolves.toStrictEqual([]);
  });

  it("are refused for a bucket outside the policy's jurisdiction or a class moved by a rename", async () => {
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
  const setUp = async () => {
    const destinationId = await destination();
    const manifest = await release();
    const a = await placedClient(destinationId);
    const b = await placedClient(destinationId);
    const allocate = async (clientId: string) =>
      await observeDatabases(
        await allocateClientResources(db, staff, {
          clientId,
          manifest,
          operationId: "op",
        })
      );
    const { core } = manifest.workers;
    if (core === undefined) {
      throw new Error("The test release has no core");
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
