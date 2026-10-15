import { describe, expect, it } from "vite-plus/test";

import {
  buildBrain,
  folderTree,
  mentionParts,
  patterns,
  sourceContents,
  splitTimeline,
  unmentionedApps,
} from "./brain.ts";
import type { Folder, Note, NoteEvent } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";
import type { Workspace } from "./workspace.ts";

// The prototype's tests of the brain, on a small made-up company
// (test-workspace.ts) in place of the prototype's mock data: the same
// assertions, with its counts and dates where the company differs.

const words = (note: Note, label: string) =>
  note.points
    .find((point) => point.label === label)
    ?.refs.map((ref) => ref.label)
    .join(", ");

const noteIn = (workspace: Workspace, id: string): Note => {
  const found = buildBrain(workspace).notes.find(
    (candidate) => candidate.id === id
  );
  if (!found) {
    throw new Error(`No note ${id}`);
  }
  return found;
};

const folderIn = (folders: Folder[], key: string): Folder => {
  const found = folders.find((folder) => folder.key === key);
  if (!found) {
    throw new Error(`No folder ${key}`);
  }
  return found;
};

describe(buildBrain, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const note = (id: string) => noteIn(ws, id);

  it("files notes in the folders of steps 1 and 2", () => {
    expect(
      Object.fromEntries(
        ["vision", "goal-answer", "app-chatgpt", "src-vision"].map((id) => [
          id,
          note(id).path,
        ])
      )
    ).toStrictEqual({
      vision: ["1 Vision"],
      "goal-answer": ["1 Vision", "Goals"],
      "app-chatgpt": ["2 Inventory", "Tools", "Seen, never mentioned"],
      "src-vision": ["Sources", "Conversations", "With the board"],
    });

    const root = folderTree(brain.notes);
    expect(root.notes.map((candidate) => candidate.id)).toStrictEqual([
      "company",
    ]);
    expect(root.folders.map((folder) => folder.name)).toStrictEqual([
      "1 Vision",
      "2 Inventory",
      "Sources",
    ]);
  });

  it("keeps what an import brought in on its source, so it holds the context the other notes come from", () => {
    const directory = sourceContents(ws, "src-directory");
    expect(
      directory?.kind === "teams" && directory.rows.map((row) => row.teamId)
    ).toContain("team-service");
    const refresh = sourceContents(ws, "src-directory-refresh");
    const service =
      refresh?.kind === "teams"
        ? refresh.rows.find((row) => row.teamId === "team-service")
        : undefined;
    expect({ people: service?.people, before: service?.before }).toStrictEqual({
      people: 15,
      before: 14,
    });
    expect(refresh?.kind === "teams" && refresh.rows).toHaveLength(6);
    expect(sourceContents(ws, "src-vision")).toBeUndefined();
  });

  it("keeps the applications sign-in and Pulse saw on their sources, each with its note", () => {
    const pulse = sourceContents(ws, "src-pulse");
    expect(pulse?.kind === "apps" && pulse.signIn).toBeFalsy();
    expect(
      pulse?.kind === "apps" &&
        pulse.rows.find((row) => row.app.name === "ChatGPT")
    ).toMatchObject({ noteId: "app-chatgpt", named: false });
    const signIn = sourceContents(ws, "src-sso");
    expect(signIn?.kind === "apps" && signIn.signIn).toBeTruthy();
    expect(
      signIn?.kind === "apps" &&
        signIn.rows.every((row) => row.app.permissions.length > 0)
    ).toBeTruthy();
    expect(words(note("src-pulse"), "Added")).toMatch(/^\d+ applications$/u);
  });

  it("files the policies uploaded to Policies as documents, linked to Policies and to the draft they came from", () => {
    const policy = note("policy-ai-data");
    expect(policy.path).toStrictEqual(["Sources", "Documents"]);
    expect(
      policy.points.find((point) => point.label === "In Policies")?.refs[0]
    ).toMatchObject({ policyId: "policy-ai-data" });
    expect(policy.article?.length).toBeGreaterThan(1);
    expect(words(note("src-ai-policy"), "Became")).toBe(
      "AI and data guideline"
    );
    expect(note("policy-ai-data").backlinks).toContain("src-ai-policy");
  });

  it("files sources by the way they were collected, in a fixed order", () => {
    expect(
      Object.fromEntries(
        [
          "src-employee-01",
          "src-service",
          "src-pulse",
          "src-desk",
          "src-directory",
        ].map((id) => [id, note(id).path])
      )
    ).toStrictEqual({
      "src-employee-01": ["Sources", "Conversations", "Employee interviews"],
      "src-service": ["Sources", "Conversations", "Stakeholder interviews"],
      "src-pulse": ["Sources", "Pulse"],
      "src-desk": ["Sources", "Documents"],
      "src-directory": ["Sources", "Connections"],
    });
    expect(note("src-employee-01").summary).toMatch(
      /^Service desk · Chat interview/u
    );
    // Under Conversations only folders, so nothing hides below an open one.
    const sources = folderIn(folderTree(brain.notes).folders, "Sources");
    const conversations = folderIn(sources.folders, "Sources/Conversations");
    expect(conversations.notes).toStrictEqual([]);
    expect(conversations.folders.map((folder) => folder.name)).toStrictEqual([
      "With the board",
      "Stakeholder interviews",
      "Employee interviews",
      "Chats with Grasp",
    ]);
    expect(sources.folders.map((folder) => folder.key)).toStrictEqual([
      "Sources/Conversations",
      "Sources/Pulse",
      "Sources/Documents",
      "Sources/Connections",
    ]);
  });

  it("keeps statements out of the notes: each is a highlight in the source it was said in", () => {
    expect(
      brain.notes.some((candidate) => candidate.kind === "statement")
    ).toBeFalsy();
    const inventory = folderTree(brain.notes).folders.find(
      (folder) => folder.name === "2 Inventory"
    );
    expect(inventory?.folders.map((folder) => folder.name)).not.toContain(
      "Statements"
    );
    expect(note("src-mortgage").statementIds).toStrictEqual(
      expect.arrayContaining(["st-lenders", "st-complete"])
    );
  });

  it("makes the Vision page the 1 Vision folder itself, not a note inside it", () => {
    const [visionFolder] = folderTree(brain.notes).folders;
    expect(visionFolder?.note?.id).toBe("vision");
    expect(visionFolder?.notes.map((candidate) => candidate.id)).not.toContain(
      "vision"
    );
    expect(visionFolder?.folders.map((folder) => folder.name)).toStrictEqual([
      "Goals",
    ]);
  });

  it("leaves workflows and their exports and run logs to the Workflows page", () => {
    const ids = brain.notes.map((candidate) => candidate.id);
    for (const id of [
      "client-onboarding",
      "email-triage",
      "src-crm",
      "src-runlog",
    ]) {
      expect(ids).not.toContain(id);
    }
    expect(brain.notes.every((candidate) => candidate.step <= 2)).toBeTruthy();
  });

  it("never ranks or scores", () => {
    for (const candidate of brain.notes) {
      expect(candidate.tags).not.toContain("top-3");
      const text = [
        candidate.summary,
        ...candidate.points.flatMap((point) => [
          point.label,
          ...point.refs.map((ref) => ref.label),
        ]),
      ].join(" ");
      expect(text).not.toMatch(/\b(?:rank|score)/iu);
    }
    expect(patterns(ws).join(" ")).not.toMatch(/ranks first|hurts most/u);
  });

  it("only links to notes that exist, from links, points, side panel and timeline alike", () => {
    const ids = new Set(brain.notes.map((each) => each.id));
    const dangling = brain.notes.flatMap((each) =>
      [
        ...each.links,
        ...each.backlinks,
        ...each.points.flatMap((point) =>
          point.refs.flatMap((ref) => (ref.to === undefined ? [] : [ref.to]))
        ),
        ...each.linked.flatMap((group) =>
          group.refs.flatMap((ref) => (ref.to === undefined ? [] : [ref.to]))
        ),
        ...each.timeline.flatMap((entry) =>
          entry.to === undefined ? [] : [entry.to]
        ),
      ]
        .filter((id) => !ids.has(id))
        .map((id) => `${each.id} → ${id}`)
    );
    expect(dangling).toStrictEqual([]);
  });

  it("opens every note with one sentence and a few short points, per kind", () => {
    const team = note("team-service");
    const app = note("app-chatgpt");
    const candidate = note("cand-email");
    expect({
      team: team.summary,
      teamUses: words(team, "They use"),
      app: app.summary,
      appOwner: words(app, "Owner"),
      candidateTeams: words(candidate, "Teams"),
    }).toStrictEqual({
      team: "15 people, 9 interviewed: the head of customer service and 8 employees. Heard in 2 conversations.",
      teamUses: "Outlook, CRM, Microsoft Copilot",
      app: "47 people use it, seen through Pulse. No team has named it yet.",
      appOwner: "Revenue",
      candidateTeams: "Customer service, Mortgage advice",
    });
    expect(
      candidate.points.find((point) => point.label === "In Workflows")?.refs
    ).toStrictEqual([
      { label: "Drawn as a workflow", workflowId: "email-triage" },
    ]);

    for (const each of brain.notes) {
      expect(each.summary.length).toBeGreaterThan(0);
      expect(each.points.length).toBeLessThanOrEqual(5);
    }
  });

  it("keeps a timeline of when each fact came in, oldest first", () => {
    const { timeline } = note("cand-email");
    expect(timeline.map((entry) => entry.date)).toStrictEqual(
      timeline.map((entry) => entry.date).toSorted()
    );
    expect(timeline.at(-1)).toMatchObject({
      date: "2026-09-10",
      workflowId: "email-triage",
    });
    expect(timeline.flatMap((entry) => entry.quotes)).toContainEqual(
      expect.objectContaining({
        statementId: "st-inbox",
        sourceId: "src-service",
      })
    );
    expect(note("vision").open).toStrictEqual(["Budget for AI set"]);
  });

  it("shows sources first in the side panel, then linked notes and the drawn workflows", () => {
    const { linked } = note("cand-email");
    expect(linked[0]?.title).toBe("Sources");
    expect(linked[0]?.refs).toContainEqual({
      label: "Interview with customer service",
      to: "src-service",
    });
    expect(linked.map((group) => group.title)).toStrictEqual(
      expect.arrayContaining(["Teams", "On the Workflows page"])
    );
  });

  it("finds statements that name a note without linking to it", () => {
    const outlook = note("tool-outlook");
    expect(outlook.mentions.length).toBeGreaterThan(0);
    for (const mention of outlook.mentions) {
      expect(outlook.statementIds).not.toContain(mention.statementId);
    }
  });

  it("links a source straight to what its statements are about, with backlinks both ways", () => {
    expect(note("src-service").links).toStrictEqual(
      expect.arrayContaining(["team-service", "tool-outlook", "cand-email"])
    );
    expect(note("team-service").backlinks).toContain("src-service");
    expect(note("cand-email").backlinks).toContain("src-service");
    for (const id of ["team-service", "cand-email", "tool-outlook"]) {
      expect(note(id).statementIds).toContain("st-inbox");
    }
  });

  it("points at a statement where it was said, as the source and the statement", () => {
    const about = note("gap-forwarding")
      .points.flatMap((point) => point.refs)
      .find((ref) => ref.statement !== undefined);
    expect(about).toStrictEqual({
      label:
        "“Complex questions go to an advisor by forwarding the email, and answers get lost”",
      to: "src-service",
      statement: "st-forward",
    });
    expect(note("gap-forwarding").statementIds).toStrictEqual(["st-forward"]);
    for (const each of brain.notes) {
      for (const target of each.links) {
        expect(target.startsWith("st-")).toBeFalsy();
      }
    }
  });
});

