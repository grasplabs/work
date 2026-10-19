import type {
  LandscapeApp,
  Source,
  Statement,
  Transcript,
  TranscriptTurn,
  Workspace,
} from "@grasp-os/shared/brain";

/**
 * A small made-up company for the brain's tests, in the shape a core adapter fills: a vision with
 * goals, six teams, their interviews and what was said in them, the tools named and the
 * applications seen, the workflows drawn and the gaps still open. Every statement is found word
 * for word in its source's transcript, as the brain expects. Not shipped: only tests import it.
 */

/** "00:30" from seconds. */
const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/** A conversation in which Grasp asks and one person answers with each statement, half a minute apart. */
const conversation = (speaker: string, said: string[]): Transcript => ({
  chapters: [{ title: "Introduction", at: "00:00" }],
  turns: said.flatMap((text, index): TranscriptTurn[] => [
    {
      at: clock(index * 60),
      speaker: "Grasp interviewer",
      text: "What takes your time?",
    },
    { at: clock(index * 60 + 30), speaker, text: `Well. ${text}.` },
  ]),
});

const statement = (
  id: string,
  kind: Statement["kind"],
  text: string,
  sourceId: string,
  teamIds: string[],
  toolIds: string[] = [],
  candidateId?: string
): Statement => ({
  id,
  kind,
  text,
  sourceId,
  teamIds,
  toolIds,
  ...(candidateId === undefined ? {} : { candidateId }),
});

const statements: Statement[] = [
  statement(
    "st-inbox",
    "timeSink",
    "About 600 emails a week land in one shared inbox, and every one is routed by hand",
    "src-service",
    ["team-service"],
    ["tool-outlook"],
    "cand-email"
  ),
  statement(
    "st-forward",
    "handover",
    "Complex questions go to an advisor by forwarding the email, and answers get lost",
    "src-service",
    ["team-service"],
    [],
    "cand-email"
  ),
  statement(
    "st-crm",
    "blocker",
    "The CRM does not show the mortgage file, so we ask by phone",
    "src-service",
    ["team-service"],
    ["tool-crm"]
  ),
  statement(
    "st-copilot",
    "tool",
    "Some of us draft replies with Microsoft Copilot",
    "src-service",
    ["team-service"],
    ["tool-copilot"]
  ),
  statement(
    "st-lenders",
    "timeSink",
    "Comparing lenders takes an hour per client in the mortgage portal",
    "src-mortgage",
    ["team-mortgage"],
    ["tool-portal"]
  ),
  statement(
    "st-complete",
    "blocker",
    "Files are often not complete when they reach us",
    "src-mortgage",
    ["team-mortgage"]
  ),
  statement(
    "st-email-mortgage",
    "timeSink",
    "Forwarded questions from customer service pile up in our mailbox",
    "src-mortgage",
    ["team-mortgage"],
    [],
    "cand-email"
  ),
  statement(
    "st-handover-mortgage",
    "handover",
    "We hand the signed file to client onboarding by email",
    "src-mortgage",
    ["team-mortgage", "team-onboarding"],
    [],
    "cand-file-handover"
  ),
  statement(
    "st-approvals",
    "timeSink",
    "Approvals for supplier invoices are chased by email",
    "src-finance",
    ["team-finance"],
    [],
    "cand-invoices"
  ),
  statement(
    "st-vat",
    "timeSink",
    "VAT codes are checked by hand in Exact Online",
    "src-finance",
    ["team-finance"],
    ["tool-exact"],
    "cand-invoices"
  ),
  statement(
    "st-report",
    "timeSink",
    "The weekly management report is copied by hand into a spreadsheet",
    "src-finance",
    ["team-finance"],
    ["tool-excel", "tool-word", "tool-exact", "tool-crm"],
    "cand-report"
  ),
  statement(
    "st-monday",
    "goal",
    "We want the numbers ready on Monday",
    "src-finance",
    ["team-finance"]
  ),
  statement(
    "st-attachments",
    "wish",
    "I wish invoices did not arrive in Outlook as attachments",
    "src-finance",
    ["team-finance"]
  ),
  statement(
    "st-complaints",
    "timeSink",
    "Complaints are registered by hand in a spreadsheet",
    "src-compliance",
    ["team-compliance"],
    [],
    "cand-complaints"
  ),
  statement(
    "st-allowed",
    "rule",
    "Client data may not leave the EU",
    "src-compliance",
    ["team-compliance"]
  ),
  statement(
    "st-procedure",
    "rule",
    "Every complaint is answered within ten working days",
    "src-procedure",
    ["team-compliance"]
  ),
  statement(
    "st-check",
    "timeSink",
    "Checking ID and income documents takes most of the day",
    "src-onboarding",
    ["team-onboarding"],
    [],
    "cand-onboarding"
  ),
  statement(
    "st-handover-onboarding",
    "handover",
    "The signed file comes from mortgage advice by email and we retype it",
    "src-onboarding",
    ["team-onboarding", "team-mortgage"],
    [],
    "cand-file-handover"
  ),
  statement(
    "st-sorting",
    "timeSink",
    "Sorting the shared inbox takes my first hour every day",
    "src-employee-01",
    ["team-service"],
    ["tool-outlook"],
    "cand-email"
  ),
  statement(
    "st-rates",
    "timeSink",
    "Rates change before the advice is written down",
    "src-employee-mortgage-1",
    ["team-mortgage"]
  ),
  statement(
    "st-matching",
    "timeSink",
    "Matching invoices to orders takes hours each week",
    "src-employee-fa1",
    ["team-finance"],
    [],
    "cand-invoices"
  ),
  statement(
    "st-reminder",
    "wish",
    "A reminder for late approvals would help",
    "src-employee-fa2",
    ["team-finance"]
  ),
  statement(
    "st-supplier-data",
    "blocker",
    "Supplier data in Exact Online is often out of date",
    "src-employee-bk1",
    ["team-finance"],
    ["tool-exact"]
  ),
  statement(
    "st-approvals-still",
    "timeSink",
    "Approvals for supplier invoices are still chased by email",
    "src-agent-finance",
    ["team-finance"],
    [],
    "cand-invoices"
  ),
];

