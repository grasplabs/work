import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { visionFields } from "@grasp-os/shared/kickoff";
import type { VisionField } from "@grasp-os/shared/kickoff";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeGateway } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { openRpc, signedIn, signedInApi, staffPerson } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// The company brain's workspace (`brain.read`, brain-rpc.ts), assembled
// from what core holds: the onboarding (the kickoff, who works where)
// and the connections. Each is put in here as the product puts it in:
// staff bring in the kickoff, the admin gives the roster. AI Gateway is
// the outside system, a fake behind the AI binding. What can go wrong,
// tried here: a team counted twice when two sources name it; the
// onboarding, which only admins see, reaching anyone else; a hidden
// entry's connection lost; an empty deployment failing to give the brain
// anything to build from.

const idp = mockIdp();

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

/**
 * Staff bring the kickoff in, read by the fake gateway, and keep the
 * sponsor's `answers`.
 */
const bringInKickoff = async (
  answers: Partial<Record<VisionField, string>> = {}
): Promise<void> => {
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
  for (const field of visionFields) {
    const text = answers[field];
    if (text !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one answer after another
      await staff.onboardingStaff.answerKickoff(field, text);
    }
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

/** HubSpot, the catalog's one toolkit, as the brain lists it. */
const hubspotAs = (status: string) => ({
  name: "HubSpot",
  status,
  via: "composio",
  matches: ["HubSpot"],
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

  it("maps the kickoff, the roster and the connections, and shows the onboarding to admins alone", async () => {
    const admin = await signedInApi(idp, "admin");
    // The sponsor answers what the kickoff already said something about:
    // the brain keeps both.
    await bringInKickoff({ pain: "Clients wait weeks for their numbers." });
    await admin.api.onboarding.saveRoster(roster);
    await mailConnection();

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
        whyNow:
          "Copying invoices by hand.\nClients wait weeks for their numbers.",
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
      ],
      statements: [],
      workflows: [],
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

    // Someone who isn't an admin gets the connections, never the
    // onboarding: no kickoff, no roster, no head count.
    expect({
      company: asMember.company,
      vision: asMember.vision,
      teams: asMember.teams,
      sources: asMember.sources,
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
      teams: [],
      sources: [],
      mail: workspace.connections.filter(({ name }) => name === "mail"),
    });
  });

  it("keeps a connection to an entry an admin hid, by its catalog name, and offers the entry no more", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const hubspot = async () => {
      const { connections } = await member.api.brain.read();
      return connections.filter(({ matches }) =>
        matches.some((each) => each.toLowerCase() === "hubspot")
      );
    };
    const offered = await hubspot();

    await admin.api.connections.setOffered("composio", "hubspot", false);
    const hidden = await hubspot();

    // A shared HubSpot connection, as connect keeps one, made before it was hidden.
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'hubspot', 'shared', 'active', 'composio', 'https://hubspot.invalid/mcp', '[]', ?, ?)"
      )
      .bind(`connection-${crypto.randomUUID()}`, now, now)
      .run();
    const connected = await hubspot();
    await admin.api.connections.setOffered("composio", "hubspot", true);

    expect({ offered, hidden, connected }).toStrictEqual({
      offered: [hubspotAs("available")],
      hidden: [],
      connected: [hubspotAs("connected")],
    });
  });
});