describe("the inventory", () => {
  const ws = testWorkspace();

  it("gives each source folder a page of what it holds, and leaves consent to the service agreement", () => {
    // Like the Vision page is its folder: what this way of collecting adds, and what came in. Who agreed is not the brain's business.
    const conversations = noteIn(ws, "sources-conversations");
    expect(conversations.path).toStrictEqual(["Sources", "Conversations"]);
    expect(
      folderTree(buildBrain(ws).notes).folders.find(
        (folder) => folder.key === "Sources"
      )?.folders[0]?.note?.id
    ).toBe("sources-conversations");
    expect({
      points: conversations.points,
      open: conversations.open,
    }).toStrictEqual({ points: [], open: [] });
    expect(conversations.timeline.map((entry) => entry.to)).toContain(
      "src-vision"
    );
    expect(
      buildBrain(ws).notes.some((candidate) =>
        candidate.path.includes("Access and consent")
      )
    ).toBeFalsy();
  });

  it("says how many gaps are still open, and nothing under Added for a document without statements", () => {
    expect(words(noteIn(ws, "company"), "Still open")).toMatch(/^\d+ gaps?$/u);
    // A document without statements says nothing under "Added"; its text speaks for itself.
    expect(
      noteIn(ws, "src-ai-policy").points.map((point) => point.label)
    ).not.toContain("Added");
  });

  it("counts a team as interviewed only when a source speaks for it, not when others mention it", () => {
    expect(words(noteIn(ws, "company"), "Interviews")).toBe(
      "Stakeholders of 5 of 5 invited teams, 22 employees interviewed"
    );
    expect(words(noteIn(ws, "team-mortgage"), "Interviewed")).toBe(
      "Team lead mortgage advice, interviewed Aug 27, 2026 (voice agent)"
    );
    expect(noteIn(ws, "team-mortgage").summary).toMatch(
      /, 7 interviewed: the team lead mortgage advice and 6 employees\. /u
    );
  });

  it("counts a team whose stakeholder no source speaks for as not interviewed yet", () => {
    const notYet = {
      ...ws,
      sources: ws.sources.map((source) =>
        source.id === "src-compliance" ? { ...source, teamIds: [] } : source
      ),
    };
    const compliance = noteIn(notYet, "team-compliance");
    expect({
      notInterviewed: compliance.tags.includes("not-interviewed"),
      open: compliance.open,
    }).toStrictEqual({
      notInterviewed: true,
      open: ["Interviewed: the head of compliance"],
    });
    expect(words(compliance, "Interviewed")).toMatch(
      /^Head of compliance, invited Aug 29, 2026, not interviewed yet/u
    );
    expect(words(noteIn(notYet, "company"), "Interviews")).toMatch(
      /^Stakeholders of 4 of 5 invited teams/u
    );
    expect(patterns(notYet)).toContain(
      "1 invited team not interviewed yet: Compliance."
    );
  });

  it("keeps an interview as an article on its source, and roles on its team", () => {
    const interview = noteIn(ws, "src-compliance");
    expect(interview.path).toStrictEqual([
      "Sources",
      "Conversations",
      "Stakeholder interviews",
    ]);
    expect(interview.article?.[0]).toMatch(
      /^Complaints are registered by hand/u
    );
    expect(interview.tags).toContain("article");
    expect(words(noteIn(ws, "team-service"), "Roles")).toBe(
      "Head of customer service (1), Service desk (14)"
    );
  });

  it("links tools to the workflows they come up in, and says whether they are AI", () => {
    const excel = noteIn(ws, "tool-excel");
    expect(words(excel, "Workflows")).toContain("Weekly management report");
    expect(excel.links).toContain("cand-report");
    expect(words(noteIn(ws, "cand-report"), "Tools")).toBe(
      "Excel, Word, Exact Online, CRM"
    );
  });

  it("says whether a tool is AI, and who says so", () => {
    const unseen = {
      id: "tool-checklist",
      name: "Paper checklist",
      teamIds: ["team-onboarding"],
      sourceId: "src-onboarding",
    };
    expect({
      seen: words(noteIn(ws, "tool-copilot"), "AI"),
      unknown: words(
        noteIn({ ...ws, tools: [...ws.tools, unseen] }, "tool-checklist"),
        "AI"
      ),
      said: words(
        noteIn(
          { ...ws, tools: [...ws.tools, { ...unseen, ai: "none" as const }] },
          "tool-checklist"
        ),
        "AI"
      ),
    }).toStrictEqual({
      seen: "An AI tool, as Grasp sees it",
      unknown: "Unknown",
      said: "No AI, as the team said it",
    });
  });

  it("keeps a goal a team names as a statement in its source, apart from the board goals", () => {
    expect(noteIn(ws, "src-finance").statementIds).toContain("st-monday");
    expect(noteIn(ws, "goal-numbers").path).toStrictEqual([
      "1 Vision",
      "Goals",
    ]);
  });

  it("flags applications Grasp saw that nobody mentioned", () => {
    const ids = unmentionedApps(ws).map((app) => app.id);
    expect(ids).toContain("chatgpt");
    expect(ids).not.toContain("microsoft-365");
    expect(ids).not.toContain("salesforce");
  });

  it("finds patterns in the records instead of guessing them", () => {
    const found = patterns(ws);
    expect(found).toContain(
      "ChatGPT is used by 47 people, and nobody mentioned it in an interview."
    );
    expect(found).toContain(
      "Mortgage advice and Client onboarding both name the same handover, each from their own side."
    );
  });
});

