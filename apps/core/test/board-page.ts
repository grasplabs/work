import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { builtins, fingerprintOf, thisRelease } from "../src/builtins.ts";
import { grantReviewed, release as releaseFiles } from "./apps.ts";
import type { Idp } from "./idp.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The board page's tests' helpers, shared by its test files
// (board-page*.test.ts): an admin's board page and workflow map, the
// map's workflows, runs and signals seeded, and the page's functions
// called as its screens call them.

type Person = Awaited<ReturnType<typeof signedInApi>>;

export const dayMs = 24 * 60 * 60 * 1000;

/** What `person` gets calling `app`'s `path` (a `kind`) with `input`. */
export const call = async (
  person: Person,
  app: AppId,
  path: string,
  kind: "query" | "mutation" | "action",
  input: unknown = {}
): Promise<OperationResult> =>
  await calledAs(
    await person.api.whoami(),
    app,
    { contractId: path, kind },
    input
  );

/** What a call answered; a refusal fails the test, saying why. */
export const valueOf = (result: OperationResult): unknown => {
  if (!result.ok) {
    throw new Error(
      `Refused: ${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? null)}`
    );
  }
  return result.value;
};

/** Why a call was refused, or `ok`. */
export const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

export const estimated = (value: number) => ({
  value,
  basis: "estimated" as const,
});
const observed = (value: number) => ({ value, basis: "observed" as const });

export const idSchema = z.string().min(1);

export const snapshotSchema = z.looseObject({
  _rev: z.number(),
  take: z.string(),
  title: z.string(),
  date: z.string(),
  maturity: z.number(),
  figures: z.number(),
  signals: z.array(z.looseObject({ workflow: z.string(), kind: z.string() })),
  decisionNeeded: z.string(),
  narrative: z.string(),
});

const figureSchema = z.object({
  workflow: z.string(),
  title: z.string(),
  team: z.string().nullable(),
  state: z.string(),
  drawn: z.unknown(),
  designed: z.unknown(),
  unavailable: z.boolean(),
  running: z.unknown(),
});

/** An App created from the built-in `blueprint` by `admin`. */
const fromBuiltin = async (admin: Person, blueprint: string) => {
  await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
  const made = await admin.api.apps.blueprints.create(blueprint, {
    name: `Ours ${unique()}`,
  });
  await admin.api.apps.versions.setCurrent(made.app.id, 1);
  await admin.api.apps.publish(made.app.id);
  return { app: appIdSchema.parse(made.app.id), permissions: made.permissions };
};

/**
 * The helpers that sign people in at `idp`, which each test file mocks
 * itself: a module-level `mockIdp()` here would register its hooks once per
 * worker, not once per file (`isolate: false`).
 */
export const boardPageOf = (idp: Idp) => ({
  /**
   * An admin's board page and workflow map: the page's `map` bound to the
   * map unless `bindMap` is false, and its `statistics` to the statistics
   * permission it asks for, granted, unless `bindStatistics` is false.
   */
  setUp: async ({
    bindMap = true,
    bindStatistics = true,
  }: { bindMap?: boolean; bindStatistics?: boolean } = {}) => {
    const admin = await signedInApi(idp, "admin");
    const board = await fromBuiltin(admin, "board-page");
    const { app: map } = await fromBuiltin(admin, "workflow-map");
    if (bindMap) {
      await admin.api.resourceBindings.approve({
        app: board.app,
        alias: "map",
        target: { kind: "app", appId: map },
        reviewed: { version: 1 },
      });
    }
    const [permission] = board.permissions;
    if (bindStatistics && permission !== undefined) {
      await grantReviewed(admin.api, permission.id);
      await admin.api.resourceBindings.approve({
        app: board.app,
        alias: "statistics",
        target: { kind: "statistics", permissionId: permission.id },
        reviewed: { version: 1 },
      });
    }
    return { admin, app: board.app, map };
  },
});

const workflowFile = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "pay",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`;

const workflowTestsFile = `import { workflowTests } from "@grasp-os/sdk/testing";

import pay from "./pay.ts";

export default workflowTests(pay, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`;

/** An App whose running version has the workflow `pay`, released by `admin`. */
const payablesApp = async (admin: Person): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Payables ${unique()}` });
  await releaseFiles(admin, id, {
    "workflows/pay.ts": workflowFile,
    "workflows/pay.workflow-tests.ts": workflowTestsFile,
  });
  return appIdSchema.parse(id);
};

/** `count` runs of `app`'s workflow `pay`, started `ago` milliseconds back. */
export const seedRuns = async (
  app: AppId,
  count: number,
  ago: number
): Promise<void> => {
  const at = Date.now() - ago;
  await env.DB.batch(
    Array.from({ length: count }, () =>
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'pay', 1, NULL, 'completed', ?, ?)"
      ).bind(`run-${unique()}-${unique()}`, app, at, at)
    )
  );
};

