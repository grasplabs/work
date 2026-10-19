import { briefOf } from "./admin-brief.ts";
import { ADMIN_PHASES, brainOf, healthOf, phaseOf } from "./admin-health.ts";
import type { AdminPhase, HealthSignal } from "./admin-health.ts";
import { askedBy, sortBuilds, waitsOn } from "./admin-integrations.ts";
import type {
  BuildStage,
  IntegrationBuild,
  Waiter,
} from "./admin-integrations.ts";
import {
  driftOf,
  errorRateOf,
  needsOf,
  releaseOf,
  ringsOf,
  standingOf,
} from "./admin-platform.ts";
import type { Platform, Release, Rollout } from "./admin-platform.ts";
import { ADMIN_SOURCES } from "./admin-sources.ts";
import type { AdminSource } from "./admin-sources.ts";
import { byUrgency } from "./admin-view.ts";
import type { AdminView } from "./admin-view.ts";
import type { KnowledgeSource, Need, Stage } from "./onboarding-admin.ts";
import { LISTEN_DAYS } from "./onboarding.ts";

/**
 * Grasp's admin as tools: what every chat about Grasp's companies can ask, whether it is the
 * admin's own chat, Claude or ChatGPT through the admin's MCP server, or a bot in Discord. One
 * list, answered from the same views the admin's pages show, so a chat and a page never disagree.
 * Only reading: whatever changes something at a company stays a button a person presses in the
 * admin. The words are English and plain: they are read by a model, which says them on in the
 * language it is spoken to in. Pure.
 */

/** A tool as the MCP protocol lists it, with the protocol's own hints on what it does. */
export interface AdminTool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    /** The admin's tools reach nothing outside the admin. */
    openWorldHint: false;
  };
}

const READS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const ORGANIZATION = {
  type: "string",
  description:
    "The organization, by its id or its name (a part of the name will do).",
} as const;

const NOTHING = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const MEASURES = [
  "known",
  "talked",
  "ai",
  "freed",
  "value",
  "fees",
  "needs",
] as const;
export type Measure = (typeof MEASURES)[number];