describe("a living brain", () => {
  const ws = testWorkspace();

  // The board changes who approves a new tool in a later check-in: a new answer next to the old one.
  const reapproved = {
    ...ws,
    vision: {
      ...ws.vision,
      toolApproval: [
        ...ws.vision.toolApproval,
        {
          text: "The COO alone",
          sourceId: "src-board-checkin",
          date: "2026-09-23",
        },
      ],
    },
  };

  it("keeps an answer that changed, and shows the newest", () => {
    const vision = noteIn(reapproved, "vision");
    expect(words(vision, "Who approves a new tool")).toBe("The COO alone");
    expect(words(vision, "Monthly budget for AI")).toBe("Not answered yet");
    expect(
      vision.timeline.find((entry) => entry.title.startsWith("Changed"))
    ).toMatchObject({
      date: "2026-09-23",
      title: "Changed the answer to: Who approves a new tool",
      detail:
        "Was: The COO, after a check by IT. Anything that costs money goes past the CFO as well.",
    });
  });

  it("keeps an earlier team size when the directory is imported again", () => {
    const team = noteIn(ws, "team-service");
    expect(
      team.timeline.find((entry) => entry.title === "Size changed to 15")
    ).toMatchObject({ date: "2026-09-22", to: "src-directory-refresh" });
    expect(team.links).toStrictEqual(
      expect.arrayContaining(["src-directory", "src-directory-refresh"])
    );
  });

  it("keeps a new stakeholder as history", () => {
    const changed = {
      ...ws,
      teams: ws.teams.map((team) =>
        team.id === "team-finance"
          ? {
              ...team,
              stakeholders: [
                ...team.stakeholders,
                { role: "CFO", sourceId: "src-finance", date: "2026-08-28" },
              ],
            }
          : team
      ),
    };
    const finance = noteIn(changed, "team-finance");
    expect(finance.timeline.map((entry) => entry.title)).toContain(
      "Stakeholder changed to the CFO"
    );
    expect(words(finance, "Interviewed")).toMatch(/^CFO, interviewed/u);
  });

  it("keeps an adjusted goal as a new version, and shows the newest", () => {
    const goal = noteIn(ws, "goal-numbers");
    expect(goal.title).toBe(
      "The board sees this week’s numbers by 9:00 on Monday"
    );
    expect(words(goal, "Before")).toBe(
      "The board sees this week’s numbers on Monday morning"
    );
    expect(words(goal, "Set in")).toBe(
      "Vision conversation with the board, Aug 25, 2026"
    );
    expect(
      goal.timeline.find((entry) => entry.title.startsWith("Adjusted"))
    ).toMatchObject({ date: "2026-09-23", to: "src-board-checkin" });
  });

  it("keeps a statement said again later as its own highlight in its own source, and edits neither", () => {
    const invoices = noteIn(ws, "cand-invoices");
    expect(invoices.statementIds.indexOf("st-approvals")).toBeLessThan(
      invoices.statementIds.indexOf("st-approvals-still")
    );
    expect(noteIn(ws, "src-finance").statementIds).toContain("st-approvals");
    expect(noteIn(ws, "src-agent-finance").statementIds).toContain(
      "st-approvals-still"
    );
    expect(
      ws.statements.find((statement) => statement.id === "st-approvals")?.text
    ).toBe("Approvals for supplier invoices are chased by email");
  });

  it("keeps what people say after step 2 in the brain, and leaves exports to the Workflows page", () => {
    const chat = noteIn(ws, "src-agent-finance");
    expect(chat.path).toStrictEqual([
      "Sources",
      "Conversations",
      "Chats with Grasp",
    ]);
    expect(chat.step).toBe(2);
    expect(buildBrain(ws).notes.map((candidate) => candidate.id)).not.toContain(
      "src-crm"
    );
    expect(words(noteIn(ws, "cand-invoices"), "What was said")).toContain(
      "4 time wasters"
    );
    expect(noteIn(ws, "cand-invoices").statementIds).toContain("st-vat");
  });

  it("counts every team that names a tool, also in a later conversation", () => {
    const said = {
      ...ws,
      statements: [
        ...ws.statements,
        {
          id: "st-new",
          kind: "tool" as const,
          text: "We now export Exact to Excel",
          sourceId: "src-agent-finance",
          teamIds: ["team-compliance"],
          toolIds: ["tool-exact"],
        },
      ],
    };
    expect(words(noteIn(said, "tool-exact"), "Named by")).toBe(
      "Finance, Compliance"
    );
  });

  it("keeps the company and source timelines to their own events", () => {
    const company = noteIn(ws, "company");
    expect(company.timeline.length).toBeLessThan(ws.sources.length);
    expect(company.timeline.at(-1)).toMatchObject({
      title: "Every invited team interviewed",
      date: "2026-09-01",
    });
    expect(
      noteIn(ws, "src-tools-decision").timeline.map((entry) => entry.title)
    ).toStrictEqual(["Came in"]);
    expect(
      noteIn(reapproved, "src-board-checkin").timeline.map(
        (entry) => entry.title
      )
    ).toContain("Changed the answer to: Who approves a new tool");
  });
});

