import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { purgedMarker } from "@grasp-os/shared/brain-records";
import { visionFields } from "@grasp-os/shared/kickoff";
import type { VisionField } from "@grasp-os/shared/kickoff";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { mondayOf } from "../src/onboarding/rules.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { adminKickoff } from "./admin-kickoff.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { fakeProvider } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// The company brain's workspace (`brain.read`, brain-rpc.ts), assembled
// from what core holds: the onboarding (the kickoff, who works where)
// and the connections. Each is put in here as the product puts it in:
// staff bring in the kickoff, the admin gives the roster. The model
// provider behind connect is the outside system, a fake. What can go wrong,
// tried here: a team counted twice when two sources name it; the
// onboarding, which only admins see, reaching anyone else, beyond the
// kickoff's vision and teams, which every member reads; a replaced
// transcript's vision and teams still read; an interview
// shown before the admin's progress counts it, an employee's shown at
// all, or anything said in one reaching the brain; a tool counted twice
// when two documents, or a document and a brain record, name it; a
// hidden entry's connection lost; an empty
// deployment failing to give the brain anything to build from.

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
 * Staff bring the kickoff in, read by the fake provider as `reading`, and
 * keep the sponsor's `answers`.
 */
const bringInKickoff = async (
  answers: Partial<Record<VisionField, string>> = {},
  reading: typeof kickoffReading = kickoffReading
): Promise<void> => {
  const staff = adminKickoff();
  await fakeProvider({
    text: JSON.stringify(reading),
    inputTokens: 900,
    outputTokens: 300,
  });
  await staff.saveKickoff({
    locale: "en",
    transcript: { text: kickoffTranscript },
  });
  for (const field of visionFields) {
    const text = answers[field];
    if (text !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one answer after another
      await staff.answerKickoff(field, text);
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

/** Who works where: Finance, Legal, Ops and HR, each with a lead, and Sales without one. */
const twoLeads: RosterInput = {
  teams: [
    { id: "finance", name: "Finance", lead: "ann" },
    { id: "legal", name: "Legal", lead: "lea" },
    { id: "ops", name: "Ops", lead: "olu" },
    { id: "hr", name: "HR", lead: "hal" },
    { id: "sales", name: "Sales", lead: null },
  ],
  people: [
    { id: "ann", name: "Ann", team: "finance", title: "Head of finance" },
    { id: "ben", name: "Ben", team: "finance", title: "Accountant" },
    { id: "lea", name: "Lea", team: "legal", title: "" },
    { id: "olu", name: "Olu", team: "ops", title: "Ops lead" },
    { id: "hal", name: "Hal", team: "hr", title: "HR lead" },
    { id: "sam", name: "Sam", team: "sales", title: "Seller" },
  ],
};

/** The roster after the links went out: Hal moved to lead Sales, HR left without a lead. */
const halMoved: RosterInput = {
  teams: twoLeads.teams.map((team) => {
    if (team.id === "hr") {
      return { ...team, lead: null };
    }
    return team.id === "sales" ? { ...team, lead: "hal" } : team;
  }),
  people: twoLeads.people.map((one) =>
    one.id === "hal" ? { ...one, team: "sales" } : one
  ),
};

/** A Word file holding one paragraph of `text`. */
const wordFile = (text: string): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const namespace =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return Uint8Array.from(
    zipSync({
      "word/document.xml": encoder.encode(
        `<?xml version="1.0"?><w:document xmlns:w="${namespace}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
      ),
      "word/styles.xml": encoder.encode(
        `<?xml version="1.0"?><w:styles xmlns:w="${namespace}"/>`
      ),
    })
  );
};

/** The admin shares a document the fake provider reads as naming `tools` and `teams`. */
const shareDocument = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  name: string,
  tools: string[],
  teams: string[]
) => {
  await fakeProvider({
    text: JSON.stringify({
      about: "How invoices are booked.",
      tools,
      teams,
      unclear: ["Who checks the booking."],
      question: "",
      options: [],
    }),
    inputTokens: 1200,
    outputTokens: 150,
  });
  return await admin.api.onboarding.shareDocument({
    locale: "en",
    name,
    bytes: wordFile(
      "Invoices are typed into Exact Online by Finance, after a check in ClaimsPro."
    ),
  });
};

/** HubSpot, the catalog's one toolkit, as the brain lists it. */
const hubspotAs = (status: string) => ({
  name: "HubSpot",
  status,
  via: "composio",
  matches: ["HubSpot"],
});

/** The native connections `person`'s Brain page lists as connected, each with its mark. */
const nativeConnected = async (
  person: Awaited<ReturnType<typeof signedInApi>>
) => {
  const { connections } = await person.api.brain.read();
  return (
    connections
      // Earlier tests' shared connections (mail, HubSpot) aside.
      .filter(
        ({ name, status }) =>
          status === "connected" &&
          (name === "Google Workspace" || name === "Microsoft 365")
      )
      .map(({ name, keepsReads }) => ({ name, keepsReads }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  );
};

/** `teams` with the id of each team the kickoff named as `kickoff`: a hash of its name. */
const kickoffAs = <T extends { id: string }>(teams: T[]): T[] =>
  teams.map((team) =>
    team.id.startsWith("onb-kt-") ? { ...team, id: "kickoff" } : team
  );

/** The names of the teams the kickoff named. */
const kickoffTeams = (teams: { id: string; name: string }[]) =>
  teams.flatMap(({ id, name }) => (id.startsWith("onb-kt-") ? [name] : []));

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
      teamGroups: [],
      interviewWeeks: [],
      tools: [],
      sources: [],
      statements: [],
      candidates: [],
      gaps: [],
      workflows: [],
      connections: true,
    });
  });

  it("maps the kickoff, the roster and the connections, and shows the onboarding but its vision and teams to admins alone", async () => {
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
      // Earlier tests brought the kickoff in too: each change a version.
      vision: { ...workspace.vision, version: workspace.vision.version > 0 },
      teams: kickoffAs(workspace.teams),
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
        version: true,
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
          id: "kickoff",
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

    // Someone who isn't an admin gets the connections and the kickoff's
    // vision and teams with the sizes the sponsor gave them, which are the
    // company's, never the rest of the onboarding: no roster team, no
    // business, and no company head count (`company.people`).
    const kickoffSource = workspace.sources.filter(
      ({ id }) => id === "src-kickoff"
    );
    expect({
      company: asMember.company,
      vision: asMember.vision,
      teams: kickoffAs(asMember.teams),
      sources: asMember.sources,
      mail: asMember.connections.filter(({ name }) => name === "mail"),
    }).toStrictEqual({
      company: { name: "Organization", sector: "", people: 0 },
      vision: { ...workspace.vision, inviteTeamIds: [] },
      teams: [
        {
          id: "kickoff",
          name: "Finance",
          sourceId: "src-kickoff",
          counts: [{ sourceId: "src-kickoff", date: today(), people: 8 }],
          stakeholders: [],
        },
        kickoffAs(workspace.teams).find(({ name }) => name === "Legal"),
      ],
      sources: kickoffSource,
      mail: workspace.connections.filter(({ name }) => name === "mail"),
    });
  });

  it("shows each team lead's interview by its week and the documents shared, with their tools, to admins alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await admin.api.onboarding.saveRoster(twoLeads);
    const day = 24 * 60 * 60 * 1000;
    const daysAgo = (count: number) =>
      new Date(Date.now() - count * day).toISOString();
    const store = onboardingStore(env);
    const by = { type: "system" } as const;
    await store.savePlan({ start: daysAgo(20).slice(0, 10), days: 28 }, by);
    await store.setAgreements(
      { processing: true, assessment: true, council: "none" },
      by
    );
    // Every link goes out now: Ann and Lea as their teams' leads, Ben as
    // one of Finance.
    await store.releaseDue();
    // Hal, HR's lead when the links went out, moves to lead Sales before
    // he talks: his lead's interview is for Sales, and neither team counts
    // it as its lead's.
    await admin.api.onboarding.saveRoster(halMoved);
    // Finance's lead finished two weeks ago, in a week that is over;
    // Legal's lead today, in this week; Ben, an employee, two weeks ago;
    // Olu, Ops's lead when the links went out, two weeks ago, but as an
    // employee, as he was no longer its lead when he talked.
    const finished = [
      ["ann", daysAgo(14), "lead"],
      ["lea", new Date().toISOString(), "lead"],
      ["ben", daysAgo(14), "own"],
      ["olu", daysAgo(14), "own"],
      ["hal", daysAgo(14), "lead"],
    ] as const;
    for (const [person, at, kind] of finished) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await store.noteInterview({
        person,
        kind,
        startedAt: at,
        completedAt: at,
      });
    }
    // Then the admin makes Ben the only member and lead of a team of his
    // own: it tells them nothing about his interview.
    await admin.api.onboarding.saveRoster({
      ...halMoved,
      teams: [...halMoved.teams, { id: "solo", name: "Solo", lead: "ben" }],
      people: halMoved.people.map((one) =>
        one.id === "ben" ? { ...one, team: "solo" } : one
      ),
    });
    const first = await shareDocument(
      admin,
      `booking-${crypto.randomUUID()}.docx`,
      ["Exact Online", "ClaimsPro", "Microsoft Project", "Microsoft.Project"],
      ["finance", "Nobody"]
    );
    const second = await shareDocument(
      admin,
      `contracts-${crypto.randomUUID()}.docx`,
      ["claimspro"],
      ["Legal"]
    );

    const workspace = await admin.api.brain.read();
    const asMember = await member.api.brain.read();
    const { progress } = await admin.api.onboarding.view();
    const finishedWeek = mondayOf(daysAgo(14));

    expect({
      leadTalked: progress?.teams.map(({ id, leadTalked }) => [id, leadTalked]),
      sources: workspace.sources.filter(({ id }) => id.startsWith("src.")),
      tools: workspace.tools,
      member: {
        // The kickoff an earlier test brought in is the company's: this
        // test's sources alone.
        sources: asMember.sources.filter(({ id }) => id.startsWith("src.")),
        tools: asMember.tools,
      },
    }).toStrictEqual({
      leadTalked: [
        ["finance", true],
        ["legal", false],
        ["ops", false],
        ["hr", false],
        ["sales", false],
        ["solo", false],
      ],
      sources: [
        {
          id: "src.lead-finance",
          kind: "interview",
          title: "Interview with Finance",
          date: finishedWeek,
          // The lead's role alone would point at them: never sent.
          step: 2,
          interviewee: "stakeholder",
          teamIds: ["team-finance"],
        },
        {
          id: `src.document-${first.id}`,
          kind: "document",
          title: first.name,
          date: today(),
          step: 2,
        },
        {
          id: `src.document-${second.id}`,
          kind: "document",
          title: second.name,
          date: today(),
          step: 2,
        },
      ],
      tools: [
        {
          id: "tool.document-exact-online",
          name: "Exact Online",
          teamIds: ["team-finance"],
          sourceId: `src.document-${first.id}`,
        },
        {
          id: "tool.document-claimspro",
          name: "ClaimsPro",
          teamIds: ["team-finance", "team-legal"],
          sourceId: `src.document-${first.id}`,
        },
        // Two names whose letters read alike stay two tools.
        {
          id: "tool.document-microsoft-project",
          name: "Microsoft Project",
          teamIds: ["team-finance"],
          sourceId: `src.document-${first.id}`,
        },
        {
          id: "tool.document-microsoft-project-2",
          name: "Microsoft.Project",
          teamIds: ["team-finance"],
          sourceId: `src.document-${first.id}`,
        },
      ],
      member: { sources: [], tools: [] },
    });
  });

  it("shows a tool a document and a brain record both name once, as the record, used by the teams of both", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await admin.api.onboarding.saveRoster(roster);
    const tag = crypto.randomUUID().slice(0, 8);
    const record: Extract<BrainRecordInput, { type: "tool" }> = {
      type: "tool",
      id: `tool-${tag}`,
      name: `ledger ${tag}`,
      teamIds: ["team-ops"],
      sourceId: `src-${tag}`,
      ai: "none",
    };
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: `src-${tag}`,
        kind: "interview",
        title: "Operations interview",
        date: today(),
      },
      record,
    ]);
    const document = await shareDocument(
      admin,
      `booking-${crypto.randomUUID()}.docx`,
      [`Ledger ${tag}`, `Claims ${tag}`],
      ["Finance"]
    );

    const workspace = await admin.api.brain.read();
    const asMember = await member.api.brain.read();
    // Other tests' documents name tools too: this test's alone.
    const tools = workspace.tools.filter(({ name }) => name.includes(tag));

    expect({ tools, member: asMember.tools }).toStrictEqual({
      tools: [
        {
          id: `tool.document-claims-${tag}`,
          name: `Claims ${tag}`,
          teamIds: ["team-finance"],
          sourceId: `src.document-${document.id}`,
        },
        // The record keeps its id, name and source.
        {
          id: record.id,
          name: record.name,
          teamIds: ["team-ops", "team-finance"],
          sourceId: record.sourceId,
          ai: "none",
        },
      ],
      // A member reads no shared document: the record as it was added.
      member: [
        {
          id: record.id,
          name: record.name,
          teamIds: ["team-ops"],
          sourceId: record.sourceId,
          ai: "none",
        },
      ],
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

  it("marks the connections the Brain keeps a person's reads from: their own, to a provider with a tool that answers one item", async () => {
    const owner = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "user");
    const now = Date.now();
    /** A native connection, as connect keeps one: `ownerUserId`'s, or shared. */
    const connected = async (provider: string, ownerUserId: string | null) => {
      await connectDb()
        .prepare(
          "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'native', ?, ?, ?)"
        )
        .bind(
          `connection-${crypto.randomUUID()}`,
          provider,
          ownerUserId === null ? "shared" : "personal",
          ownerUserId,
          `${provider}-server`,
          now,
          now
        )
        .run();
    };
    // The owner's own Google, and a shared Microsoft 365 they reach too.
    await connected("google", owner.userId);
    await connected("microsoft", null);
    expect({
      owner: await nativeConnected(owner),
      other: await nativeConnected(other),
    }).toStrictEqual({
      owner: [
        { name: "Google Workspace", keepsReads: true },
        { name: "Microsoft 365", keepsReads: undefined },
      ],
      // Someone else: the shared one alone, and no mark on it.
      other: [{ name: "Microsoft 365", keepsReads: undefined }],
    });
  });

  it("shows every member the kickoff's vision as the sponsor answers it, and its teams, which an admin's records may name", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staff = adminKickoff();
    await bringInKickoff();
    const said = `Clients wait ${unique()} weeks.`;

    await staff.answerKickoff("pain", said);
    const answered = await member.api.brain.read();
    const legal = answered.teams.find(({ name }) => name === "Legal");
    // A team the kickoff named has an id: an admin can add what is known
    // of it.
    const source = `src-${unique()}`;
    const stakeholder = await admin.api.brain.addRecords([
      {
        type: "source",
        id: source,
        kind: "interview",
        title: "Legal interview",
        date: today(),
      },
      {
        type: "stakeholder",
        id: `${source}-lead`,
        teamId: legal?.id ?? "",
        sourceId: source,
        date: today(),
        role: "Head of legal",
      },
    ]);
    const { teams } = await member.api.brain.read();

    expect({
      vision: {
        ambition: answered.vision.ambition,
        whyNow: answered.vision.whyNow,
        sourceId: answered.vision.sourceId,
      },
      teams: kickoffTeams(answered.teams),
      kickoff: answered.sources.some(({ id }) => id === "src-kickoff"),
      legal: legal?.counts.map(({ people }) => people),
      stakeholder,
      legalRoles: teams
        .find(({ id }) => id === legal?.id)
        ?.stakeholders.map(({ role }) => role),
    }).toStrictEqual({
      vision: {
        ambition: "Every client gets their numbers within a week.",
        whyNow: `Copying invoices by hand.\n${said}`,
        sourceId: "src-kickoff",
      },
      teams: ["Finance", "Legal"],
      kickoff: true,
      legal: [3],
      stakeholder: { added: 2, unchanged: 0 },
      legalRoles: ["Head of legal"],
    });
  });

  it("reads a replaced kickoff's vision and teams alone, a team it names again keeping what an admin added for it", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staff = adminKickoff();
    // A first transcript, without the sponsor's answer about the pain.
    await bringInKickoff();
    await staff.answerKickoff("pain", "");
    await bringInKickoff();
    const first = await member.api.brain.read();
    // An admin adds what is known of Legal: it stays with Legal when the
    // next transcript names it again.
    const firstLegal =
      first.teams.find(({ name }) => name === "Legal")?.id ?? "";
    const source = `src-${unique()}`;
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: source,
        kind: "interview",
        title: "Legal interview",
        date: today(),
      },
      {
        type: "stakeholder",
        id: `${source}-lead`,
        teamId: firstLegal,
        sourceId: source,
        date: today(),
        role: "General counsel",
      },
      {
        type: "statement",
        id: `${source}-st`,
        kind: "blocker",
        text: "Contracts wait for a signature.",
        sourceId: source,
        teamIds: [firstLegal],
      },
    ]);

    // The second transcript reads other goals, and Legal alone, now of 8.
    await bringInKickoff(
      {},
      {
        fields: [
          {
            field: "goals",
            text: "AI helps the firm get there.",
            quote: "AI should help us get there",
            ask: "",
          },
        ],
        teams: [{ name: "Legal", does: "Contracts", people: 8 }],
      }
    );
    const second = await member.api.brain.read();
    const secondLegal = second.teams.find(({ name }) => name === "Legal");

    expect({
      first: {
        ambition: first.vision.ambition,
        teams: kickoffTeams(first.teams),
      },
      second: {
        ambition: second.vision.ambition,
        whyNow: second.vision.whyNow,
        teams: second.teams
          .filter(({ id }) => id.startsWith("onb-kt-"))
          .map(({ name, counts }) => [
            name,
            counts.map(({ people }) => people),
          ]),
      },
      // What the admin added for Legal is still Legal's: its newest
      // stakeholder (an earlier test's Legal gave it one too).
      legalRole: secondLegal?.stakeholders.at(-1)?.role,
      statementTeams: second.statements
        .find(({ id }) => id === `${source}-st`)
        ?.teamIds.map((id) => id === secondLegal?.id),
    }).toStrictEqual({
      first: {
        ambition: "Every client gets their numbers within a week.",
        teams: ["Finance", "Legal"],
      },
      second: {
        ambition: "AI helps the firm get there.",
        whyNow: "",
        teams: [["Legal", [8]]],
      },
      legalRole: "General counsel",
      statementTeams: [true],
    });
  });

  it("keeps a team the kickoff names again in another case one team, with what an admin added for it", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await bringInKickoff();
    const before = await member.api.brain.read();
    const legal = before.teams.find(({ name }) => name === "Legal")?.id ?? "";
    const source = `src-${unique()}`;
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: source,
        kind: "interview",
        title: "Legal interview",
        date: today(),
      },
      {
        type: "stakeholder",
        id: `${source}-lead`,
        teamId: legal,
        sourceId: source,
        date: today(),
        role: "Head of contracts",
      },
    ]);

    // The transcript read again names it twice more, in other cases.
    await bringInKickoff(
      {},
      {
        ...kickoffReading,
        teams: [
          { name: "LEGAL", does: "Contracts", people: 3 },
          { name: "legal ", does: "Contracts", people: 3 },
        ],
      }
    );
    const after = await member.api.brain.read();
    const named = after.teams.filter(
      ({ name }) => name.trim().toLowerCase() === "legal"
    );

    expect({
      named: named.map(({ id, name }) => ({ same: id === legal, name })),
      role: named[0]?.stakeholders.at(-1)?.role,
    }).toStrictEqual({
      named: [{ same: true, name: "LEGAL" }],
      role: "Head of contracts",
    });
  });

  it("shows no team of the kickoff once the admin deletes it, the roster's teams alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await admin.api.onboarding.saveRoster(roster);
    await bringInKickoff();
    const before = await member.api.brain.read();

    await admin.api.onboarding.deleteKickoff();
    const asAdmin = await admin.api.brain.read();
    const asMember = await member.api.brain.read();

    expect({
      before: before.teams.map(({ name }) => name),
      admin: asAdmin.teams.map(({ name, sourceId, counts }) => ({
        name,
        sourceId,
        sources: [...new Set(counts.map((count) => count.sourceId))],
      })),
      member: asMember.teams,
      vision: asMember.vision.sourceId,
    }).toStrictEqual({
      before: ["Finance", "Legal"],
      admin: [
        { name: "Finance", sourceId: "src-roster", sources: ["src-roster"] },
        {
          name: "Operations",
          sourceId: "src-roster",
          sources: ["src-roster"],
        },
      ],
      member: [],
      vision: "",
    });
  });

  it("names a kickoff team's statement as the roster team it joined, once the roster names it", async () => {
    const admin = await signedInApi(idp, "admin");
    // The kickoff names Legal, as its transcript does; the roster doesn't
    // yet.
    const name = "Legal";
    await admin.api.onboarding.saveRoster(roster);
    await bringInKickoff(
      {},
      { ...kickoffReading, teams: [{ name, does: "Contracts", people: 3 }] }
    );
    const before = await admin.api.brain.read();
    const kickoffTeam = before.teams.find((team) => team.name === name);
    const source = `src-${unique()}`;
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: source,
        kind: "interview",
        title: "Legal interview",
        date: today(),
      },
      {
        type: "statement",
        id: `${source}-st`,
        kind: "blocker",
        text: "Contracts wait for a signature.",
        sourceId: source,
        teamIds: [kickoffTeam?.id ?? ""],
      },
    ]);
    // The roster names the team too: the kickoff's joins it.
    await admin.api.onboarding.saveRoster({
      teams: [{ id: "legal-team", name, lead: "lex" }],
      people: [{ id: "lex", name: "Lex", team: "legal-team", title: "" }],
    });
    const after = await admin.api.brain.read();
    const joined = after.teams.filter((team) => team.name === name);
    const statement = after.statements.find(({ id }) => id === `${source}-st`);

    expect({
      kickoffTeam: kickoffTeam?.id.startsWith("onb-kt-"),
      joined: joined.map(({ id }) => id.startsWith("onb-kt-")),
      // The statement names the team that is read, never the one joined.
      statementTeams: statement?.teamIds.map((id) => id === joined[0]?.id),
    }).toStrictEqual({
      kickoffTeam: true,
      joined: [false],
      statementTeams: [true],
    });
  });

  it("gives the brain the kickoff as it is once saves overlap, the newest transcript's records alone", async () => {
    const member = await signedInApi(idp, "user");
    const store = onboardingStore(env);
    // Two readings, each of a team its transcript names, as the store
    // keeps them.
    await bringInKickoff(
      {},
      {
        ...kickoffReading,
        teams: [{ name: "Finance", does: "Work", people: 2 }],
      }
    );
    const finance = await store.kickoff();
    await bringInKickoff(
      {},
      { ...kickoffReading, teams: [{ name: "Legal", does: "Work", people: 4 }] }
    );
    const legal = await store.kickoff();
    // Two saves at once, as two staff bringing a transcript in.
    const mark = await store.purgeMark();
    const by = { type: "system" } as const;
    const readings = [finance.reading, legal.reading].flatMap((each) =>
      each === null ? [] : [each]
    );
    await Promise.all(
      readings.map(
        async (reading) =>
          await store.saveKickoff(
            { transcript: kickoffTranscript, fileName: null, reading },
            by,
            mark
          )
      )
    );
    const kept = await store.kickoff();
    const { teams } = await member.api.brain.read();

    expect(
      kickoffTeams(teams).filter(
        (each) => each === "Finance" || each === "Legal"
      )
    ).toStrictEqual((kept.reading?.teams ?? []).map(({ name }) => name));
  });

  it("joins no two teams an earlier release's purge left named the same", async () => {
    const admin = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    // The kickoff names one team, an admin's record another, as a term
    // purge of an earlier release left both: "Legal (removed)".
    await bringInKickoff();
    const { reading } = await store.kickoff();
    await store.saveKickoff(
      {
        transcript: `${kickoffTranscript}\nAnna (CEO): Legal ${purgedMarker}.`,
        fileName: null,
        reading: {
          ...(reading ?? { fields: {}, ask: {}, teams: [] }),
          teams: [
            { name: `Legal ${purgedMarker}`, does: "Contracts", people: 3 },
          ],
        },
      },
      { type: "system" },
      await store.purgeMark()
    );
    const source = `src-${unique()}`;
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: source,
        kind: "interview",
        title: "Legal interview",
        date: today(),
      },
      {
        type: "team",
        id: `${source}-team`,
        name: `Legal ${purgedMarker}`,
        sourceId: source,
      },
    ]);
    const { teams } = await admin.api.brain.read();
    const removed = teams.filter(
      ({ name }) => name === `Legal ${purgedMarker}`
    );

    expect(
      removed
        .map(({ id }) => id.startsWith("onb-kt-"))
        .toSorted((a, b) => Number(a) - Number(b))
    ).toStrictEqual([false, true]);
  });

  it("leaves room for a kickoff brought in again and again: retired records take none", async () => {
    const member = await signedInApi(idp, "user");
    const store = onboardingStore(env);
    await bringInKickoff();
    const { reading } = await store.kickoff();
    // More teams, over all the transcripts, than the brain keeps of a type.
    const names = Array.from({ length: 30 }, (_, at) => `Desk ${at + 1}`);
    const saves = 20;
    for (let save = 0; save < saves; save += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one transcript after another
      await store.saveKickoff(
        {
          transcript: `${kickoffTranscript}\nAnna (CEO): Take ${save}.`,
          fileName: null,
          reading: {
            ...(reading ?? { fields: {}, ask: {}, teams: [] }),
            teams: names.map((name) => ({ name, does: "Work", people: 2 })),
          },
        },
        { type: "system" },
        // oxlint-disable-next-line no-await-in-loop -- read as each save begins
        await store.purgeMark()
      );
    }
    const { teams } = await member.api.brain.read();

    expect(
      kickoffTeams(teams).filter((name) => names.includes(name))
    ).toHaveLength(names.length);
  });
});
