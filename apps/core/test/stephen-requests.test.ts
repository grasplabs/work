import { dayFrom, weekOf } from "@grasp-os/shared/stephen-requests";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { companyDay } from "../src/channels/stephen-requests.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { sendStephenSummaries } from "../src/stephen-summary.ts";
import { says } from "./agent-chat.ts";
import { stephenRequestReplies } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { captureMail } from "./mail-capture.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { member, messageFrom, post, reached, watched } from "./teams-door.ts";

// Stephen's requests outside Grasp (src/channels/stephen-requests.ts,
// src/stephen-requests.ts, src/stephen-summary.ts), from their threat
// models: a record that keeps what someone asked, a message counted twice,
// what isn't finished billed; a report that points at a few people, by a
// small group or a filter, or one by one before an owner allowed it; and
// a summary that goes twice or to someone else.

const idp = mockIdp();

watched();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** What a model sorting a request answers. */
const sorting = (fields: Record<string, unknown>) => ({
  text: JSON.stringify({
    topic: null,
    newTopic: null,
    question: null,
    newQuestion: null,
    role: null,
    answered: true,
    ...fields,
  }),
  inputTokens: 10,
  outputTokens: 10,
});

/** Every request kept of `userId`, with every table that names what they asked. */
const keptOf = async (userId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT * FROM stephen_requests WHERE person_id = ?"
  )
    .bind(userId)
    .all();
  return results;
};

/** Each test starts with no requests, settings or replies queued. */
const cleanUp = async (): Promise<void> => {
  stephenRequestReplies.length = 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM stephen_requests"),
    env.DB.prepare("DELETE FROM stephen_request_questions"),
    env.DB.prepare("DELETE FROM stephen_request_topics"),
    env.DB.prepare("DELETE FROM stephen_request_needs"),
    env.DB.prepare("DELETE FROM stephen_request_proposals"),
    env.DB.prepare("DELETE FROM stephen_summary_readers"),
    env.DB.prepare("DELETE FROM stephen_summaries"),
    env.DB.prepare("DELETE FROM org_settings"),
  ]);
};

/** A request as a fixture: done and answered, unless said otherwise. */
interface Seeded {
  day?: string;
  person: string;
  team?: string | null;
  kind?: string;
  outcome?: string;
  topic?: string | null;
  question?: string | null;
  tools?: { id: string; ok: boolean }[];
  missing?: { id: string; why: string }[];
  rating?: "up" | "down" | null;
}

/** Keeps `requests` as core would have, on `day` unless they say. */
const seed = async (day: string, requests: Seeded[]): Promise<void> => {
  await env.DB.batch(
    requests.map((request) =>
      env.DB.prepare(
        "INSERT INTO stephen_requests (id, day, place, person_id, team_id, kind, outcome, topic_id, question_id, tools, missing, rating) VALUES (?, ?, 'teams', ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        `teams:${crypto.randomUUID()}`,
        request.day ?? day,
        request.person,
        request.team ?? null,
        request.kind ?? "answered",
        request.outcome ?? "done",
        request.topic ?? null,
        request.question ?? null,
        JSON.stringify(request.tools ?? [{ id: "brain", ok: true }]),
        JSON.stringify(request.missing ?? []),
        request.rating ?? null
      )
    )
  );
};

/** A topic and a question in it, as sorting would have named them. */
const named = async (wording: string, role: string | null = null) => {
  const topic = crypto.randomUUID();
  const question = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO stephen_request_topics (id, name, created_at) VALUES (?, ?, ?)"
    ).bind(topic, `Topic ${unique()}`, Date.now()),
    env.DB.prepare(
      "INSERT INTO stephen_request_questions (id, topic_id, wording, role, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(question, topic, wording, role, Date.now()),
  ]);
  return { topic, question };
};

/** `n` people asking the same, each once. */
const people = (n: number, request: Omit<Seeded, "person">): Seeded[] =>
  Array.from({ length: n }, () => ({
    ...request,
    person: `person-${crypto.randomUUID()}`,
  }));