const day = (date: string): NoteEvent => ({
  date,
  title: date,
  quotes: [],
  own: false,
});

describe(splitTimeline, () => {
  it("leaves a short timeline whole", () => {
    const events = [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ].map(day);
    expect(splitTimeline(events)).toStrictEqual({
      earlier: [],
      recent: events,
    });
  });

  it("shows the latest events and folds the ones before by month", () => {
    const events = [
      "2026-07-30",
      "2026-08-01",
      "2026-08-20",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ].map(day);
    const { earlier, recent } = splitTimeline(events);
    expect(recent.map((entry) => entry.date)).toStrictEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(
      earlier.map((month) => [month.month, month.events.length])
    ).toStrictEqual([
      ["2026-07", 1],
      ["2026-08", 2],
    ]);
  });
});

describe(mentionParts, () => {
  const notes = [
    { id: "crm", title: "CRM" },
    { id: "team-mortgage", title: "Mortgage advice" },
    { id: "advice", title: "Advice" },
  ];

  it("links each named note once, on whole words, ignoring case, preferring the longest title", () => {
    expect(
      mentionParts(
        "Files go to mortgage advice via the CRM; the CRM is slow and CRMs differ.",
        notes
      )
    ).toStrictEqual([
      "Files go to ",
      { id: "team-mortgage", label: "mortgage advice" },
      " via the ",
      { id: "crm", label: "CRM" },
      "; the CRM is slow and CRMs differ.",
    ]);
  });

  it("leaves text whole when it names nothing, and ignores titles too short to be a name", () => {
    expect(mentionParts("HR asks for help.", notes)).toStrictEqual([
      "HR asks for help.",
    ]);
    expect(mentionParts("HR asks.", [{ id: "hr", title: "HR" }])).toStrictEqual(
      ["HR asks."]
    );
  });
});

describe("processIds", () => {
  const ws = testWorkspace();
  const note = (id: string) => noteIn(ws, id);

  it("gives tools and applications the logo the Landscape shows, else their connector’s, else none", () => {
    expect(note("app-chatgpt").logoSrc).toBe("/v1/logos/chatgpt.png");
    expect(note("tool-crm").logoSrc).toMatch(/salesforce\.svg$/u);
    expect(note("tool-portal").logoSrc).toBeUndefined();
    expect(note("team-onboarding").logoSrc).toBeUndefined();
  });

  it("gives a note the standard processes of the workflows it leads to, once each", () => {
    expect(note("team-onboarding").processIds).toStrictEqual(["o2c"]);
    expect(note("vision").processIds).toStrictEqual([]);
  });
});
