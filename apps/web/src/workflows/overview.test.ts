import type { ListedConnection } from "@grasp-os/shared/connect";
import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import type { CoreConnection } from "../core-connection.ts";
import { phaseOf, readOverview, readTools } from "./overview.ts";

// What the Workflows page reads, against core's API as the page reaches it
// over RPC, faked: each workflow stands in the phase its live version and
// its runs say, what needs the reader first; and the tools a workflow
// reaches are the apps its connections belong to.

/** A workflow that runs, ran this week and needs nobody, changed by `change`. */
const workflow = (
  name: string,
  change: Partial<WorkflowSummary> = {}
): WorkflowSummary => ({
  workflowId: workflowResourceIdSchema.parse(`id-${name}`),
  name,
  title: null,
  version: 1,
  owner: { userId: "owner", name: "Ada Lovelace" },
  lastRun: {
    id: runIdSchema.parse(`run-${name}`),
    status: "completed",
    createdAt: "2026-10-08T09:00:00.000Z",
  },
  waiting: 0,
  failed: 0,
  handled: 12,
  ...change,
});

/** Core's API, as far as the page reads it. */
interface Core {
  overview: () => Promise<WorkflowSummary[]>;
  resources?: () => Promise<
    { id: string; process: string | null; paused: boolean }[]
  >;
}

/** The tab's connection to a core that answers as `core` says. */
const connectionTo = (
  session: object
): Pick<CoreConnection, "withSession"> => ({
  withSession: async (read) =>
    // SAFETY: a stand-in for the parts of core's API the page reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    await read(session as never),
});

const overviewOf = async (core: Core) =>
  await readOverview(
    connectionTo({
      workflows: { overview: core.overview },
      workflowResources: {
        list: core.resources ?? (async () => await Promise.resolve([])),
      },
    })
  );

/** The rows read, as `name: phase`, in the page's order. */
const phasesOf = async (core: Core): Promise<string[]> => {
  const read = await overviewOf(core);
  return read.state === "ready"
    ? read.data.map((row) => `${row.name}: ${row.phase}`)
    : [read.state];
};

describe(phaseOf, () => {
  const quiet = { waiting: 0, failed: 0 };

  it("is building until a version is live, then running", () => {
    expect([
      phaseOf({ live: false, ...quiet }),
      phaseOf({ live: true, ...quiet }),
    ]).toStrictEqual(["building", "running"]);
  });

  it("needs the reader while runs wait or failed, live or not", () => {
    expect([
      phaseOf({ live: true, ...quiet, waiting: 1 }),
      phaseOf({ live: false, ...quiet, failed: 2 }),
    ]).toStrictEqual(["needsYou", "needsYou"]);
  });
});

describe("the Workflows page's rows", () => {
  it("stand by phase, what needs the reader first, each phase as core listed it", async () => {
    const rows = await phasesOf({
      overview: async () =>
        await Promise.resolve([
          workflow("Archive"),
          workflow("Billing", { lastRun: null, version: null }),
          workflow("Complaints", { waiting: 1 }),
          workflow("Expenses"),
        ]),
    });

    expect(rows).toStrictEqual([
      "Complaints: needsYou",
      "Archive: running",
      "Expenses: running",
      "Billing: building",
    ]);
  });

  it("carries what core says of each: the name people see, its owner, its process, whether it is paused, and its runs this week once it ran", async () => {
    const read = await overviewOf({
      overview: async () =>
        await Promise.resolve([
          workflow("intake", { title: "Intake" }),
          workflow("Planned", {
            lastRun: null,
            handled: 0,
            version: null,
            owner: { userId: "owner", name: null },
          }),
        ]),
      resources: async () =>
        await Promise.resolve([
          { id: "id-intake", process: "o2c", paused: true },
        ]),
    });

    expect(read.state === "ready" ? read.data : read.state).toStrictEqual([
      {
        id: "id-intake",
        name: "Intake",
        phase: "running",
        paused: true,
        process: "o2c",
        owner: "Ada Lovelace",
        runs: 12,
        version: 1,
        waiting: 0,
        failed: 0,
        lastRun: "2026-10-08T09:00:00.000Z",
      },
      {
        id: "id-Planned",
        name: "Planned",
        phase: "building",
        paused: false,
        process: null,
        owner: null,
        runs: null,
        version: null,
        waiting: 0,
        failed: 0,
        lastRun: null,
      },
    ]);
  });

  it("are none for a role core lists no workflows", async () => {
    const rows = await phasesOf({
      overview: async () => {
        await Promise.resolve();
        throw roleErrors.create("role.forbidden");
      },
    });

    expect(rows).toStrictEqual([]);
  });

  it("still show when the workflows' records can't be read", async () => {
    const rows = await phasesOf({
      overview: async () => await Promise.resolve([workflow("Intake")]),
      resources: async () => {
        await Promise.resolve();
        throw new Error("The workflows' records can't be read.");
      },
    });

    expect(rows).toStrictEqual(["Intake: running"]);
  });
});

