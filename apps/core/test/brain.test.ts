import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { Workspace } from "@grasp-os/shared/brain";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import { fakeGateway } from "./ai-gateway.ts";
import {
  grantReviewed,
  ordinaryData,
  revokeOtherCopies,
  serverBuilt,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  openRpc,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// The company brain's workspace (`brain.read`, brain-rpc.ts), assembled
// from what core holds: the onboarding (the kickoff, who works where),
// the Playbook's records (the Intake's sources and statements, the
// workflow map's teams and workflows) and the connections. Each is put
// in here as the product puts it in: staff bring in the kickoff, the admin
// gives the roster, the Intake and the map save to the Playbook. AI
// Gateway is the outside system, a fake behind the AI binding. What can go
// wrong, tried here: a tag or a source mapped to the wrong statement, kind
// or id; a team counted twice when two sources name it; the onboarding,
// which only admins see, reaching anyone else; a record reaching someone
// who can't read the Playbook; an empty deployment failing to give the
// brain anything to build from.

const idp = mockIdp();

/** The one model the tests' gateway allows (vite.config.ts). */
const testModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const playbook = "playbook";

type Api = Awaited<ReturnType<typeof signedInApi>>;

const okOf = <T>(answer: unknown, schema: z.ZodType<T>): T =>
  z.object({ ok: schema }).parse(answer).ok;

const call = async (
  app: AppId,
  userId: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> =>
  await callApp(env, app, { userId, mode: "interactive" }, method, args);

const today = (): string => new Date().toISOString().slice(0, 10);

/** Grasp's first conversation with the company. */
const kickoffTranscript = `Anna (CEO): We are an accounting firm in Utrecht with two teams.
Jakob (Grasp): Where do you want to be in two years?
Anna (CEO): We want every client to get their numbers within a week, and AI should help us get there.
Anna (CEO): Our Finance team has 8 people and spends days copying invoices by hand.
Anna (CEO): Our Legal team of 3 handles the contracts.`;

/** What the model reads in it. */
const kickoffReading = {
  fields: [
    {
      field: "business",
      text: "An accounting firm in Utrecht.",
      quote: "We are an accounting firm in Utrecht",
      ask: "",
    },
    {
      field: "goals",
      text: "Every client gets their numbers within a week.",
      quote: "We want every client to get their numbers within a week",
      ask: "",
    },
    {
      field: "pain",
      text: "Copying invoices by hand.",
      quote: "spends days copying invoices by hand",
      ask: "",
    },
  ],
  teams: [
    { name: "Finance", does: "Bookkeeping", people: 8 },
    { name: "Legal", does: "Contracts", people: 3 },
  ],
};

/** Staff bring the kickoff in, read by the fake gateway. */
const bringInKickoff = async (): Promise<void> => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  const staff = await core.authenticate();
  const fake = fakeGateway({
    text: JSON.stringify(kickoffReading),
    inputTokens: 900,
    outputTokens: 300,
  });
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    await staff.onboardingStaff.saveKickoff({
      locale: "en",
      transcript: { text: kickoffTranscript },
    });
  } finally {
    spy.mockRestore();
  }
};

const roster: RosterInput = {
  teams: [
    { id: "finance", name: "Finance", lead: "ann" },
    { id: "ops", name: "Operations", lead: null, off: true },
  ],
  people: [
    { id: "ann", name: "Ann", team: "finance", title: "Head of finance" },
    { id: "ben", name: "Ben", team: "finance", title: "Accountant" },
    { id: "cas", name: "Cas", team: "finance", title: "Accountant" },
    { id: "dee", name: "Dee", team: "ops" },
  ],
};