/**
 * Each seeded computation starts after the one before, so the latest wins,
 * and all within the last hour: a read counts none started after its now.
 */
let computations = 0;

/**
 * A finished computation of improvement signals, the latest, with
 * `signals` as `[app, workflow, kind, subject, value]`.
 */
export const seedSignals = async (
  signals: [string, string, string, string, number][]
): Promise<void> => {
  computations += 1;
  const id = `computation-${unique()}`;
  const startedAt = Date.now() - 60 * 60_000 + computations * 1000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
    ).bind(
      id,
      new Date(startedAt).toISOString().slice(0, 10),
      startedAt,
      startedAt
    ),
    ...signals.map(([app, workflow, kind, subject, value]) =>
      env.DB.prepare(
        "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, ?, ?, ?, ?, '{}')"
      ).bind(id, app, workflow, kind, subject, value)
    ),
  ]);
};

/** Saves a workflow in the map, as its screen does, answering its ID. */
export const saveWorkflow = async (
  admin: Person,
  map: AppId,
  fields: Record<string, unknown>,
  from: { id: string; revision: number } | null = null
): Promise<string> =>
  z.object({ id: idSchema }).parse(
    valueOf(
      await call(admin, map, "map.save", "mutation", {
        id: from?.id ?? null,
        expectedRevision: from?.revision ?? null,
        team: null,
        parameters: [],
        gain: null,
        notes: "",
        ...fields,
      })
    )
  ).id;

/** A map workflow's revision now. */
export const revisionOf = async (
  admin: Person,
  map: AppId,
  id: string
): Promise<number> =>
  z
    .object({ current: z.looseObject({ _rev: z.number() }) })
    .parse(valueOf(await call(admin, map, "map.open", "query", { id }))).current
    ._rev;

/**
 * A team, a drawn workflow and a designed one linked to `pay` of a new
 * App, saved through the map.
 */
export const seedMap = async (admin: Person, map: AppId) => {
  const team = idSchema.parse(
    valueOf(
      await call(admin, map, "teams.add", "mutation", {
        title: `Finance ${unique()}`,
      })
    )
  );
  const book = await saveWorkflow(admin, map, {
    title: "Book receipts",
    state: "drawn",
    team,
    steps: [
      {
        name: "Book it",
        numbers: {
          frequency: estimated(40),
          minutes: observed(6),
          people: estimated(1),
        },
      },
    ],
  });
  // Drawn at 10 hours a week, then designed, then linked to `pay`.
  const pay = await saveWorkflow(admin, map, {
    title: "Pay invoices",
    state: "drawn",
    steps: [
      {
        name: "Match",
        numbers: {
          frequency: estimated(30),
          minutes: estimated(10),
          people: estimated(2),
        },
      },
    ],
  });
  await saveWorkflow(
    admin,
    map,
    {
      title: "Pay invoices",
      state: "designed",
      steps: [
        {
          name: "Match",
          kind: "automated",
          numbers: { frequency: observed(30), minutes: observed(0) },
        },
        {
          name: "Approve",
          numbers: { frequency: estimated(30), minutes: estimated(5) },
        },
      ],
    },
    { id: pay, revision: await revisionOf(admin, map, pay) }
  );
  const payables = await payablesApp(admin);
  valueOf(
    await call(admin, map, "map.link", "mutation", {
      id: pay,
      expectedRevision: await revisionOf(admin, map, pay),
      app: { appId: payables, workflowId: "pay" },
    })
  );
  return { team, book, pay, payables };
};

/** A snapshot's maturity, unless a test says another. */
const defaultTake = { maturity: 1 };

/** An ID as long as an App's or a workflow's may be. */
export const longId = (prefix: string): string => prefix.padEnd(256, "x");

/** Takes a snapshot as `person`. */
export const take = async (
  person: Person,
  app: AppId,
  input: Record<string, unknown> = defaultTake
): Promise<OperationResult> =>
  await call(person, app, "snapshots.take", "action", input);

/** A snapshot and its figures, by workflow. */
export const opened = async (person: Person, app: AppId, id: string) => {
  const snapshot = snapshotSchema.parse(
    valueOf(await call(person, app, "snapshots.get", "query", { id }))
  );
  const page = z
    .object({ items: z.array(z.looseObject(figureSchema.shape)) })
    .parse(
      valueOf(
        await call(person, app, "snapshots.figures", "query", {
          take: snapshot.take,
          pagination: { pageSize: 100 },
        })
      )
    );
  const figures = new Map(
    page.items.map((item) => {
      const figure = figureSchema.parse(item);
      return [figure.workflow, figure];
    })
  );
  return { snapshot, figures };
};

/** The snapshots listed, newest first, by ID. */
export const listed = async (person: Person, app: AppId): Promise<string[]> =>
  z
    .object({ items: z.array(z.looseObject({ id: z.string() })) })
    .parse(
      valueOf(
        await call(person, app, "snapshots.list", "query", { pagination: {} })
      )
    )
    .items.map(({ id }) => id);