const textsOf = (sourceId: string): string[] =>
  statements
    .filter((each) => each.sourceId === sourceId)
    .map((each) => each.text);

/** A stakeholder's interview, transcribed. */
const stakeholderInterview = (
  id: string,
  teamId: string,
  title: string,
  who: string,
  how: string,
  date: string
): Source => ({
  id,
  kind: "interview",
  title,
  date,
  who,
  how,
  step: 2,
  interviewee: "stakeholder",
  teamIds: [teamId],
  transcript: conversation(who, textsOf(id)),
});

/** An employee's chat interview: "Chat interview: Service desk 3". */
const employeeInterview = (
  id: string,
  teamId: string,
  who: string,
  number: number,
  date: string
): Source => ({
  id,
  kind: "interview",
  title: `Chat interview: ${who} ${number}`,
  date,
  who,
  how: "Chat interview",
  step: 2,
  interviewee: "employee",
  teamIds: [teamId],
  transcript: conversation(who, [
    ...textsOf(id),
    "Most of my week is the same work",
  ]),
});

/** The employees interviewed besides the stakeholders: more than a folder shows as one neuron each. */
const employees: Source[] = [
  ...Array.from({ length: 8 }, (_, index) =>
    employeeInterview(
      `src-employee-${String(index + 1).padStart(2, "0")}`,
      "team-service",
      "Service desk",
      index + 1,
      `2026-09-0${2 + (index % 3)}`
    )
  ),
  ...Array.from({ length: 6 }, (_, index) =>
    employeeInterview(
      `src-employee-mortgage-${index + 1}`,
      "team-mortgage",
      "Mortgage advisor",
      index + 1,
      "2026-09-05"
    )
  ),
  employeeInterview(
    "src-employee-fa1",
    "team-finance",
    "Finance assistant",
    1,
    "2026-09-03"
  ),
  employeeInterview(
    "src-employee-fa2",
    "team-finance",
    "Finance assistant",
    2,
    "2026-09-04"
  ),
  employeeInterview(
    "src-employee-bk1",
    "team-finance",
    "Bookkeeper",
    1,
    "2026-09-06"
  ),
  ...Array.from({ length: 5 }, (_, index) =>
    employeeInterview(
      `src-employee-onboarding-${index + 1}`,
      "team-onboarding",
      "Onboarding officer",
      index + 1,
      "2026-09-07"
    )
  ),
];