/** An App created from `blueprint` by the admin, its permissions granted. */
const copyOf = async (admin: Api, blueprint: string): Promise<AppId> => {
  const created = await admin.api.apps.blueprints.create(blueprint, {
    name: `${blueprint} ${unique()}`,
  });
  await revokeOtherCopies(admin.api, blueprint, created.app.id);
  for (const { id } of created.permissions) {
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await grantReviewed(admin.api, id);
  }
  await admin.api.apps.versions.setCurrent(created.app.id, 1);
  if (blueprint === "intake") {
    await admin.api.resourceBindings.approve({
      app: created.app.id,
      alias: "extractor",
      target: { kind: "model", model: testModel },
      reviewed: { version: 1 },
    });
  }
  await ordinaryData(created.app.id);
  await serverBuilt(created.app.id, 1);
  return appIdSchema.parse(created.app.id);
};

/** An interview saved through the Intake: a source and three statements. */
const saveInterview = async (admin: Api): Promise<void> => {
  const intake = await copyOf(admin, "intake");
  const draft = {
    source: {
      title: "Month-end close",
      medium: "interview",
      date: "2026-09-21",
      from: "Anna, controller",
      notes: "Talked about month-end close.",
    },
    statements: [
      {
        text: "Closing the month takes three days.",
        tags: ["time_sink", "handover"],
        quote: "",
      },
      {
        text: "Invoices over 5,000 need a second signature.",
        tags: ["rule", "blocker"],
        quote: "",
      },
      { text: "Close the month in one day.", tags: ["goal"], quote: "" },
    ],
  };
  const created = okOf(
    await call(intake, admin.userId, "create", draft),
    z.object({ id: z.string(), version: z.number() })
  );
  okOf(
    await call(intake, admin.userId, "save", {
      id: created.id,
      ifVersion: created.version,
      draft,
    }),
    z.object({ source: z.string() })
  );
};

const teamSchema = z.object({ path: z.string(), title: z.string() });
const savedSchema = z.object({ id: z.string(), path: z.string() });

/**
 * Teams and a workflow saved through the workflow map: Finance, which
 * the roster has too, and Support, which only the Playbook has; a
 * workflow of Finance's drawn, then designed.
 */
const drawWorkflow = async (admin: Api): Promise<void> => {
  const map = await copyOf(admin, "workflow-map");
  const finance = okOf(
    await call(map, admin.userId, "addTeam", "Finance"),
    teamSchema
  );
  okOf(await call(map, admin.userId, "addTeam", "Support"), teamSchema);
  const drawn = {
    type: "workflow",
    title: "Pay supplier invoices",
    state: "drawn",
    team: finance.path,
    steps: [{ name: "Match the invoice", tool: "Exact Online" }],
  };
  const saved = okOf(
    await call(map, admin.userId, "save", {
      ifVersion: 0,
      record: drawn,
      body: "",
    }),
    savedSchema
  );
  okOf(
    await call(map, admin.userId, "save", {
      documentId: saved.id,
      path: saved.path,
      ifVersion: 1,
      record: {
        ...drawn,
        state: "designed",
        steps: [{ name: "Match the invoice", tool: "Grasp" }],
      },
      body: "",
    }),
    savedSchema
  );
};

/** The Playbook's documents' ids by path, as the admin lists them. */
const playbookIds = async (admin: Api): Promise<Map<string, string>> => {
  const { documents } = await admin.api.knowledge.listDocuments(playbook);
  return new Map(documents.map(({ path, id }) => [path, id]));
};

/** The id of the one document whose path starts with `prefix` (and ends with `suffix`). */
const idAt = (
  ids: Map<string, string>,
  prefix: string,
  suffix = ""
): string => {
  const found = [...ids].filter(
    ([path]) => path.startsWith(prefix) && path.endsWith(suffix)
  );
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`Expected one document at ${prefix}`);
  }
  return found[0][1];
};

/** The parts of a workspace that come from the Playbook. */
const fromPlaybook = (workspace: Workspace) => ({
  sources: workspace.sources.filter(
    ({ id }) => id !== "src-kickoff" && id !== "src-roster"
  ),
  statements: workspace.statements,
  workflows: workspace.workflows,
  teams: workspace.teams.filter(({ id }) => id.startsWith("team.playbook-")),
});