describe("a message Stephen takes on in Teams", setUpTime, () => {
  afterEach(cleanUp);

  it("is one request, with labels and a day but no words, however often Teams sends it", async () => {
    const { userId, teams } = await member(
      idp,
      says("Parental leave lasts sixteen weeks.")
    );
    stephenRequestReplies.push(
      sorting({
        newTopic: "Leave and absence",
        newQuestion: "How long is parental leave?",
        role: "HR adviser",
      })
    );
    const message = messageFrom(teams, {
      text: "How long is parental leave for Marjolein van Dam?",
    });

    await post(message);
    await post(message);

    const kept = await keptOf(userId);
    const { results: questions } = await env.DB.prepare(
      "SELECT wording, role FROM stephen_request_questions"
    ).all();
    const { results: topics } = await env.DB.prepare(
      "SELECT name FROM stephen_request_topics"
    ).all();
    const stored = JSON.stringify([kept, questions, topics]);
    expect({
      requests: kept.length,
      id: kept[0]?.id,
      day: kept[0]?.day,
      kind: kept[0]?.kind,
      outcome: kept[0]?.outcome,
      sorted: kept[0]?.topic_id !== null && kept[0]?.question_id !== null,
      questions,
      topics,
      // Neither what they wrote nor what he answered.
      words: ["Marjolein", "van Dam", "sixteen"].filter((word) =>
        stored.includes(word)
      ),
    }).toStrictEqual({
      requests: 1,
      id: `teams:${message.id}`,
      day: await companyDay(env),
      kind: "answered",
      outcome: "done",
      sorted: true,
      questions: [
        { wording: "How long is parental leave?", role: "HR adviser" },
      ],
      topics: [{ name: "Leave and absence" }],
      words: [],
    });
  });

  it("is billed only when he finished it: a turn that failed is kept, not billed", async () => {
    const { userId, teams } = await member(idp, {
      status: 500,
      errorType: "api_error",
    });

    await post(messageFrom(teams, { text: "What's on my calendar?" }));

    const [kept] = await keptOf(userId);
    expect({ outcome: kept?.outcome, sorted: kept?.topic_id }).toStrictEqual({
      outcome: "failed",
      sorted: null,
    });
  });

  it("is not answered when he said he didn't know, and takes a thumb from its own person only", async () => {
    const { userId, teams } = await member(
      idp,
      says("I don't know when the bonus is paid out.")
    );
    const other = await member(idp, says("Hello."));
    stephenRequestReplies.push(sorting({ answered: false }));
    const message = messageFrom(teams, { text: "When is the bonus paid?" });

    await post(message);
    const press = (by: typeof teams, actionId: string) =>
      messageFrom(by, {
        text: undefined,
        value: { actionId, value: `teams:${message.id}` },
      });
    await post(press(other.teams, "answer.not_helpful"));
    const [afterOther] = await keptOf(userId);
    await post(press(teams, "answer.not_helpful"));
    const [afterOwn] = await keptOf(userId);

    expect({
      outcome: afterOwn?.outcome,
      byOther: afterOther?.rating,
      byThem: afterOwn?.rating,
    }).toStrictEqual({ outcome: "unanswered", byOther: null, byThem: "down" });
    const { lines } = await reached(teams.conversation);
    expect(lines.at(-1)).toBe("Thanks for letting me know.");
  });
});

