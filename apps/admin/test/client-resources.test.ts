import { gatewayScriptOf } from "@grasp-os/shared/connect-gateway";
import { clientsNamespace, platformWorkerName } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import golden from "../../../scripts/release/testdata/golden-manifest.json" with { type: "json" };
import {
  allocateClientResources,
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
} from "../src/hosting/inventory.ts";
import {
  client,
  db,
  destination,
  placedClient,
  release,
  staff,
} from "./hosting.ts";

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
    },
    stage
  ).then(
    () => "saved",
    (error: unknown) => (error instanceof InventoryError ? error.code : error)
  );

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

  it("are refused for a bucket binding naming no bucket, one the naming scheme doesn't name, or a class moved by a rename", async () => {
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
        { type: "r2_bucket", name: "BACKUPS", jurisdiction: "eu" },
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