describe("the brain's workspace", { timeout: 120_000 }, () => {
  it("is a valid empty workspace while the deployment holds nothing for it", async () => {
    const admin = await signedInApi(idp, "admin");
    const workspace = await admin.api.brain.read();
    expect({
      ...workspace,
      connections: workspace.connections.every(
        ({ status }) => status === "available"
      ),
    }).toStrictEqual({
      company: { name: "Organization", sector: "", people: 0 },
      vision: {
        ambition: "",
        whyNow: "",
        inviteTeamIds: [],
        budget: [],
        toolApproval: [],
        sourceId: "",
        version: 0,
      },
      goals: [],
      teams: [],
      tools: [],
      sources: [],
      statements: [],
      candidates: [],
      gaps: [],
      workflows: [],
      connections: true,
      landscape: [],
      policies: [],
    });
  });

  it("maps the kickoff, the roster, the Playbook's records and the connections, and shows the onboarding to admins alone", async () => {
    await builtins(env).ensureInstalled(await fingerprintOf(release));
    const admin = await signedInApi(idp, "admin");
    await bringInKickoff();
    await admin.api.onboarding.saveRoster(roster);
    await saveInterview(admin);
    await drawWorkflow(admin);
    await mailConnection();

    const ids = await playbookIds(admin);
    const source = `src-${idAt(ids, "sources/2026-09-21-month-end-close-")}`;
    const statement = (position: number) =>
      `st-${idAt(ids, "statements/2026-09-21-month-end-close-", `-${position}.md`)}`;
    const support = idAt(ids, "teams/support");
    const finance = idAt(ids, "teams/finance");
    const workflow = idAt(ids, "workflows/pay-supplier-invoices");

    const workspace = await admin.api.brain.read();
    const member = await signedInApi(idp, "user");
    const asMember = await member.api.brain.read();

    expect({
      company: workspace.company,
      vision: workspace.vision,
      teams: workspace.teams,
      sources: workspace.sources,
      statements: workspace.statements,
      workflows: workspace.workflows,
      mail: workspace.connections.filter(({ name }) => name === "mail"),
      others: workspace.connections
        .filter(({ name }) => name !== "mail")
        .every(({ status }) => status === "available"),
    }).toStrictEqual({
      company: {
        name: "Organization",
        sector: "An accounting firm in Utrecht.",
        people: 4,
      },
      vision: {
        ambition: "Every client gets their numbers within a week.",
        whyNow: "Copying invoices by hand.",
        inviteTeamIds: ["team-finance"],
        budget: [],
        toolApproval: [],
        sourceId: "src-kickoff",
        version: 1,
      },
      teams: [
        {
          id: "team-finance",
          name: "Finance",
          sourceId: "src-kickoff",
          counts: [
            { sourceId: "src-kickoff", date: today(), people: 8 },
            {
              sourceId: "src-roster",
              date: today(),
              people: 3,
              roles: [
                { name: "Head of finance", people: 1 },
                { name: "Accountant", people: 2 },
              ],
            },
          ],
          stakeholders: [
            { role: "Head of finance", sourceId: "src-roster", date: today() },
          ],
        },
        {
          id: "team-ops",
          name: "Operations",
          sourceId: "src-roster",
          counts: [
            { sourceId: "src-roster", date: today(), people: 1, roles: [] },
          ],
          stakeholders: [],
        },
        {
          id: "team.kickoff-1",
          name: "Legal",
          sourceId: "src-kickoff",
          counts: [{ sourceId: "src-kickoff", date: today(), people: 3 }],
          stakeholders: [],
        },
        {
          id: `team.playbook-${support}`,
          name: "Support",
          sourceId: "",
          counts: [],
          stakeholders: [],
        },
      ],
      sources: [
        {
          id: "src-kickoff",
          kind: "interview",
          title: "Kickoff",
          date: today(),
          step: 1,
        },
        {
          id: "src-roster",
          kind: "import",
          connection: "directory",
          title: "Staff list",
          date: today(),
          step: 2,
        },
        {
          id: source,
          kind: "interview",
          title: "Month-end close",
          date: "2026-09-21",
          who: "Anna, controller",
          step: 2,
        },
      ],
      statements: [
        {
          id: statement(1),
          kind: "timeSink",
          text: "Closing the month takes three days.",
          sourceId: source,
          teamIds: [],
          toolIds: [],
        },
        {
          id: statement(2),
          // The Intake keeps its tags as goal, blocker, …, rule.
          kind: "blocker",
          text: "Invoices over 5,000 need a second signature.",
          sourceId: source,
          teamIds: [],
          toolIds: [],
        },
        {
          id: statement(3),
          kind: "goal",
          text: "Close the month in one day.",
          sourceId: source,
          teamIds: [],
          toolIds: [],
        },
      ],
      workflows: [
        {
          id: `wf-${workflow}`,
          name: "Pay supplier invoices",
          teamId: "team-finance",
          status: "designed",
          baseline: { steps: [{ tool: "Exact Online" }] },
          target: { steps: [{ tool: "Grasp" }] },
        },
      ],
      mail: [
        {
          name: "mail",
          status: "connected",
          via: "composio",
          matches: ["mail"],
        },
      ],
      others: true,
    });

    // Someone who isn't an admin gets the Playbook and the connections,
    // never the onboarding: no kickoff, no roster, no head count. The
    // Playbook's Finance is a team of its own for them.
    expect({
      company: asMember.company,
      vision: asMember.vision,
      teams: asMember.teams.map(({ id, name }) => ({ id, name })),
      sources: asMember.sources.map(({ id }) => id),
      statements: asMember.statements.length,
      workflowTeam: asMember.workflows.map(({ teamId }) => teamId),
      mail: asMember.connections.filter(({ name }) => name === "mail"),
    }).toStrictEqual({
      company: { name: "Organization", sector: "", people: 0 },
      vision: {
        ambition: "",
        whyNow: "",
        inviteTeamIds: [],
        budget: [],
        toolApproval: [],
        sourceId: "",
        version: 0,
      },
      teams: [
        { id: `team.playbook-${finance}`, name: "Finance" },
        { id: `team.playbook-${support}`, name: "Support" },
      ],
      sources: [source],
      statements: 3,
      workflowTeam: [`team.playbook-${finance}`],
      mail: workspace.connections.filter(({ name }) => name === "mail"),
    });
  });

  it("holds no record of a Playbook the person can't read", async () => {
    await builtins(env).ensureInstalled(await fingerprintOf(release));
    const admin = await signedInApi(idp, "admin");
    await saveInterview(admin);
    await drawWorkflow(admin);
    const member = await signedInApi(idp, "user");
    const before = fromPlaybook(await member.api.brain.read());

    // Nothing sets a built-in collection's access over RPC yet: here, as
    // an admin could restrict it, the Playbook is for admins only.
    await env.KNOWLEDGE.prepare(
      "UPDATE collections SET access = 'admins' WHERE id = ?"
    )
      .bind(playbook)
      .run();
    const after = fromPlaybook(await member.api.brain.read());
    const asAdmin = fromPlaybook(await admin.api.brain.read());

    expect({
      before: before.statements.length > 0 && before.workflows.length > 0,
      after,
      admin: {
        sources: asAdmin.sources.length,
        statements: asAdmin.statements.length,
        workflows: asAdmin.workflows.length,
      },
    }).toStrictEqual({
      before: true,
      after: { sources: [], statements: [], workflows: [], teams: [] },
      admin: {
        sources: before.sources.length,
        statements: before.statements.length,
        workflows: before.workflows.length,
      },
    });
  });
});