const visionTranscript: Transcript = {
  chapters: [{ title: "Where the company stands", at: "00:00" }],
  turns: [
    {
      at: "00:00",
      speaker: "Grasp consultant",
      text: "Where should AI help first?",
    },
    { at: "00:40", speaker: "CEO", text: "Customer service, without a doubt." },
    {
      at: "01:30",
      speaker: "COO",
      text: "And the files mortgage advice sends.",
    },
    { at: "02:10", speaker: "CFO", text: "As long as the numbers come in." },
    { at: "02:50", speaker: "CEO", text: "We approve tools together." },
  ],
};

const complianceTranscript: Transcript = {
  chapters: [
    { title: "How complaints come in", at: "00:00" },
    { title: "What may not happen", at: "01:30" },
  ],
  turns: [
    {
      at: "00:00",
      speaker: "Grasp voice agent",
      text: "How do complaints come in?",
    },
    {
      at: "00:20",
      speaker: "Head of compliance",
      text: "Complaints are registered by hand in a spreadsheet, every one.",
    },
    {
      at: "01:30",
      speaker: "Grasp voice agent",
      text: "Which rules does your team keep?",
    },
    {
      at: "01:51",
      speaker: "Head of compliance",
      text: "Above all: client data may not leave the EU.",
    },
    { at: "02:30", speaker: "Grasp voice agent", text: "Thank you." },
  ],
};

const procedureTranscript: Transcript = {
  unit: "passage",
  chapters: [{ title: "Scope", at: "1" }],
  turns: [
    {
      at: "1",
      speaker: "Scope",
      text: "This procedure covers every complaint by a client.",
    },
    {
      at: "2",
      speaker: "Answering",
      text: "Every complaint is answered within ten working days.",
    },
  ],
};

const sources: Source[] = [
  {
    id: "src-desk",
    kind: "document",
    title: "Desk research: website, vacancies and news",
    date: "2026-08-18",
    who: "Grasp",
    how: "Desk research",
    step: 1,
  },
  {
    id: "src-directory",
    kind: "import",
    connection: "directory",
    title: "Microsoft 365 directory",
    date: "2026-08-20",
    who: "IT admin",
    how: "OAuth",
    step: 2,
  },
  {
    id: "src-sso",
    kind: "import",
    connection: "signIn",
    title: "Microsoft sign-in",
    date: "2026-08-21",
    who: "IT admin",
    how: "OAuth",
    step: 2,
  },
  {
    id: "src-pulse",
    kind: "import",
    connection: "pulse",
    title: "Pulse on company laptops",
    date: "2026-08-22",
    who: "IT admin",
    how: "Pulse",
    step: 2,
  },
  {
    id: "src-vision",
    kind: "interview",
    title: "Vision conversation with the board",
    date: "2026-08-25",
    who: "CEO, COO and CFO",
    how: "Live",
    step: 1,
    transcript: visionTranscript,
  },
  stakeholderInterview(
    "src-service",
    "team-service",
    "Interview with customer service",
    "Head of customer service",
    "Live",
    "2026-08-26"
  ),
  stakeholderInterview(
    "src-mortgage",
    "team-mortgage",
    "Interview with mortgage advice",
    "Team lead mortgage advice",
    "Voice agent",
    "2026-08-27"
  ),
  stakeholderInterview(
    "src-finance",
    "team-finance",
    "Interview with finance",
    "Controller",
    "Live",
    "2026-08-28"
  ),
  {
    id: "src-compliance",
    kind: "interview",
    title: "Interview with compliance",
    date: "2026-08-29",
    who: "Head of compliance",
    how: "Voice agent",
    step: 2,
    interviewee: "stakeholder",
    teamIds: ["team-compliance"],
    article: [
      "Complaints are registered by hand, in a spreadsheet the team keeps.",
      "Client data may not leave the EU, whatever tool is used.",
    ],
    transcript: complianceTranscript,
  },
  {
    id: "src-procedure",
    kind: "document",
    title: "Complaints procedure",
    date: "2026-08-30",
    who: "Head of compliance",
    how: "Upload",
    step: 2,
    transcript: procedureTranscript,
  },
  stakeholderInterview(
    "src-onboarding",
    "team-onboarding",
    "Interview with client onboarding",
    "Team lead client onboarding",
    "Live",
    "2026-09-01"
  ),
  ...employees,
  stakeholderInterview(
    "src-revenue",
    "team-revenue",
    "Interview with revenue",
    "Head of revenue",
    "Live",
    "2026-09-02"
  ),
  {
    id: "src-ai-policy",
    kind: "document",
    title: "AI policy draft",
    date: "2026-09-03",
    who: "COO",
    how: "Upload",
    step: 2,
    policyId: "policy-ai-data",
  },
  {
    id: "src-tools-decision",
    kind: "document",
    title: "Decision on approved AI tools",
    date: "2026-09-18",
    who: "COO",
    how: "Email",
    step: 2,
  },
  {
    id: "src-crm",
    kind: "import",
    title: "CRM export",
    date: "2026-09-12",
    how: "Export",
    step: 3,
  },
  {
    id: "src-agent-finance",
    kind: "chat",
    title: "Conversation with the Grasp agent, finance",
    date: "2026-09-20",
    who: "Finance assistant",
    how: "Chat in Grasp",
    step: 5,
    transcript: conversation("Finance assistant", textsOf("src-agent-finance")),
  },
  {
    id: "src-runlog",
    kind: "runLog",
    title: "Run log, client onboarding",
    date: "2026-09-21",
    how: "Run log",
    step: 5,
  },
  {
    id: "src-directory-refresh",
    kind: "import",
    connection: "directory",
    title: "Microsoft 365 directory, monthly refresh",
    date: "2026-09-22",
    who: "IT admin",
    how: "OAuth",
    step: 2,
  },
  {
    id: "src-board-checkin",
    kind: "interview",
    title: "Monthly check-in with the board",
    date: "2026-09-23",
    who: "CEO and CFO",
    how: "Live",
    step: 5,
  },
];