describe("the requests report", setUpTime, () => {
  afterEach(cleanUp);

  it("folds every group under five people into one, and names a question only once five asked it", async () => {
    const admin = await signedInApi(idp, "admin");
    const today = await companyDay(env);
    const sick = await named("How do I report sick?");
    const invoices = await named("Who approves invoices?");
    await seed(today, [
      ...people(5, { team: "team-big", ...sick }),
      ...people(4, { team: "team-small", ...invoices }),
      ...people(1, { outcome: "failed" }),
    ]);

    const page = await admin.api.stephenRequests.report({ range: "month" });

    expect({
      total: page.report.total,
      teams: page.report.byTeam.map(({ key, people: count }) => [key, count]),
      questions: page.questions.map(({ name }) => name),
      byPerson: page.report.byPerson,
      tooFew: page.tooFew,
    }).toStrictEqual({
      total: { requests: 10, billed: 9, people: 10 },
      teams: [
        ["team-big", 5],
        ["elsewhere", 4],
      ],
      questions: ["How do I report sick?"],
      byPerson: null,
      tooFew: false,
    });
  });

  it("holds nothing for a filter or a panel that narrows it to fewer than five people, and no person before an owner allowed it", async () => {
    const admin = await signedInApi(idp, "admin");
    const today = await companyDay(env);
    const rare = await named("Who signs the lease?");
    await seed(today, [
      ...people(6, { team: "team-big" }),
      ...people(2, { team: "team-small", ...rare }),
    ]);

    const small = await admin.api.stephenRequests.report({
      range: "month",
      team: "team-small",
    });
    const question = await admin.api.stephenRequests.report({
      range: "month",
      question: rare.question,
    });

    expect({
      tooFew: [small.tooFew, question.tooFew],
      total: small.report.total,
      questionTotal: question.report.total.requests,
      named: question.questions,
      person: await outcome(
        admin.api.stephenRequests.report({
          range: "month",
          person: admin.userId,
        })
      ),
    }).toStrictEqual({
      tooFew: [true, true],
      total: { requests: 0, billed: 0, people: 0 },
      questionTotal: 0,
      named: [],
      person: "role.forbidden",
    });
  });

  it("shows people one by one only after an owner turned it on, audited, and to owners only", async () => {
    const owner = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using staffApi = core.authenticate();
    const today = await companyDay(env);
    await seed(today, people(5, {}));
    const before = await owner.api.stephenRequests.report({ range: "month" });

    const events = await auditedDuring(async () => {
      await owner.api.stephenRequests.updateSettings({
        requestsPerPerson: true,
        requestsIncluded: 400,
      });
    });
    const after = await owner.api.stephenRequests.report({ range: "month" });
    const staffSees = await staffApi.stephenRequests.report({ range: "month" });

    expect({
      before: before.report.byPerson,
      after: after.report.byPerson?.length,
      counts: Object.keys(after.report.byPerson?.[0] ?? {}).toSorted(),
      staffSees: staffSees.report.byPerson,
      events: events.map(({ action, detail }) => ({ action, detail })),
      builder: await outcome(
        builder.api.stephenRequests.report({ range: "month" })
      ),
      staffTurnsOn: await outcome(
        staffApi.stephenRequests.updateSettings({ requestsPerPerson: false })
      ),
    }).toStrictEqual({
      before: null,
      after: 5,
      counts: ["billed", "key", "requests"],
      staffSees: null,
      events: [
        {
          action: "stephen_requests.per_person.turned_on",
          detail: { fields: "requestsIncluded,requestsPerPerson" },
        },
      ],
      builder: "role.forbidden",
      staffTurnsOn: "role.forbidden",
    });
  });

  it("gives the month against the plan and the time saved by the company's minutes", async () => {
    const owner = await signedInApi(idp, "admin");
    const today = await companyDay(env);
    await seed(today, [
      ...people(5, { kind: "workflow" }),
      ...people(5, { kind: "answered", outcome: "notPossible" }),
    ]);
    await owner.api.stephenRequests.updateSettings({
      requestsIncluded: 400,
      minutesSaved: { workflow: 30 },
    });

    const page = await owner.api.stephenRequests.report({ range: "month" });

    expect({
      included: page.settings.requestsIncluded,
      billed: page.report.total.billed,
      notPossible: page.report.notBilled.notPossible,
      pace: typeof page.pace,
      workflows: page.report.byKind.find(({ key }) => key === "workflow")
        ?.billed,
    }).toStrictEqual({
      included: 400,
      billed: 5,
      notPossible: 5,
      pace: "number",
      workflows: 5,
    });
  });
});

