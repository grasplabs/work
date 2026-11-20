import type { ListedConnection } from "@grasp-os/shared/connect";
import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { WorkflowStage } from "@grasp-os/shared/workflow-lifecycle";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import type { CoreConnection } from "../core-connection.ts";
import { phaseOf, readOverview, readTools } from "./overview.ts";

// What the Workflows page reads, against core's API as the page reaches it
// over RPC, faked: each workflow stands in the phase its stage, its runs
// and its go-live say, what needs the reader first; and the tools a
// workflow reaches are the apps its connections belong to.

/** A workflow that ran this week and needs nobody, changed by `change`. */
const workflow = (
  name: string,
  change: Partial<WorkflowSummary> = {}
): WorkflowSummary => ({
  workflowId: workflowResourceIdSchema.parse(`id-${name}`),
  name,
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
  stages: Readonly<Record<string, WorkflowStage>>;
  paused?: readonly string[];
  goLives?: { workflowId: string; name: string }[];
  resources?: () => Promise<{ id: string; process: string | null }[]>;
  lifecycleFails?: boolean;
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
        lifecycle: {
          waiting: async () => await Promise.resolve(core.goLives ?? []),
          get: async (id: string) => {
            await Promise.resolve();
            if (core.lifecycleFails === true) {
              throw roleErrors.create("role.forbidden");
            }
            return {
              stage: core.stages[id],
              paused:
                core.paused?.includes(id) === true
                  ? { by: "owner", at: "2026-10-08T09:00:00.000Z" }
                  : null,
            };
          },
        },
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
  const quiet = { waitsToGoLive: false, waiting: 0, failed: 0 };

  it("follows the stage: to build while only named, building until a version went live, then running", () => {
    expect(
      (["mapped", "designed", "testing", "live", "scaling"] as const).map(
        (stage) => phaseOf({ stage, ...quiet })
      )
    ).toStrictEqual(["toBuild", "building", "building", "running", "running"]);
  });

  it("needs the reader while runs wait or failed, or a version waits for them to go live, whatever its stage", () => {
    expect([
      phaseOf({ stage: "live", ...quiet, waiting: 1 }),
      phaseOf({ stage: "scaling", ...quiet, failed: 2 }),
      phaseOf({ stage: "testing", ...quiet, waitsToGoLive: true }),
    ]).toStrictEqual(["needsYou", "needsYou", "needsYou"]);
  });
});

describe("the Workflows page's rows", () => {
  it("stand by phase, what needs the reader first, each phase as core listed it", async () => {
    const rows = await phasesOf({
      overview: async () =>
        await Promise.resolve([
          workflow("Archive"),
          workflow("Billing", { lastRun: null }),
          workflow("Complaints", { waiting: 1 }),
          workflow("Drafted", { lastRun: null }),
          workflow("Expenses"),
        ]),
      stages: {
        "id-Archive": "live",
        "id-Billing": "mapped",
        "id-Complaints": "live",
        "id-Drafted": "designed",
        "id-Expenses": "scaling",
      },
    });

    expect(rows).toStrictEqual([
      "Complaints: needsYou",
      "Archive: running",
      "Expenses: running",
      "Drafted: building",
      "Billing: toBuild",
    ]);
  });

  it("keeps a workflow that runs without a version gone live under building", async () => {
    const rows = await phasesOf({
      overview: async () => await Promise.resolve([workflow("Intake")]),
      stages: { "id-Intake": "testing" },
    });

    expect(rows).toStrictEqual(["Intake: building"]);
  });

  it("lists a version waiting for the reader to go live under what needs them, also of a workflow core doesn't list for them", async () => {
    const rows = await phasesOf({
      overview: async () => await Promise.resolve([workflow("Intake")]),
      stages: { "id-Intake": "testing" },
      goLives: [
        { workflowId: "id-Intake", name: "Intake" },
        { workflowId: "id-Payroll", name: "Payroll" },
      ],
    });

    expect(rows).toStrictEqual(["Intake: needsYou", "Payroll: needsYou"]);
  });

  it("carries what core says of each: its owner, its process, whether it is paused, and its runs this week once it ran", async () => {
    const read = await overviewOf({
      overview: async () =>
        await Promise.resolve([
          workflow("Intake"),
          workflow("Planned", {
            lastRun: null,
            handled: 0,
            owner: { userId: "owner", name: null },
          }),
        ]),
      stages: { "id-Intake": "live", "id-Planned": "mapped" },
      paused: ["id-Intake"],
      resources: async () =>
        await Promise.resolve([{ id: "id-Intake", process: "o2c" }]),
    });

    expect(read.state === "ready" ? read.data : read.state).toStrictEqual([
      {
        id: "id-Intake",
        name: "Intake",
        phase: "running",
        paused: true,
        process: "o2c",
        owner: "Ada Lovelace",
        runs: 12,
      },
      {
        id: "id-Planned",
        name: "Planned",
        phase: "toBuild",
        paused: false,
        process: null,
        owner: null,
        runs: null,
      },
    ]);
  });

  it("are none for a role core lists no workflows", async () => {
    const rows = await phasesOf({
      overview: async () => {
        await Promise.resolve();
        throw roleErrors.create("role.forbidden");
      },
      stages: {},
    });

    expect(rows).toStrictEqual([]);
  });

  it("still show when the process each serves can't be read", async () => {
    const rows = await phasesOf({
      overview: async () => await Promise.resolve([workflow("Intake")]),
      stages: { "id-Intake": "live" },
      resources: async () => {
        await Promise.resolve();
        throw new Error("The workflows' records can't be read.");
      },
    });

    expect(rows).toStrictEqual(["Intake: running"]);
  });

  it("aren't shown in a phase core didn't say: a stage that can't be read fails the read", async () => {
    const rows = await phasesOf({
      overview: async () => await Promise.resolve([workflow("Intake")]),
      stages: {},
      lifecycleFails: true,
    });

    expect(rows).toStrictEqual(["refused"]);
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
