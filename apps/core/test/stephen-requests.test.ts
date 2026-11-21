import { dayFrom, weekOf } from "@grasp-os/shared/stephen-requests";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { addSource } from "../src/brain-next.ts";
import {
  companyDay,
  heardRequest,
  keepCardsOf,
  pressedChanges,
  pressedStart,
  settleRequest,
  sweepStephenRequests,
} from "../src/channels/stephen-requests.ts";
import { says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import {
  stephenJudgeReplies,
  stephenRequestCalls,
  stephenRequestReplies,
} from "./model-provider.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import {
  member,
  memberAnsweredBy,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  reached,
  watched,
} from "./teams-door.ts";

// Stephen's requests outside Grasp (src/channels/stephen-requests.ts,
// src/stephen-requests.ts), from their threat models: a record that keeps
// what someone asked, a message counted twice, what isn't finished billed;
// a week that points at a few people; and settings someone other than an
// owner changes.

const idp = mockIdp();

watched();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** What a model naming a request answers. */
const sorting = (fields: Record<string, unknown>) => ({
  text: JSON.stringify({
    topic: null,
    newTopic: null,
    question: null,
    newQuestion: null,
    role: null,
    ...fields,
  }),
  inputTokens: 10,
  outputTokens: 10,
});

/** What a model judging whether he answered a request answers. */
const judged = (answered: boolean) => ({
  text: JSON.stringify({ answered }),
  inputTokens: 10,
  outputTokens: 5,
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
  stephenJudgeReplies.length = 0;
  stephenRequestCalls.length = 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM stephen_requests"),
    env.DB.prepare("DELETE FROM stephen_request_questions"),
    env.DB.prepare("DELETE FROM stephen_request_topics"),
    env.DB.prepare("DELETE FROM stephen_request_needs"),
    env.DB.prepare("DELETE FROM stephen_request_cards"),
    env.DB.prepare("DELETE FROM stephen_request_proposals"),
    env.DB.prepare("DELETE FROM stephen_summary_readers"),
    env.DB.prepare("DELETE FROM stephen_summaries"),
    env.DB.prepare("DELETE FROM org_settings"),
  ]);
};

/** A request as a fixture: done and answered, unless said otherwise. */
interface Seeded {
  day?: string;
  place?: string;
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
        "INSERT INTO stephen_requests (id, day, place, person_id, team_id, kind, outcome, topic_id, question_id, tools, missing, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        `teams:${crypto.randomUUID()}`,
        request.day ?? day,
        request.place ?? "teams",
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

  it("isn't billed until it is known he answered it, and its answer takes a thumb without sources", async () => {
    const { userId, teams } = await member(
      idp,
      says("The office opens at eight.")
    );
    // Judging fails, however often it is tried: whether he answered
    // can't be known.
    stephenJudgeReplies.push(
      ...Array.from({ length: 5 }, () => ({
        text: "Not what was asked for.",
        inputTokens: 10,
        outputTokens: 10,
      }))
    );
    const message = messageFrom(teams, { text: "When does the office open?" });

    await post(message);

    const kept = await vi.waitFor(
      async () => {
        const [now] = await keptOf(userId);
        expect(now?.outcome).not.toBe("stopped");
        return now;
      },
      { timeout: 30_000, interval: 200 }
    );
    const thumbs = await vi.waitFor(
      async () => {
        const { activities } = await reached(teams.conversation);
        const posted = JSON.stringify(activities);
        expect(posted).toContain("answer.helpful");
        return posted.includes(`teams:${message.id}`);
      },
      { timeout: 30_000, interval: 200 }
    );
    expect({ outcome: kept?.outcome, thumbs }).toStrictEqual({
      outcome: "unanswered",
      thumbs: true,
    });
  });

