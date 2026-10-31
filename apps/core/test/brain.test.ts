import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { kickoffErrors, visionFields } from "@grasp-os/shared/kickoff";
import type { VisionField } from "@grasp-os/shared/kickoff";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { mondayOf } from "../src/onboarding/rules.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { answeringProvider, fakeProvider } from "./model-provider.ts";
import {
  auditedDuring,
  openRpc,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// The company brain's workspace (`brain.read`, brain-rpc.ts), assembled
// from what core holds: the onboarding (the kickoff, who works where)
// and the connections. Each is put in here as the product puts it in:
// staff bring in the kickoff, the admin gives the roster. The model
// provider behind connect is the outside system, a fake. What can go wrong,
// tried here: a team counted twice when two sources name it; the
// onboarding, which only admins see, reaching anyone else, beyond the
// kickoff's vision and teams, which it gives the brain as records; the
// kickoff kept twice, its vision written over, or a replaced transcript's
// vision and teams still read, or deleted; an interview
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

/** Grasp's staff, signed in to the deployment. */
const staffApi = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/**
 * Staff bring the kickoff in, read by the fake provider as `reading`, and
 * keep the sponsor's `answers`.
 */
const bringInKickoff = async (
  answers: Partial<Record<VisionField, string>> = {},
  reading: typeof kickoffReading = kickoffReading
): Promise<void> => {
  const staff = await staffApi();
  await fakeProvider({
    text: JSON.stringify(reading),
    inputTokens: 900,
    outputTokens: 300,
  });
  await staff.onboardingStaff.saveKickoff({
    locale: "en",
    transcript: { text: kickoffTranscript },
  });
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

/** `teams` with the id of each team the kickoff named as `kickoff`: a hash of its name. */
const kickoffAs = <T extends { id: string }>(teams: T[]): T[] =>
  teams.map((team) =>
    team.id.startsWith("onb-kt-") ? { ...team, id: "kickoff" } : team
  );

/** The records `run` gave the brain, by type, and who gave them. */
const keptBy = async (run: () => Promise<unknown>) => {
  const events = await auditedDuring(run);
  return events
    .filter(({ action }) => action.startsWith("brain.records."))
    .map(({ action, actor, provenance }) => ({
      action,
      actor: actor.type,
      records: provenance.map((key) => key.split(":")[0]),
    }));
};

/** Whether each of `ids` is kept in the brain's records, and retired. */
const retiredOf = async (ids: readonly string[]) => {
  const { results } = await env.DB.prepare(
    "SELECT id, retired_at IS NOT NULL AS retired FROM brain_records WHERE id IN (SELECT value FROM json_each(?)) ORDER BY position"
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; retired: number }>();
  return results.map(({ retired }) => retired === 1);
};

/** The names of the teams the kickoff named, as records. */
const kickoffTeams = (teams: { id: string; name: string }[]) =>
  teams.flatMap(({ id, name }) => (id.startsWith("onb-kt-") ? [name] : []));

/** The IDs of the sources among `person`'s brain changes since `since`, sorted. */
const sourcesOf = async (
  person: Awaited<ReturnType<typeof signedInApi>>,
  since: string
): Promise<string[]> => {
  const { changes } = await person.api.brain.changes({ since });
  return changes
    .flatMap((change) => (change.kind === "source" ? [change.source.id] : []))
    .toSorted();
};

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
      landscape: [],
    });
  });

  it("gives the onboarding's sources to admins alone in its changes, since the moment asked about", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const since = new Date(Date.now() - 1000).toISOString();
    await bringInKickoff();
    await admin.api.onboarding.saveRoster(roster);

    expect({
      admin: await sourcesOf(admin, since),
      member: await sourcesOf(member, since),
      // Nothing came in after now.
      later: await sourcesOf(
        admin,
        new Date(Date.now() + 60_000).toISOString()
      ),
    }).toStrictEqual({
      admin: ["src-kickoff", "src-roster"],
      member: [],
      later: [],
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
    // vision and teams, which are the company's, never the rest of the
    // onboarding: no roster, no business, no head count.
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
    const since = daysAgo(15);
    const adminChanges = await sourcesOf(admin, since);
    const finishedWeek = mondayOf(daysAgo(14));

    expect({
      leadTalked: progress?.teams.map(({ id, leadTalked }) => [id, leadTalked]),
      sources: workspace.sources.filter(({ id }) => id.startsWith("src.")),
      tools: workspace.tools,
      changes: adminChanges.filter((id) => id.startsWith("src.")),
      member: {
        // The kickoff an earlier test brought in is the company's: this
        // test's sources alone.
        sources: asMember.sources.filter(({ id }) => id.startsWith("src.")),
        tools: asMember.tools,
        changes: await sourcesOf(member, since),
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
      changes: [
        "src.lead-finance",
        `src.document-${first.id}`,
        `src.document-${second.id}`,
      ].toSorted(),
      member: { sources: [], tools: [], changes: [] },
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

  it("gives the brain the kickoff's vision and teams as records every member reads, each once, a new vision whenever it changes", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staff = await staffApi();
    await bringInKickoff();
    const answerPain = async (text: string) =>
      await keptBy(
        async () => await staff.onboardingStaff.answerKickoff("pain", text)
      );
    const said = `Clients wait ${unique()} weeks.`;
    const before = await member.api.brain.read();

    // The sponsor answers about the pain: a new vision, as the onboarding.
    const answered = await answerPain(said);
    const afterAnswer = await member.api.brain.read();
    // The same answer again: nothing new.
    const again = await answerPain(said);
    const afterAgain = await member.api.brain.read();
    // Another answer, then the first one back: each a version of its own,
    // the newest counting.
    const changedBack = [
      ...(await answerPain("Reports are late.")),
      ...(await answerPain(said)),
    ];
    const last = await member.api.brain.read();
    const legal = last.teams.find(({ name }) => name === "Legal");
    // A team the kickoff named is a record with an id: an admin can add
    // what is known of it.
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
    const vision = {
      action: "brain.records.added",
      actor: "system",
      records: ["vision"],
    };

    expect({
      answered,
      afterAnswer: {
        ambition: afterAnswer.vision.ambition,
        whyNow: afterAnswer.vision.whyNow,
        sourceId: afterAnswer.vision.sourceId,
        version: afterAnswer.vision.version - before.vision.version,
        teams: kickoffTeams(afterAnswer.teams),
        kickoff: afterAnswer.sources.some(({ id }) => id === "src-kickoff"),
      },
      again,
      afterAgain: {
        version: afterAgain.vision.version - before.vision.version,
        teams: kickoffTeams(afterAgain.teams),
      },
      changedBack,
      lastVision: {
        whyNow: last.vision.whyNow,
        version: last.vision.version - before.vision.version,
      },
      legal: legal?.counts.map(({ people }) => people),
      stakeholder,
      legalRoles: teams
        .find(({ id }) => id === legal?.id)
        ?.stakeholders.map(({ role }) => role),
    }).toStrictEqual({
      answered: [vision],
      afterAnswer: {
        ambition: "Every client gets their numbers within a week.",
        whyNow: `Copying invoices by hand.\n${said}`,
        sourceId: "src-kickoff",
        version: 1,
        teams: ["Finance", "Legal"],
        kickoff: true,
      },
      again: [],
      afterAgain: { version: 1, teams: ["Finance", "Legal"] },
      changedBack: [vision, vision],
      lastVision: { whyNow: `Copying invoices by hand.\n${said}`, version: 3 },
      legal: [3],
      stakeholder: { added: 2, unchanged: 0 },
      legalRoles: ["Head of legal"],
    });
  });

  it("retires what a replaced kickoff gave the brain, keeping it, and reads the new one's vision and teams alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staff = await staffApi();
    // A first transcript, without the sponsor's answer about the pain.
    await bringInKickoff();
    await staff.onboardingStaff.answerKickoff("pain", "");
    await bringInKickoff();
    const first = await member.api.brain.read();
    const firstIds = first.teams.flatMap(({ id }) =>
      id.startsWith("onb-kt-") ? [id] : []
    );
    // An admin adds what is known of the first transcript's Legal: it goes
    // with Legal when the next transcript names it again.
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
    const replaced = await keptBy(async () => {
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
    });
    const second = await member.api.brain.read();
    const secondLegal = second.teams.find(({ name }) => name === "Legal");

    expect({
      first: {
        ambition: first.vision.ambition,
        version: first.vision.version,
        teams: kickoffTeams(first.teams),
      },
      replaced,
      second: {
        ambition: second.vision.ambition,
        whyNow: second.vision.whyNow,
        version: second.vision.version,
        teams: second.teams
          .filter(({ id }) => id.startsWith("onb-kt-"))
          .map(({ name, counts }) => [
            name,
            counts.map(({ people }) => people),
          ]),
        notFirst: second.teams.every(({ id }) => !firstIds.includes(id)),
      },
      // What the admin added for the first Legal is the new Legal's: its
      // newest stakeholder (an earlier test's Legal gave it one too).
      legalRole: secondLegal?.stakeholders.at(-1)?.role,
      statementTeams: second.statements
        .find(({ id }) => id === `${source}-st`)
        ?.teamIds.map((id) => id === secondLegal?.id),
      // The first transcript's teams are kept, retired.
      retired: await retiredOf(firstIds),
    }).toStrictEqual({
      first: {
        ambition: "Every client gets their numbers within a week.",
        version: 1,
        teams: ["Finance", "Legal"],
      },
      replaced: [
        {
          action: "brain.records.added",
          actor: "system",
          records: ["vision", "team", "teamCount"],
        },
        {
          action: "brain.records.retired",
          actor: "system",
          records: ["vision", "team", "teamCount", "team", "teamCount"],
        },
      ],
      second: {
        ambition: "AI helps the firm get there.",
        whyNow: "",
        version: 1,
        teams: [["Legal", [8]]],
        notFirst: true,
      },
      legalRole: "General counsel",
      statementTeams: [true],
      retired: [true, true],
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

  it("refuses a transcript whose reading began before a content purge, so its words never come back", async () => {
    const admin = await signedInApi(idp, "admin");
    const staff = await staffApi();
    const term = `Zq${unique()}`;
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Purged ${unique()}`,
      access: "everyone",
    });
    const document = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "note.md",
      text: `# Note\n${term} was named.`,
      ifVersion: 0,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [term],
      reason: "erasure_request",
    };
    const before = await onboardingStore(env).kickoff();
    // The model reads the transcript naming the term; the purge runs
    // while it does.
    const { promise: reading, resolve: read } =
      Promise.withResolvers<boolean>();
    const { promise: asked, resolve: ask } = Promise.withResolvers<boolean>();
    await answeringProvider(async () => {
      ask(true);
      await reading;
      return {
        text: JSON.stringify({
          ...kickoffReading,
          teams: [{ name: "Legal", does: term, people: 3 }],
        }),
        inputTokens: 900,
        outputTokens: 300,
      };
    });
    /** The save, as its code: `saved`, or why it was refused. */
    const saving = async (): Promise<string> => {
      try {
        await staff.onboardingStaff.saveKickoff({
          locale: "en",
          transcript: { text: `${kickoffTranscript}\nAnna (CEO): ${term}.` },
        });
        return "saved";
      } catch (error) {
        return kickoffErrors.codeOf(error) ?? String(error);
      }
    };
    const saved = saving();
    await asked;
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);
    read(true);
    const after = await onboardingStore(env).kickoff();

    expect({
      saved: await saved,
      // The kickoff as it was before: the save kept nothing.
      same: after.transcript?.at === before.transcript?.at,
    }).toStrictEqual({ saved: "kickoff.purged", same: true });
  });

  it("forgets the kickoff a content purge reaches, so no answer after gives the brain its words again", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staff = await staffApi();
    const term = `Zq${unique()}`;
    await bringInKickoff({ pain: `Clients wait for ${term}.` });
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Purged ${unique()}`,
      access: "everyone",
    });
    const document = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "note.md",
      text: `# Note\n${term} was named.`,
      ifVersion: 0,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [term],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    // An answer at the same time as the purge, then two after it, as
    // Greptile's case: another field, then the pain.
    const [during] = await Promise.allSettled([
      staff.onboardingStaff.answerKickoff("goals", "Faster closing."),
      admin.api.knowledge.purge(input, plan.token),
    ]);
    const answered = await Promise.allSettled([
      staff.onboardingStaff.answerKickoff("goals", "Faster closing."),
      staff.onboardingStaff.answerKickoff("pain", "Late reports."),
    ]);
    const read = await member.api.brain.read();
    const kickoff = await onboardingStore(env).kickoff();

    expect({
      during: during.status === "fulfilled" || during.status === "rejected",
      kickoff: kickoff.transcript,
      answered: answered.map(({ status }) => status),
      holds: JSON.stringify(read).includes(term),
    }).toStrictEqual({
      during: true,
      kickoff: null,
      // Nothing to answer: the kickoff is gone.
      answered: ["rejected", "rejected"],
      holds: false,
    });
  });

  it("keeps the kickoff's records once their write failed, from the store's alarm", async () => {
    const member = await signedInApi(idp, "user");
    const staff = await staffApi();
    await bringInKickoff();
    const pain = `Late reports ${unique()}.`;
    // D1 refuses the brain's write of the vision naming this answer, and
    // only that one, until the trigger goes: however often anything tries
    // it meanwhile (an alarm left due by an earlier test, say), it fails.
    const trigger = `refuse_${unique().replaceAll(/\W/gu, "_")}`;
    await env.DB.exec(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_records WHEN NEW.body LIKE '%${pain}%' BEGIN SELECT RAISE(ABORT, 'D1 is unavailable'); END`
    );
    let answered: unknown;
    let before: string;
    try {
      answered = await staff.onboardingStaff.answerKickoff("pain", pain);
      before = JSON.stringify(await member.api.brain.read());
    } finally {
      await env.DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    await runInDurableObject(onboardingStore(env), async (store) => {
      await store.alarm();
    });
    const after = JSON.stringify(await member.api.brain.read());

    expect({
      answered: answered !== undefined,
      before: before.includes(pain),
      after: after.includes(pain),
    }).toStrictEqual({ answered: true, before: false, after: true });
  });

  it("still names the kickoff as the source of its records after a purge forgot it", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const term = `Zq${unique()}`;
    await bringInKickoff({ pain: `Clients wait for ${term}.` });
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Purged ${unique()}`,
      access: "everyone",
    });
    const document = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "note.md",
      text: `# Note\n${term} was named.`,
      ifVersion: 0,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [term],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);
    const read = await member.api.brain.read();
    const kickoff = await onboardingStore(env).kickoff();

    expect({
      kickoff: kickoff.transcript,
      cites: read.vision?.sourceId,
      // Earlier tests' interviews are sources too: the kickoff's alone here.
      source: read.sources
        .filter(({ id }) => id === "src-kickoff")
        .map(({ id, title }) => ({ id, title })),
      holds: JSON.stringify(read).includes(term),
    }).toStrictEqual({
      kickoff: null,
      cites: "src-kickoff",
      source: [{ id: "src-kickoff", title: "Kickoff" }],
      holds: false,
    });
  });

  it("joins no two teams a purge left named the same", async () => {
    const admin = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    const [first, second] = [`Zq${unique()}`, `Zq${unique()}`];
    // The kickoff names one team, an admin's record another: after the
    // purge, both are "Legal (removed)".
    await bringInKickoff();
    const { reading } = await store.kickoff();
    await store.saveKickoff(
      {
        transcript: `${kickoffTranscript}\nAnna (CEO): Legal ${first}.`,
        fileName: null,
        reading: {
          ...(reading ?? { fields: {}, ask: {}, teams: [] }),
          teams: [{ name: `Legal ${first}`, does: "Contracts", people: 3 }],
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
        name: `Legal ${second}`,
        sourceId: source,
      },
    ]);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Purged ${unique()}`,
      access: "everyone",
    });
    const document = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "note.md",
      text: `# Note\n${first} and ${second} were named.`,
      ifVersion: 0,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [first, second],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);
    const { teams } = await admin.api.brain.read();
    const removed = teams.filter(({ name }) => name.includes("(removed)"));

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