const connection = (
  id: string,
  change: Partial<ListedConnection>
): ListedConnection => ({
  id,
  source: "native",
  provider: "microsoft",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "me",
  connectedByName: "Me",
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...change,
});

/** A catalog entry, as core lists an app. */
const entry = (source: string, id: string, name: string) => ({
  source,
  id,
  name,
  categories: [],
  toolCount: 1,
  logo: null,
  description: null,
  group: "Other",
  auth: "managed",
  offered: true,
});

/** The tools read, as each workflow's names, with `mark` after one the library has a mark for. */
const toolsOf = async (session: object): Promise<Record<string, string[]>> => {
  const tools = await readTools(connectionTo(session));
  return Object.fromEntries(
    [...tools].map(([id, list]) => [
      id,
      list.map(({ name, brand }) =>
        brand === undefined ? name : `${name} (mark)`
      ),
    ])
  );
};

describe("the tools a workflow reaches", () => {
  const uses = [
    {
      connectionId: "c-microsoft",
      workflows: [
        { id: "wf-1", name: "Intake" },
        { id: "wf-2", name: "Billing" },
      ],
    },
    {
      connectionId: "c-microsoft-mine",
      workflows: [{ id: "wf-1", name: "Intake" }],
    },
    { connectionId: "c-crm", workflows: [{ id: "wf-1", name: "Intake" }] },
    { connectionId: "c-http", workflows: [{ id: "wf-2", name: "Billing" }] },
  ];
  const connections = [
    connection("c-microsoft", {}),
    connection("c-microsoft-mine", { scope: "personal", ownerUserId: "me" }),
    connection("c-crm", { source: "composio", provider: "acme_crm" }),
    connection("c-http", {
      source: "http",
      provider: "http",
      http: {
        name: "Ledger",
        origin: "https://ledger.example",
        pathPrefixes: ["/"],
        methods: ["GET"],
        credentialHeader: "authorization",
      },
    }),
  ];

  it("are the apps its connections belong to, each once by the catalog's name, and its HTTP connections by theirs", async () => {
    const tools = await toolsOf({
      workflows: { byConnection: async () => await Promise.resolve(uses) },
      connections: {
        list: async () => await Promise.resolve(connections),
        catalog: async () =>
          await Promise.resolve({
            entries: [
              entry("native", "microsoft", "Microsoft 365"),
              entry("composio", "acme_crm", "Acme CRM"),
            ],
          }),
      },
    });

    expect(tools).toStrictEqual({
      "wf-1": ["Microsoft 365 (mark)", "Acme CRM"],
      "wf-2": ["Microsoft 365 (mark)", "Ledger"],
    });
  });

  it("are left out, never failing the page, when core can't say which connections it uses", async () => {
    const tools = await toolsOf({
      workflows: {
        byConnection: async () => {
          await Promise.resolve();
          throw new Error("Not now.");
        },
      },
      connections: {
        list: async () => await Promise.resolve(connections),
        catalog: async () => await Promise.resolve({ entries: [] }),
      },
    });

    expect(tools).toStrictEqual({});
  });
});