export const ADMIN_TOOLS = [
  {
    name: "list_organizations",
    title: "Organizations",
    description:
      "Every company with Grasp: its phase, how much Grasp knows, its contract, its AI use this month and how many things need Grasp there. Optionally only one phase.",
    inputSchema: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          enum: [...ADMIN_PHASES],
          description:
            "start, agreements, interviews, ready (enough is known, waiting for Grasp’s go) or open.",
        },
      },
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "get_organization",
    title: "One organization",
    description:
      "Everything the admin has on one company, in numbers: where it stands, its health, its teams, its contract, AI use, hours, and what needs Grasp there. Never what anyone said.",
    inputSchema: {
      type: "object",
      properties: { organization: ORGANIZATION },
      required: ["organization"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "brief",
    title: "Brief for the next call",
    description:
      "What to take into the next conversation with a company: where it stands, what to bring up, what Grasp does not know yet, and the next steps.",
    inputSchema: {
      type: "object",
      properties: { organization: ORGANIZATION },
      required: ["organization"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "what_needs_grasp",
    title: "What needs Grasp",
    description:
      "Everything that waits for a person at Grasp, across every company, the most pressing first.",
    inputSchema: NOTHING,
    annotations: READS,
  },
  {
    name: "compare_organizations",
    title: "Compare organizations",
    description:
      "Every company ranked by one measure: known (share of what Grasp needs), talked (share of people asked who finished their interview), ai (euros of AI this month), freed (hours a week freed), value (what those hours are worth a month), fees (euros a month under contract), needs (things waiting for Grasp).",
    inputSchema: {
      type: "object",
      properties: { measure: { type: "string", enum: [...MEASURES] } },
      required: ["measure"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: "daily_digest",
    title: "Daily digest",
    description:
      "The morning message for Grasp’s team: how many companies are where, which passed 80%, which are ready for Grasp’s go, and what needs Grasp today.",
    inputSchema: NOTHING,
    annotations: READS,
  },
  {
    name: "integrations_to_build",
    title: "Integrations to build",
    description:
      "The apps the companies’ workflows need that Composio does not have, which Grasp builds into the platform itself, once for every company that asked: each with where its build stands, who it waits on, and which companies and workflows asked for it.",
    inputSchema: NOTHING,
    annotations: READS,
  },
  {
    name: "platforms",
    title: "Every company’s platform",
    description:
      "Every company’s own Grasp as the console runs it: how it stands, its ring and release, whether it runs what the console made live, yesterday’s requests and errors, and what needs a look; then the release going out now, ring by ring.",
    inputSchema: NOTHING,
    annotations: READS,
  },
  {
    name: "sources",
    title: "Sources",
    description:
      "The systems the admin reads (Grasp’s console, Rooms, Attio, Stripe, Composio, Discord): which are connected and which are still to come.",
    inputSchema: NOTHING,
    annotations: READS,
  },
] as const satisfies readonly AdminTool[];

export type AdminToolName = (typeof ADMIN_TOOLS)[number]["name"];

/** The instructions an outside app gets with the admin's MCP. */
export const ADMIN_MCP_INSTRUCTIONS =
  "This is Grasp's own admin: every company Grasp works with, as Grasp's staff see it. Every number is worked out from what happened at the company; say a number only as the tools give it, and say when one is unknown rather than guessing. The tools read only: changes are made in the admin itself, by a person. Never ask for, or repeat, what a person at a company said in an interview: the tools hold numbers and names of teams, never anyone's words.";

/** The share at which the morning digest calls out a company: most of what Grasp needs is in. */
export const MILESTONE = 80;

/** At most this many needs in the morning digest; the rest are a count. */
const DIGEST_NEEDS = 12;

/** What a tool came to: the text a model reads, the same as data, or why it could not answer. */
export interface AdminToolAnswer {
  text: string;
  structured?: Record<string, unknown>;
  failed?: true;
}

const fail = (text: string): AdminToolAnswer => ({ text, failed: true });

const PHASE: Record<AdminPhase, string> = {
  start: "Starting: first conversation and research",
  agreements: "Agreements and connecting the sign-in",
  interviews: "Interviews",
  ready: "Ready for Grasp’s go",
  open: "Open: the company works in Grasp",
};

const STAGE: Record<Stage, string> = {
  conversation: "First conversation",
  research: "Research",
  agreed: "Agreements",
  connected: "Sign-in connected",
  leads: "Team leads",
  interviews: "Interviews",
  open: "Grasp opens",
};

const SOURCE: Record<KnowledgeSource, string> = {
  vision: "the first conversation and the research",
  directory: "who works where, from the sign-in",
  sources: "where the documents live",
  documents: "documents dropped in",
  pulse: "Pulse",
  leadsKnown: "team leads named",
  leadsHeard: "team leads interviewed",
  everyoneHeard: "everyone else interviewed",
  review: "workflows known",
};

const BUILD_STAGE: Record<BuildStage, string> = {
  requested: "asked for, not started",
  researching: "Grasp’s agent is researching the app and writing a plan",
  plan: "the plan is ready for a person at Grasp to approve",
  credentials: "waiting for a person at Grasp to add the credentials",
  writing: "Grasp’s agent is writing it",
  testing: "Grasp’s agent is testing it",
  selfReview: "a second agent is reviewing the work",
  review: "the pull request is in review",
  merged: "merged, going into the next release",
  rollout: "in a release, rolling out ring by ring",
  live: "live for every company that asked",
  declined: "Grasp does not build it",
};

const WAITER: Record<Waiter, string> = {
  agent: "runs by itself",
  grasp: "waits on a person at Grasp",
  company: "waits on the companies to connect it",
  nobody: "waits on nobody",
};

const AGREEMENT: Record<Extract<Need, { kind: "agreement" }>["what"], string> =
  {
    processing: "The data processing agreement is not signed.",
    assessment: "The company has not signed off its risk assessment.",
    council:
      "The works council has not said yes yet: nobody is invited until it does.",
  };

const euros = (value: number) =>
  `€${Math.round(value).toLocaleString("en-GB")}`;
const euroCents = (value: number) =>
  `€${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (value: number) => `${Math.round(value * 10) / 10}`;
/** So many of a thing, in the right number: "1 thing", "2 things". */
const many = (count: number, one: string, other: string) =>
  `${count} ${count === 1 ? one : other}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const given = (text: string | null | undefined): text is string =>
  text !== null && text !== undefined && text !== "";

type AccountNeed = Extract<
  Need,
  { kind: "contract" | "ending" | "signin" | "budget" }
>;

const ACCOUNT_NEEDS: ReadonlySet<Need["kind"]> = new Set([
  "contract",
  "ending",
  "signin",
  "budget",
]);

const isAccountNeed = (need: Need): need is AccountNeed =>
  ACCOUNT_NEEDS.has(need.kind);

/** What the account, rather than the onboarding, needs from Grasp. */
const accountNeedText = (need: AccountNeed): string => {
  switch (need.kind) {
    case "contract": {
      return given(need.sent)
        ? `The contract was sent on ${need.sent} and is not signed.`
        : "The contract is still being written.";
    }
    case "ending": {
      return `The contract ends on ${need.until}, in ${need.days} days, with nothing agreed after it.`;
    }
    case "signin": {
      return `${need.integration.name} stopped working until someone at the company signs in again.`;
    }
    case "budget": {
      return `More AI than the contract covers in ${need.month}: ${euros(need.spend)} against ${euros(need.included)}.`;
    }
    default: {
      return need satisfies never;
    }
  }
};

/** What needs Grasp, in one sentence a model can say on. */
export const needText = (need: Need, view: AdminView): string => {
  if (isAccountNeed(need)) {
    return accountNeedText(need);
  }
  switch (need.kind) {
    case "paused": {
      return "Grasp paused the interviews: nobody can open or finish theirs until Grasp resumes them.";
    }
    case "transcript": {
      return view.state.conversation === "in"
        ? "The first conversation is in, and Stephen has not read it yet."
        : "The first conversation with the sponsor is not brought in yet.";
    }
    case "ask": {
      return `The first conversation left ${many(need.fields.length, "thing", "things")} open: ask the sponsor.`;
    }
    case "research": {
      return "The research on the company is not started.";
    }
    case "conflict": {
      return `The research disagrees with the company’s own account: ${need.text}`;
    }
    case "agreement": {
      return AGREEMENT[need.what];
    }
    case "lead": {
      return `${need.lead}, who leads ${need.team.name}, has not talked yet.`;
    }
    case "quiet": {
      return `${need.team.name} has gone quiet: ${need.talked} talked, with ${many(need.left, "day", "days")} left.`;
    }
    case "blocked": {
      return `${need.work.name} cannot be known yet: something stands in the way.`;
    }
    case "split": {
      return `${need.work.name} is told so differently that it is better split in two; ${need.lead} decides.`;
    }
    case "few": {
      return `${many(need.works.length, "piece of work has", "pieces of work have")} too few people to ask.`;
    }
    case "read": {
      return `${many(need.count, "interview waits", "interviews wait")} to be read by Grasp.`;
    }
    case "go": {
      return `Ready for Grasp’s go: ${need.percent}% is known, and it opens at ${need.threshold}%.`;
    }
    case "short": {
      return `The interviews are over with ${need.percent}% known, under the ${need.threshold}% it opens at: decide whether to open anyway.`;
    }
    default: {
      return need satisfies never;
    }
  }
};

const interviewsText = (
  signal: Extract<HealthSignal, { area: "interviews" }>,
  level: string
): string => {
  if (!signal.told) {
    return "interviews not started";
  }
  const day = signal.closed ? "closed" : `day ${signal.day} of ${LISTEN_DAYS}`;
  const quiet =
    signal.quiet > 0
      ? `, ${signal.quiet} teams waiting on a lead or gone quiet`
      : "";
  return `interviews ${level} (${signal.talked} of ${signal.asked} talked, ${day}${quiet})`;
};

const workflowsText = (
  signal: Extract<HealthSignal, { area: "workflows" }>,
  level: string
): string => {
  if (!signal.open) {
    return `workflows ${level} (${signal.known} of ${signal.of} known)`;
  }
  const stuck = signal.stuck > 0 ? `, ${signal.stuck} connections stopped` : "";
  return `workflows ${level} (${signal.live} live, ${signal.designs} on their way${stuck})`;
};

const healthText = (signal: HealthSignal): string => {
  const level = signal.level === "none" ? "not yet" : signal.level;
  switch (signal.area) {
    case "connections": {
      return `connections ${level} (${signal.connected} connected, ${signal.stopped} stopped${signal.signIn ? "" : ", sign-in not connected"})`;
    }
    case "interviews": {
      return interviewsText(signal, level);
    }
    case "brain": {
      return `brain ${level} (${signal.percent}% known, opens at ${signal.threshold}%, ${signal.covered} of ${signal.teams} teams heard)`;
    }
    case "workflows": {
      return workflowsText(signal, level);
    }
    case "account": {
      return `account ${level}${signal.needs.length > 0 ? ` (${signal.needs.join(", ")})` : ""}`;
    }
    default: {
      return signal satisfies never;
    }
  }
};

/** The contract in a few words, for the list of every organization. */
const dealOf = ({ contract }: AdminView): string => {
  if (contract.status === "signed") {
    return `${contract.plan}, ${euros(contract.fee)} a month`;
  }
  return contract.status === "sent"
    ? "contract sent, not signed"
    : "contract being written";
};

/** One organization in a line: for lists. */
const lineOf = (view: AdminView): string =>
  `- ${view.org.name} (${view.org.id}): ${PHASE[phaseOf(view)]}; ${view.knowledge.percent}% known; ${dealOf(view)}; AI this month ${euroCents(view.usage.thisMonth.spend)}; ${view.needs.length} things need Grasp`;

/** The contract as one organization's summary says it. */
const contractText = ({ contract }: AdminView): string => {
  if (contract.status === "signed") {
    return `Contract: ${contract.plan}, ${euros(contract.fee)} a month before VAT, from ${contract.from} until ${contract.until}${contract.renews ? ", renews" : ""}. AI covered: ${euros(contract.aiIncluded)} a month.`;
  }
  const where =
    contract.status === "sent"
      ? `sent on ${contract.sent ?? "an unknown day"}, not signed`
      : "being written";
  return `Contract: ${where}.`;
};

const hoursText = ({ value }: AdminView): string =>
  value.counted > 0
    ? `Hours: ${hours(value.hours)} a week in the work whose numbers are known (${value.unknown} pieces of work without numbers). Freed: ${hours(value.freed)} a week, worth ${euros(value.value)} a month; expected from designs: ${hours(value.expected)} a week.`
    : "Hours: nobody gave numbers yet.";

/** Everything on one organization as text: what `get_organization` answers and the chat reads. */
export const summaryOf = (view: AdminView): string => {
  const { org } = view;
  const brain = brainOf(view);
  const integrations =
    view.integrations
      .map((each) => `${each.name}${each.again ? " (stopped)" : ""}`)
      .join(", ") || "none";
  const lines = [
    `## ${org.name} (${org.id})`,
    [org.about, org.place].filter((each) => given(each)).join(" · "),
    `Phase: ${PHASE[phaseOf(view)]}. Step: ${STAGE[view.stage]}. Counted up to ${view.asOf}.`,
    `Known: ${view.knowledge.percent}% of what Grasp needs; it opens at ${view.knowledge.threshold}%.`,
    contractText(view),
    `Members: ${view.seats.used} of ${view.seats.of} seats. Integrations: ${integrations}.`,
    `AI: ${euroCents(view.usage.thisMonth.spend)} this month, ${euroCents(view.usage.total.spend)} in all.`,
    hoursText(view),
    `Health: ${healthOf(view).map(healthText).join("; ")}.`,
    "",
    "Teams (agreed interviews of people asked; pieces of work known of all):",
    ...brain.teams.map(
      (team) =>
        `- ${team.name}${team.off ? " (does not take part)" : ""}: ${team.agreed} of ${team.asked} interviews; ${team.known} of ${many(team.works, "piece of work", "pieces of work")} known; ${many(team.questions, "open question", "open questions")}`
    ),
    "",
    view.needs.length > 0 ? "Needs Grasp:" : "Nothing needs Grasp here.",
    ...view.needs.map((need) => `- ${needText(need, view)}`),
  ];
  return lines.filter((line, index) => line !== "" || index > 0).join("\n");
};

/** The brief for the next call, as text. */
export const briefText = (view: AdminView): string => {
  const brief = briefOf(view);
  const lines = [
    `# Brief: ${view.org.name}`,
    `Where it stands: ${PHASE[brief.phase]}, at ${STAGE[brief.stage]}. ${brief.percent}% of what Grasp needs is known; it opens at ${brief.threshold}%.`,
  ];
  if (brief.bringUp.length > 0) {
    lines.push(
      "",
      "Bring up:",
      ...brief.bringUp.map((need) => `- ${needText(need, view)}`)
    );
  }
  if (brief.missing.length > 0) {
    lines.push(
      "",
      "What Grasp does not know yet:",
      ...brief.missing.map(
        (each) => `- ${SOURCE[each.source]}: ${percent(each.known)} in`
      )
    );
  }
  if (brief.questions > 0) {
    lines.push(
      `- ${brief.questions} questions people could not answer, for the next interviews.`
    );
  }
  if (brief.next.length > 0) {
    lines.push(
      "",
      `Next steps (${STAGE[brief.stage]}): ${brief.next.length} still to do; open the organization's overview for each.`
    );
  }
  if (view.open) {
    lines.push(
      "",
      `Since it opened: ${hours(brief.freed)} hours a week freed, worth ${euros(brief.value)} a month.`
    );
    if (brief.opportunities.length > 0) {
      lines.push(
        "Where Grasp could do more:",
        ...brief.opportunities.map(
          (each) =>
            `- ${each.name}: ${hours(each.hours)} hours a week by hand, no workflow yet`
        )
      );
    }
  }
  return lines.join("\n");
};

/** What needs Grasp at every organization, the most pressing first, whichever organization it is at. */
const everyNeed = (
  views: readonly AdminView[]
): { view: AdminView; need: Need }[] =>
  views
    .flatMap((view) => view.needs.map((need) => ({ view, need })))
    .toSorted((a, b) => byUrgency(a.need, b.need));

/** The morning message for Grasp's team. */
export const digestOf = (
  views: readonly AdminView[],
  today: string
): string => {
  const count = (phase: AdminPhase) =>
    views.filter((view) => phaseOf(view) === phase).length;
  const past = views.filter(
    (view) => !view.open && view.knowledge.percent >= MILESTONE
  );
  const ready = views.filter((view) => phaseOf(view) === "ready");
  const needs = everyNeed(views).map(
    ({ view, need }) => `- ${view.org.name}: ${needText(need, view)}`
  );
  const lines = [
    `Grasp, ${today}: ${many(views.length, "organization", "organizations")}. ${ADMIN_PHASES.map((phase) => `${count(phase)} ${phase}`).join(", ")}.`,
    past.length > 0
      ? `Past ${MILESTONE}% known: ${past.map((view) => `${view.org.name} (${view.knowledge.percent}%)`).join(", ")}.`
      : `Nobody is past ${MILESTONE}% known and still closed.`,
    ready.length > 0
      ? `Waiting for Grasp’s go: ${ready.map((view) => view.org.name).join(", ")}.`
      : "",
    needs.length > 0
      ? `\nNeeds Grasp today (${needs.length}):`
      : "Nothing needs Grasp today.",
    ...needs.slice(0, DIGEST_NEEDS),
    needs.length > DIGEST_NEEDS
      ? `- and ${needs.length - DIGEST_NEEDS} more in the admin.`
      : "",
  ];
  return lines.filter((line) => line !== "").join("\n");
};

/** An organization's name, by its id; the id itself for one the admin does not have. */
const nameOf = (views: readonly AdminView[], id: string): string =>
  views.find((view) => view.org.id === id)?.org.name ?? id;

/** One integration to build, in a line: where it stands, who it waits on, and who asked for it. */
export const buildLine = (
  build: IntegrationBuild,
  views: readonly AdminView[]
): string => {
  const asked = askedBy(build).map(
    (org) =>
      `${nameOf(views, org)} (${build.requests
        .filter((request) => request.org === org)
        .flatMap((request) => request.workflows)
        .join(", ")})`
  );
  const pullRequest = build.work?.pr;
  const pr =
    pullRequest && (build.stage === "review" || build.stage === "merged")
      ? ` Pull request #${pullRequest.number}, reviewed by ${pullRequest.reviewer}.`
      : "";
  const liveAt =
    (build.work?.rollout ?? [])
      .filter((each) => given(each.live))
      .map((each) => nameOf(views, each.org))
      .join(", ") || "none yet";
  const release =
    build.stage === "rollout" && given(build.work?.release)
      ? ` Release ${build.work.release}, live at ${liveAt}.`
      : "";
  const declined =
    build.stage === "declined" && given(build.declined)
      ? ` Why: ${build.declined}`
      : "";
  return `- ${build.app}: ${BUILD_STAGE[build.stage]}; ${WAITER[waitsOn(build.stage)]}. Asked by ${asked.join("; ")}.${pr}${release}${declined}`;
};

/** What the console holds about every company's own platform, and the release going out: none until the admin reads it. */
export interface Fleet {
  platforms: { org: string; platform: Platform }[];
  releases: Release[];
  rollout: Rollout | null;
}

export const NO_FLEET: Fleet = { platforms: [], releases: [], rollout: null };

/** One company's platform in a line, as a model reads it. */
const platformLine = (
  org: string,
  platform: Platform,
  fleet: Fleet,
  views: readonly AdminView[]
): string => {
  const name = nameOf(views, org);
  if (platform.status === "none") {
    return `- ${name}: not set up yet.`;
  }
  const rate = errorRateOf(platform);
  const errors = rate === null ? "no" : `${Math.round(rate * 1000) / 10}%`;
  const needs = needsOf(platform, fleet.releases).map((need) => need.kind);
  const look = needs.length > 0 ? `; needs a look: ${needs.join(", ")}` : "";
  const pinned = given(platform.pinned) ? " (pinned)" : "";
  return `- ${name}: ${standingOf(platform, fleet.releases)}; ring ${platform.ring}; runs ${releaseOf(platform) ?? "nothing yet"}${pinned}; ${driftOf(platform).replace("_", " ")}; ${platform.usage.days.at(-1)?.requests ?? 0} requests yesterday, ${errors} errors${look}.`;
};

/** The release going out, ring by ring, in a line. */
const rolloutLine = (rollout: Rollout): string => {
  const status =
    rollout.status === "waiting"
      ? `waiting for someone at Grasp to approve ring ${Math.min(rollout.ring + 1, 2)}`
      : rollout.status;
  const rings = ringsOf(rollout)
    .map(
      (ring) =>
        `Ring ${ring.ring}: ${ring.done} of ${ring.targets.length} on it`
    )
    .join("; ");
  return `Going out now: ${rollout.release}, ${status}. ${rings}.`;
};

/** Every company's platform, then the release going out, a line each. */
const fleetLines = (fleet: Fleet, views: readonly AdminView[]): string[] => [
  ...fleet.platforms.map((each) =>
    platformLine(each.org, each.platform, fleet, views)
  ),
  ...(fleet.rollout ? [rolloutLine(fleet.rollout)] : []),
];

/** Everything the admin's chat reads before it answers: the digest, then every organization, then the integrations Grasp builds and every company's platform. */
export const adminDocument = (
  views: readonly AdminView[],
  today: string,
  builds: readonly IntegrationBuild[] = [],
  fleet: Fleet = NO_FLEET
): string => {
  const integrations =
    builds.length > 0
      ? [
          "Integrations to build, for every company:",
          ...sortBuilds(builds).map((build) => buildLine(build, views)),
          "",
        ]
      : [];
  const platforms =
    fleet.platforms.length > 0
      ? ["Every company’s own platform:", ...fleetLines(fleet, views), ""]
      : [];
  return [
    digestOf(views, today),
    "",
    ...views.map(summaryOf).flatMap((summary) => [summary, ""]),
    ...integrations,
    ...platforms,
  ]
    .join("\n")
    .trim();
};

/** The organization a tool was asked about: by id, else by its name or a part of it, when only one fits. */
export const findOrganization = (
  views: readonly AdminView[],
  asked: unknown
): AdminView | string => {
  if (typeof asked !== "string" || asked.trim() === "") {
    return "Name the organization, by its id or its name.";
  }
  const wanted = asked.trim().toLowerCase();
  const exact = views.find(
    (view) =>
      view.org.id.toLowerCase() === wanted ||
      view.org.name.toLowerCase() === wanted
  );
  if (exact) {
    return exact;
  }
  const like = views.filter((view) =>
    view.org.name.toLowerCase().includes(wanted)
  );
  const [only] = like;
  if (like.length === 1 && only) {
    return only;
  }
  if (like.length > 1) {
    return `More than one organization fits "${asked}": ${like.map((view) => view.org.name).join(", ")}. Name one.`;
  }
  return `No organization fits "${asked}". There are: ${views.map((view) => view.org.name).join(", ")}.`;
};

const measureOf = (view: AdminView, measure: Measure): number => {
  switch (measure) {
    case "known": {
      return view.knowledge.percent;
    }
    case "talked": {
      return view.asked === 0
        ? 0
        : Math.round((view.counts.completed / view.asked) * 100);
    }
    case "ai": {
      return view.usage.thisMonth.spend;
    }
    case "freed": {
      return view.value.freed;
    }
    case "value": {
      return view.value.value;
    }
    case "fees": {
      return view.contract.running ? view.contract.fee : 0;
    }
    case "needs": {
      return view.needs.length;
    }
    default: {
      return measure satisfies never;
    }
  }
};

const SHOWN: Record<Measure, (value: number) => string> = {
  known: (value) => `${value}%`,
  talked: (value) => `${value}%`,
  ai: euroCents,
  freed: (value) => `${hours(value)} hours a week`,
  value: (value) => `${euros(value)} a month`,
  fees: (value) => `${euros(value)} a month`,
  needs: String,
};

const sourceLine = (source: AdminSource): string => {
  const state = source.state === "live" ? "connected" : "still to connect";
  const way = source.direction === "in" ? "brings" : "gives";
  const tools =
    source.tools.length > 0
      ? `; through its MCP tools ${source.tools.join(", ")}`
      : "";
  return `- ${source.id}: ${state}; ${way} ${source.reads.join(", ")}${tools}`;
};

/** What every tool answers from: the organizations as the admin has them on their day, the integrations to build and every company's platform. */
interface Asked {
  input: Record<string, unknown>;
  views: readonly AdminView[];
  today: string;
  builds: readonly IntegrationBuild[];
  fleet: Fleet;
}

const ANSWERS: Record<AdminToolName, (asked: Asked) => AdminToolAnswer> = {
  list_organizations: ({ input, views }) => {
    const phase = ADMIN_PHASES.find((each) => each === input.phase);
    if (input.phase !== undefined && !phase) {
      return fail(`A phase is one of: ${ADMIN_PHASES.join(", ")}.`);
    }
    const shown = phase
      ? views.filter((view) => phaseOf(view) === phase)
      : views;
    return {
      text:
        shown.length > 0
          ? shown.map(lineOf).join("\n")
          : "No organization is in that phase.",
      structured: {
        organizations: shown.map((view) => ({
          id: view.org.id,
          name: view.org.name,
          phase: phaseOf(view),
          known: view.knowledge.percent,
          needs: view.needs.length,
        })),
      },
    };
  },
  get_organization: ({ input, views }) => {
    const found = findOrganization(views, input.organization);
    return typeof found === "string" ? fail(found) : { text: summaryOf(found) };
  },
  brief: ({ input, views }) => {
    const found = findOrganization(views, input.organization);
    return typeof found === "string" ? fail(found) : { text: briefText(found) };
  },
  what_needs_grasp: ({ views }) => {
    const all = everyNeed(views).map(({ view, need }) => ({
      id: view.org.id,
      name: view.org.name,
      kind: need.kind,
      text: needText(need, view),
    }));
    return {
      text:
        all.length > 0
          ? all.map((each) => `- ${each.name}: ${each.text}`).join("\n")
          : "Nothing needs Grasp anywhere.",
      structured: { needs: all },
    };
  },
  compare_organizations: ({ input, views }) => {
    const measure = MEASURES.find((each) => each === input.measure);
    if (!measure) {
      return fail(`A measure is one of: ${MEASURES.join(", ")}.`);
    }
    const ranked = views
      .map((view) => ({
        id: view.org.id,
        name: view.org.name,
        value: measureOf(view, measure),
      }))
      .toSorted((a, b) => b.value - a.value);
    return {
      text: ranked
        .map(
          (each, index) =>
            `${index + 1}. ${each.name}: ${SHOWN[measure](each.value)}`
        )
        .join("\n"),
      structured: { measure, ranked },
    };
  },
  daily_digest: ({ views, today }) => ({ text: digestOf(views, today) }),
  integrations_to_build: ({ views, builds }) => {
    const sorted = sortBuilds(builds);
    return {
      text:
        sorted.length > 0
          ? sorted.map((build) => buildLine(build, views)).join("\n")
          : "No integration is asked for that Composio does not have.",
      structured: {
        integrations: sorted.map((build) => ({
          id: build.id,
          app: build.app,
          stage: build.stage,
          waitsOn: waitsOn(build.stage),
          askedBy: build.requests.map((request) => ({
            organization: request.org,
            workflows: request.workflows,
            on: request.on,
          })),
        })),
      },
    };
  },
  platforms: ({ views, fleet }) => {
    if (fleet.platforms.length === 0) {
      return {
        text: "The admin does not read the console yet, so it knows no company’s platform.",
      };
    }
    return {
      text: fleetLines(fleet, views).join("\n"),
      structured: {
        platforms: fleet.platforms.map(({ org, platform }) => ({
          organization: org,
          standing: standingOf(platform, fleet.releases),
          ring: platform.ring,
          release: releaseOf(platform),
          pinned: platform.pinned,
          drift: driftOf(platform),
          needs: needsOf(platform, fleet.releases).map((need) => need.kind),
        })),
        rollout: fleet.rollout
          ? {
              release: fleet.rollout.release,
              status: fleet.rollout.status,
              ring: fleet.rollout.ring,
            }
          : null,
      },
    };
  },
  sources: () => ({ text: ADMIN_SOURCES.map(sourceLine).join("\n") }),
};

const isToolName = (name: string): name is AdminToolName =>
  ADMIN_TOOLS.some((tool) => tool.name === name);

/** Answers one call of a tool, over the organizations as the admin has them on their day. */
export const callAdminTool = (
  name: string,
  input: Record<string, unknown>,
  views: readonly AdminView[],
  today: string,
  builds: readonly IntegrationBuild[] = [],
  fleet: Fleet = NO_FLEET
): AdminToolAnswer =>
  isToolName(name)
    ? ANSWERS[name]({ input, views, today, builds, fleet })
    : fail(`There is no tool ${name}.`);