  it("is not answered when he said he didn't know, and takes a thumb from its own person only", async () => {
    const { userId, teams } = await member(
      idp,
      says("I don't know when the bonus is paid out.")
    );
    const other = await member(idp, says("Hello."));
    stephenJudgeReplies.push(judged(false));
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

describe("sorting a request", setUpTime, () => {
  afterEach(cleanUp);

  it("names it from what the person wrote alone, never from his answer, in their direct message and a group chat alike, and still judges whether he answered", async () => {
    // His answer can quote what only the person may read: in their direct
    // message, their own chat (GRA-1821), his recall reads their own store.
    // So the call that names a topic, a question and a role is never sent
    // his answer, for any request; only the call judging whether he
    // answered reads it, and says that alone (request-sorting.ts).
    const [depot, own] = [`d${unique()}`, `m${unique()}`];
    const ann = await member(
      idp,
      says(`Your own note says ${own}.`),
      says(`In the group too: ${own}.`)
    );
    const ben = await memberAnsweredBy(idp, ann.provider);
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `Depot ${depot} keeps Ann's own note ${own}`,
      readers: { kind: "owner", personId: ann.userId },
    });
    const naming = {
      newTopic: "Depots and stock",
      newQuestion: "What is kept at a depot?",
      role: "Logistics lead",
    };
    stephenRequestReplies.push(sorting(naming), sorting(naming));
    // Her direct message's answer judged not to answer it; the group's
    // judged as answered, as the provider says by default.
    stephenJudgeReplies.push(judged(false));
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }, { person: ben.teams }]);

    const direct = messageFrom(ann.teams, {
      text: `What about depot ${depot}?`,
    });
    const inGroup = mentionIn(ann.teams, group, `And depot ${depot}?`);
    await post(direct);
    await post(inGroup);

    const sent = stephenRequestCalls.map((body) => JSON.stringify(body));
    const namingCalls = sent.filter((body) =>
      body.includes("You sort one message")
    );
    const judging = sent.filter((body) => body.includes("You judge whether"));
    const kept = await keptOf(ann.userId);
    /** How the request of `message` was kept: its outcome, and whether it was named. */
    const keptFor = ({ id }: { id: string }) => {
      const row = kept.find((each) => each.id === `teams:${id}`);
      return {
        outcome: row?.outcome,
        sorted: row?.topic_id !== null && row?.question_id !== null,
      };
    };
    expect({
      // Her own store reached his answer in her direct message.
      recalled: JSON.stringify(ann.provider.requests[0]?.body).includes(own),
      named: namingCalls.map((body) => ({
        asked: body.includes(`depot ${depot}?`),
        // Not even its words: her own note's marker, which only his
        // answer held.
        answer: body.includes(own),
      })),
      judgedWithAnswer: judging.some((body) => body.includes(own)),
      outcomes: [keptFor(direct), keptFor(inGroup)],
    }).toStrictEqual({
      recalled: true,
      named: [
        { asked: true, answer: false },
        { asked: true, answer: false },
      ],
      judgedWithAnswer: true,
      outcomes: [
        { outcome: "unanswered", sorted: true },
        { outcome: "done", sorted: true },
      ],
    });
  });
});

/** Every topic's name and question's wording kept, in order. */
const namesKept = async (): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM stephen_request_topics UNION ALL SELECT wording FROM stephen_request_questions ORDER BY 1"
  ).all<{ name: string }>();
  return results.map(({ name }) => name);
};

describe("a topic the sorter names", setUpTime, () => {
  afterEach(cleanUp);

  it("goes, with its question, at the sweep after the one person whose requests it rested on is erased, once a day old", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await member(
      idp,
      says("Take a break."),
      says("Ask your manager."),
      says("Sixteen weeks.")
    );
    const ben = await memberAnsweredBy(idp, ann.provider);
    const [annTopic, overtime, benTopic] = [
      `Workload ${unique()}`,
      `Overtime ${unique()}`,
      `Leave ${unique()}`,
    ];
    stephenRequestReplies.push(
      sorting({
        newTopic: annTopic,
        newQuestion: "How do I cope with stress?",
      }),
      // A topic no question points at: only its own day keeps it.
      sorting({ newTopic: overtime }),
      sorting({ newTopic: benTopic, newQuestion: "How long is leave?" })
    );
    await post(messageFrom(ann.teams, { text: "I'm burning out." }));
    await post(messageFrom(ann.teams, { text: "Is overtime paid?" }));
    await post(messageFrom(ben.teams, { text: "How long is my leave?" }));
    const before = await namesKept();

    await admin.api.members.remove(ann.userId);
    await admin.api.members.erase(ann.userId, String(ann.person.name));
    // A name just made waits a day for the request that made it.
    await sweepStephenRequests(env, new Date());
    const young = await namesKept();
    await sweepStephenRequests(env, new Date(Date.now() + 2 * 86_400_000));

    expect({ before, young, after: await namesKept() }).toStrictEqual({
      young: before,
      before: [
        "How do I cope with stress?",
        "How long is leave?",
        benTopic,
        overtime,
        annTopic,
      ],
      after: ["How long is leave?", benTopic],
    });
  });
});