/** Applications only Pulse saw, none with AI, so ChatGPT stays the AI tool most used that nobody named. */
const extraApps: LandscapeApp[] = Array.from({ length: 13 }, (_, index) => ({
  id: `extra-${index + 1}`,
  name: `Extra app ${index + 1}`,
  vendor: "Vendor",
  category: "Utility",
  ai: "none",
  people: 3 + index,
  seenThrough: ["pulse"],
  owner: index % 2 === 0 ? null : "IT",
  matches: [],
  permissions: [],
}));

/** The company the brain's tests read. */
export const testWorkspace = (): Workspace => ({
  company: { name: "Example Bank", sector: "Retail banking", people: 180 },
  vision: {
    ambition:
      "Every client gets a clear answer within a working day, and advisors spend their time on advice.",
    whyNow: "Client numbers grew by a third without new hires.",
    inviteTeamIds: [
      "team-service",
      "team-mortgage",
      "team-finance",
      "team-compliance",
      "team-onboarding",
    ],
    budget: [],
    toolApproval: [
      {
        text: "The COO, after a check by IT. Anything that costs money goes past the CFO as well.",
        sourceId: "src-vision",
        date: "2026-08-25",
      },
    ],
    sourceId: "src-vision",
    version: 1,
    confirmedBy: "CEO",
    confirmedAt: "2026-08-26",
  },
  goals: [
    {
      id: "goal-answer",
      versions: [
        {
          title: "Every client gets an answer within a working day",
          howWeNotice: "Fewer reminders from clients",
          sourceId: "src-vision",
          date: "2026-08-25",
        },
      ],
    },
    {
      id: "goal-numbers",
      versions: [
        {
          title: "The board sees this week’s numbers on Monday morning",
          howWeNotice: "The report is in the mailbox before the board meets",
          sourceId: "src-vision",
          date: "2026-08-25",
        },
        {
          title: "The board sees this week’s numbers by 9:00 on Monday",
          howWeNotice: "The report is in the mailbox by 9:00",
          sourceId: "src-board-checkin",
          date: "2026-09-23",
        },
      ],
    },
    {
      id: "goal-advice",
      versions: [
        {
          title: "Advisors spend most of their time on advice",
          howWeNotice: "",
          sourceId: "src-vision",
          date: "2026-08-25",
        },
      ],
    },
  ],
  teams: [
    {
      id: "team-service",
      name: "Customer service",
      sourceId: "src-desk",
      counts: [
        { sourceId: "src-desk", date: "2026-08-18", people: 12 },
        {
          sourceId: "src-directory",
          date: "2026-08-20",
          people: 14,
          roles: [
            { name: "Head of customer service", people: 1 },
            { name: "Service desk", people: 13 },
          ],
        },
        {
          sourceId: "src-directory-refresh",
          date: "2026-09-22",
          people: 15,
          roles: [
            { name: "Head of customer service", people: 1 },
            { name: "Service desk", people: 14 },
          ],
        },
      ],
      stakeholders: [
        {
          role: "Head of customer service",
          sourceId: "src-vision",
          date: "2026-08-25",
          invitedAt: "2026-08-25",
        },
      ],
    },
    {
      id: "team-mortgage",
      name: "Mortgage advice",
      sourceId: "src-directory",
      counts: [{ sourceId: "src-directory", date: "2026-08-20", people: 9 }],
      stakeholders: [
        {
          role: "Team lead mortgage advice",
          sourceId: "src-vision",
          date: "2026-08-25",
          invitedAt: "2026-08-25",
        },
      ],
    },
    {
      id: "team-finance",
      name: "Finance",
      sourceId: "src-directory",
      counts: [{ sourceId: "src-directory", date: "2026-08-20", people: 6 }],
      stakeholders: [
        {
          role: "Controller",
          sourceId: "src-vision",
          date: "2026-08-25",
          invitedAt: "2026-08-26",
        },
      ],
    },
    {
      id: "team-compliance",
      name: "Compliance",
      sourceId: "src-directory",
      counts: [{ sourceId: "src-directory", date: "2026-08-20", people: 4 }],
      stakeholders: [
        {
          role: "Head of compliance",
          sourceId: "src-vision",
          date: "2026-08-25",
          invitedAt: "2026-08-29",
        },
      ],
    },
    {
      id: "team-onboarding",
      name: "Client onboarding",
      sourceId: "src-directory",
      counts: [{ sourceId: "src-directory", date: "2026-08-20", people: 7 }],
      stakeholders: [
        {
          role: "Team lead client onboarding",
          sourceId: "src-vision",
          date: "2026-08-25",
          invitedAt: "2026-08-27",
        },
      ],
    },
    {
      id: "team-revenue",
      name: "Revenue",
      sourceId: "src-directory",
      counts: [{ sourceId: "src-directory", date: "2026-08-20", people: null }],
      stakeholders: [],
    },
  ],
  tools: [
    {
      id: "tool-outlook",
      name: "Outlook",
      teamIds: ["team-service"],
      sourceId: "src-service",
    },
    {
      id: "tool-crm",
      name: "CRM",
      teamIds: ["team-service"],
      sourceId: "src-service",
    },
    {
      id: "tool-copilot",
      name: "Microsoft Copilot",
      teamIds: ["team-service"],
      sourceId: "src-service",
    },
    {
      id: "tool-portal",
      name: "Mortgage portal",
      teamIds: ["team-mortgage"],
      sourceId: "src-mortgage",
    },
    {
      id: "tool-excel",
      name: "Excel",
      teamIds: ["team-finance"],
      sourceId: "src-finance",
    },
    {
      id: "tool-word",
      name: "Word",
      teamIds: ["team-finance"],
      sourceId: "src-finance",
    },
    {
      id: "tool-exact",
      name: "Exact Online",
      teamIds: ["team-finance"],
      sourceId: "src-finance",
    },
  ],
  sources,
  statements,
  candidates: [
    { id: "cand-email", name: "Email triage", workflowId: "email-triage" },
    { id: "cand-invoices", name: "Supplier invoice approval" },
    { id: "cand-report", name: "Weekly management report" },
    { id: "cand-complaints", name: "Complaint registration" },
    {
      id: "cand-file-handover",
      name: "Handing a signed mortgage file from advice to client onboarding without retyping it",
    },
    {
      id: "cand-onboarding",
      name: "Client onboarding checks",
      workflowId: "client-onboarding",
    },
  ],
  gaps: [
    {
      id: "gap-budget",
      question: "What is the monthly budget for AI?",
      owner: "CFO",
      sourceId: "src-vision",
      about: ["vision"],
    },
    {
      id: "gap-complaints-volume",
      question: "How many complaints come in each month?",
      owner: "Head of compliance",
      sourceId: "src-compliance",
      about: ["team-compliance", "cand-complaints"],
    },
    {
      id: "gap-forwarding",
      question: "Who answers a forwarded question?",
      owner: "Team lead mortgage advice",
      sourceId: "src-service",
      about: ["st-forward"],
    },
    {
      id: "gap-chatgpt",
      question: "Who allowed ChatGPT?",
      owner: "Head of IT",
      sourceId: "src-pulse",
      about: ["app-chatgpt"],
    },
    {
      id: "gap-invoice-limit",
      question: "Above what amount does the CFO approve an invoice?",
      owner: "CFO",
      sourceId: "src-finance",
      about: ["cand-invoices", "email-triage"],
      closedAt: "2026-09-15",
      answer: "Above €10,000",
      answeredBy: "CFO",
    },
  ],
  workflows: [
    {
      id: "email-triage",
      name: "Email triage",
      teamId: "team-service",
      processId: "r2c",
      status: "drawn",
      baseline: {
        steps: [
          { tool: "Outlook" },
          { tool: "CRM", split: { paths: [{ steps: [{ tool: "Excel" }] }] } },
        ],
        confirmedBy: "Head of customer service",
        confirmedAt: "2026-09-10",
      },
    },
    {
      id: "client-onboarding",
      name: "Client onboarding",
      teamId: "team-onboarding",
      goalId: "goal-answer",
      processId: "o2c",
      status: "running",
      baseline: {
        steps: [{ tool: "Onboarding portal" }],
        confirmedBy: "Team lead client onboarding",
        confirmedAt: "2026-09-05",
      },
      target: {
        steps: [{ tool: "Onboarding portal" }],
        confirmedBy: "Team lead client onboarding",
        confirmedAt: "2026-09-12",
      },
      results: [{ period: { from: "2026-09-20" } }],
    },
  ],
  connections: [
    {
      name: "Microsoft 365",
      logo: "microsoft-365.svg",
      status: "connected",
      via: "direct",
      matches: ["Outlook", "Excel", "Word", "Teams"],
    },
    {
      name: "Salesforce",
      logo: "salesforce.svg",
      status: "available",
      via: "composio",
      matches: ["CRM"],
    },
  ],
  landscape: [
    {
      id: "microsoft-365",
      name: "Microsoft 365",
      vendor: "Microsoft",
      category: "Office suite",
      logoSrc: "/v1/logos/microsoft-365.svg",
      ai: "builtIn",
      people: 38,
      seenThrough: ["microsoftSso", "pulse"],
      owner: "IT",
      matches: ["Outlook", "Excel", "Word"],
      permissions: ["Read and send mail"],
    },
    {
      id: "salesforce",
      name: "Salesforce",
      vendor: "Salesforce",
      category: "CRM",
      logoSrc: "",
      ai: "builtIn",
      people: 15,
      seenThrough: ["microsoftSso"],
      owner: "Customer service",
      matches: ["CRM"],
      permissions: ["Read contacts"],
    },
    {
      id: "copilot",
      name: "Microsoft Copilot",
      vendor: "Microsoft",
      category: "Chat assistant",
      ai: "tool",
      people: 20,
      seenThrough: ["pulse"],
      owner: "IT",
      matches: [],
      permissions: [],
    },
    {
      id: "exact",
      name: "Exact Online",
      vendor: "Exact",
      category: "Accounting",
      ai: "none",
      people: 6,
      seenThrough: ["microsoftSso"],
      owner: "Finance",
      matches: [],
      permissions: ["Read invoices"],
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      vendor: "OpenAI",
      category: "Chat assistant",
      logoSrc: "/v1/logos/chatgpt.png",
      ai: "tool",
      people: 47,
      seenThrough: ["pulse"],
      owner: "Revenue",
      matches: [],
      permissions: [],
    },
    ...extraApps,
  ],
  policies: [
    {
      id: "policy-ai-data",
      title: "AI and data guideline",
      uploadedAt: "2026-09-05T10:12",
      status: "published",
      summary: "What AI tools may do with client data.",
      proposals: [
        {
          excerpt: "Client data stays in the EU.",
          decision: "accepted",
        },
        {
          excerpt: "A new AI tool is approved by the COO.",
          decision: "open",
        },
      ],
      unchecked: [{ excerpt: "Staff are trained once a year." }],
      publishedAt: "2026-09-08T09:00",
    },
  ],
});