describe("Needs you", setUpTime, () => {
  afterEach(cleanUp);

  it("lists what five or more asked that he can't do, with Grasp's proposal, and what its fix did since", async () => {
    const owner = await signedInApi(idp, "admin");
    const today = await companyDay(env);
    const leave = await named("Request leave for next week");
    await seed(
      dayFrom(today, -3),
      people(5, {
        ...leave,
        kind: "changed",
        outcome: "notPossible",
        tools: [],
        missing: [{ id: "afas.leave", why: "actionOff" }],
      })
    );
    stephenRequestReplies.push({
      text: JSON.stringify({
        proposal: "Turn on Request leave in AFAS in Settings › Stephen.",
      }),
      inputTokens: 10,
      outputTokens: 10,
    });

    const [need] = await owner.api.stephenRequests.needs("en");
    await owner.api.stephenRequests.setNeedStatus(need?.key ?? "", "fixed");
    await seed(today, people(2, { ...leave, outcome: "notPossible" }));
    const [fixed] = await owner.api.stephenRequests.needs("en");

    expect({
      kind: need?.kind,
      label: need?.label,
      missing: need?.missing,
      proposal: need?.proposal,
      status: fixed?.status?.status,
      since: fixed?.since,
      // Kept, not asked of the model again.
      proposalAgain: fixed?.proposal,
    }).toStrictEqual({
      kind: "notPossible",
      label: "Request leave for next week",
      missing: [{ id: "afas.leave", why: "actionOff" }],
      proposal: "Turn on Request leave in AFAS in Settings › Stephen.",
      status: "fixed",
      since: { requests: 2, done: 0, up: 0, down: 0, people: null },
      proposalAgain: "Turn on Request leave in AFAS in Settings › Stephen.",
    });
  });
});

describe("Stephen's week", setUpTime, () => {
  afterEach(cleanUp);

  it("says who asked him, the share he answered, and what five or more asked that he couldn't, with the role to ask", async () => {
    const owner = await signedInApi(idp, "admin");
    const today = await companyDay(env);
    const bonus = await named("When is the bonus paid out?", "HR adviser");
    await seed(today, [
      ...people(5, { ...bonus, outcome: "unanswered" }),
      ...people(5, { tools: [{ id: "microsoft.calendar_list", ok: true }] }),
    ]);
    await seed(dayFrom(today, -20), people(2, {}));

    const week = await owner.api.stephenRequests.week();

    expect({
      asked: week.asked,
      weeks: week.weeks.map(({ people: count }) => count),
      answered: week.answered,
      questions: week.questions,
      unanswered: week.unanswered.map(({ wording, people: count, role }) => ({
        wording,
        count,
        role,
      })),
      packs: week.packs,
    }).toStrictEqual({
      asked: 10,
      weeks: [2, 10],
      answered: 7,
      questions: 12,
      unanswered: [
        {
          wording: "When is the bonus paid out?",
          count: 5,
          role: "HR adviser",
        },
      ],
      packs: [
        { pack: "brain", done: 7, failed: 0 },
        { pack: "microsoft", done: 5, failed: 0 },
      ],
    });
  });
});

describe("the weekly summary", setUpTime, () => {
  afterEach(cleanUp);

  it("goes once a week to an owner who asked for it by mail, and to nobody else", async () => {
    const owner = await signedInApi(idp, "admin");
    await signedInApi(idp, "admin");
    const mail = await captureMail(onboardingStore(env));
    const today = await companyDay(env);
    const monday = weekOf(today);
    await seed(dayFrom(monday, -3), people(6, {}));
    await owner.api.stephenRequests.setSummary("email");
    const sent = mail.sent.length;
    // Monday at ten in the morning, Amsterdam's time zone and UTC alike.
    const at = new Date(`${monday}T10:00:00Z`);

    await sendStephenSummaries(env, at);
    await sendStephenSummaries(env, at);

    const ours = mail.sent.slice(sent);
    expect({
      sent: ours.length,
      to: ours[0]?.to,
      lines: String(ours[0]?.text).includes("6 requests last week."),
      teamsRefused: await outcome(
        owner.api.stephenRequests.setSummary("teams")
      ),
    }).toStrictEqual({
      sent: 1,
      to: owner.person.email,
      lines: true,
      teamsRefused: "stephen_requests.teams_closed",
    });
  });
});