describe("the sweep of what sorting named", setUpTime, () => {
  afterEach(cleanUp);

  it("keeps a topic past its day while a question just named under it waits for its request", async () => {
    const now = Date.now();
    const day = 86_400_000;
    const [topic, question] = [crypto.randomUUID(), crypto.randomUUID()];
    const name = `Workload ${unique()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO stephen_request_topics (id, name, created_at) VALUES (?, ?, ?)"
      ).bind(topic, name, now),
      // Named under it a day and a half later; its request not kept yet.
      env.DB.prepare(
        "INSERT INTO stephen_request_questions (id, topic_id, wording, role, created_at) VALUES (?, ?, ?, NULL, ?)"
      ).bind(question, topic, "How do I cope with stress?", now + 1.5 * day),
    ]);

    await sweepStephenRequests(env, new Date(now + 2 * day));

    await expect(namesKept()).resolves.toStrictEqual([
      "How do I cope with stress?",
      name,
    ]);
  });
});

describe("a request a card's press belongs to", setUpTime, () => {
  afterEach(cleanUp);

  it("keeps a change whose confirmation failed before the answer was sorted as failed, once settled", async () => {
    const owner = await signedInApi(idp, "admin");
    const today = await companyDay(env);
    const ids = Array.from({ length: 5 }, (_, at) => ({
      id: `teams:held-${at}`,
      person: `person-${crypto.randomUUID()}`,
    }));
    // Taken in, as each message is: stopped, with nothing heard yet.
    await env.DB.batch(
      ids.map(({ id, person }) =>
        env.DB.prepare(
          "INSERT INTO stephen_requests (id, day, place, person_id, kind, outcome, tools, missing) VALUES (?, ?, 'teams', ?, 'answered', 'stopped', '[]', '[]')"
        ).bind(id, today, person)
      )
    );
    const calls = [
      {
        method: "connections.call",
        target: null,
        summary: {
          connection: "OUTLOOK",
          action: "send_mail",
          app: "microsoft",
        },
        outcome: "pending" as const,
        reason: null,
      },
    ];

    for (const { id, person } of ids) {
      // The answer is in and its card is up; the sorting is still running
      // when the person confirms, and the change fails.
      // oxlint-disable-next-line no-await-in-loop -- in the order a turn runs
      await heardRequest(env, id, { calls });
      // oxlint-disable-next-line no-await-in-loop -- in the order a turn runs
      await keepCardsOf(env, id, [`write:${id}`]);
      // oxlint-disable-next-line no-await-in-loop -- in the order a turn runs
      await pressedChanges(env, {
        userId: person,
        writeId: id,
        action: "send_mail",
      });
      // oxlint-disable-next-line no-await-in-loop -- in the order a turn runs
      await settleRequest(env, id, {
        chatId: "chat-1",
        ended: "answered",
        calls,
        sorted: { topicId: null, questionId: null, answered: true },
      });
    }

    const week = await owner.api.stephenRequests.week();
    expect(week.packs).toStrictEqual([
      { pack: "microsoft", done: 0, failed: 5 },
    ]);
  });

  it("is the one whose answer posted the card, whatever was asked in the chat since, and only its own person's", async () => {
    const changes = JSON.stringify([{ id: "microsoft.send_mail", ok: true }]);
    await env.DB.batch(
      ["teams:older", "teams:newer"].map((id) =>
        env.DB.prepare(
          "INSERT INTO stephen_requests (id, day, place, person_id, kind, outcome, tools, missing, chat_id) VALUES (?, '2026-10-01', 'teams', 'person-ann', 'changed', 'done', ?, '[]', 'chat-1')"
        ).bind(id, changes)
      )
    );
    await keepCardsOf(env, "teams:older", ["offer:offer-1", "write:write-1"]);

    await pressedStart(env, {
      userId: "person-bo",
      offerId: "offer-1",
      workflowId: "wf-1",
      started: true,
    });
    await pressedStart(env, {
      userId: "person-ann",
      offerId: "offer-1",
      workflowId: "wf-1",
      started: true,
    });
    await pressedChanges(env, {
      userId: "person-ann",
      writeId: "write-1",
      action: "send_mail",
    });

    const { results } = await env.DB.prepare(
      "SELECT id, kind, tools FROM stephen_requests ORDER BY id"
    ).all<{ id: string; kind: string; tools: string }>();
    expect(results).toStrictEqual([
      { id: "teams:newer", kind: "changed", tools: changes },
      {
        id: "teams:older",
        kind: "workflow",
        tools: JSON.stringify([
          { id: "microsoft.send_mail", ok: false },
          { id: "workflow:wf-1", ok: true },
        ]),
      },
    ]);
  });

  it("is the one whose answer posted the card, however many cards that answer posted", async () => {
    await env.DB.prepare(
      "INSERT INTO stephen_requests (id, day, place, person_id, kind, outcome, tools, missing, chat_id) VALUES ('teams:many', '2026-10-01', 'teams', 'person-ann', 'answered', 'done', '[]', '[]', 'chat-1')"
    ).run();
    // More cards than one statement of D1's 100 bound parameters keeps.
    const offers = Array.from({ length: 40 }, (_, at) => `offer-${at}`);
    await keepCardsOf(
      env,
      "teams:many",
      offers.map((offer) => `offer:${offer}`)
    );

    await pressedStart(env, {
      userId: "person-ann",
      offerId: "offer-39",
      workflowId: "wf-1",
      started: true,
    });

    const request = await env.DB.prepare(
      "SELECT kind, tools FROM stephen_requests WHERE id = 'teams:many'"
    ).first<{ kind: string; tools: string }>();
    expect(request).toStrictEqual({
      kind: "workflow",
      tools: JSON.stringify([{ id: "workflow:wf-1", ok: true }]),
    });
  });
});

describe("the settings and the month billed", setUpTime, () => {
  afterEach(cleanUp);

  it("are changed by owners only, each setting changed audited on its own", async () => {
    const owner = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using staffApi = core.authenticate();

    const events = await auditedDuring(async () => {
      await owner.api.stephenRequests.updateSettings({
        requestsPerPerson: true,
        requestsIncluded: 400,
      });
    });

    expect({
      events: events.map(({ action, detail }) => ({ action, detail })),
      builder: await outcome(builder.api.stephenRequests.settings()),
      staffChanges: await outcome(
        staffApi.stephenRequests.updateSettings({ requestsPerPerson: false })
      ),
    }).toStrictEqual({
      events: [
        {
          action: "stephen_requests.settings.updated",
          detail: { field: "requestsIncluded" },
        },
        {
          action: "stephen_requests.per_person.turned_on",
          detail: { field: "requestsPerPerson" },
        },
      ],
      builder: "role.forbidden",
      staffChanges: "role.forbidden",
    });
  });

  it("keeps what two owners change at once, each change audited as the one who made it", async () => {
    const [ann, bo] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    await ann.api.stephenRequests.updateSettings({
      minutesSaved: { answered: 2 },
    });

    const events = await auditedDuring(async () => {
      await Promise.all([
        ann.api.stephenRequests.updateSettings({ requestsIncluded: 400 }),
        bo.api.stephenRequests.updateSettings({
          minutesSaved: { workflow: 30 },
        }),
      ]);
    });
    const unchanged = await auditedDuring(async () => {
      await bo.api.stephenRequests.updateSettings({ requestsIncluded: 400 });
    });

    expect({
      settings: await ann.api.stephenRequests.settings(),
      events: events
        .map(({ actor, detail }) => ({
          by: actor.type === "person" ? actor.userId : actor.type,
          detail,
        }))
        .toSorted((a, b) => a.by.localeCompare(b.by)),
      unchanged,
    }).toStrictEqual({
      settings: {
        requestsIncluded: 400,
        minutesSaved: { answered: 2, workflow: 30 },
        requestsPerPerson: false,
      },
      events: [
        { by: ann.userId, detail: { field: "requestsIncluded" } },
        { by: bo.userId, detail: { field: "minutesSaved" } },
      ].toSorted((a, b) => a.by.localeCompare(b.by)),
      unchanged: [],
    });
  });

  it("bill what he finished this month against what the plan includes, for admins only", async () => {
    const owner = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const today = await companyDay(env);
    await seed(today, [
      ...people(5, { kind: "workflow" }),
      ...people(5, { kind: "answered", outcome: "notPossible" }),
    ]);
    await owner.api.stephenRequests.updateSettings({ requestsIncluded: 400 });

    expect({
      billed: await owner.api.stephenRequests.billed(),
      builderBilled: await outcome(builder.api.stephenRequests.billed()),
    }).toStrictEqual({
      billed: { billed: 5, included: 400 },
      builderBilled: "role.forbidden",
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
      // Eight weeks, the quiet ones as none, this week last.
      weeks: Array.from({ length: 8 }, (_, index) => {
        const monday = dayFrom(weekOf(today), -7 * (7 - index));
        if (monday === weekOf(today)) {
          return 10;
        }
        return monday === weekOf(dayFrom(today, -20)) ? 2 : 0;
      }),
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
