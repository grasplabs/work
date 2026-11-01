import { offeredWidgets } from "@grasp-os/shared/dashboard";
import type { WidgetProgress, WidgetSpec } from "@grasp-os/shared/widgets";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { codeStep, chatOf, says } from "./agent-chat.ts";
import { verifiedCandidate } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Widgets Grasp makes from what a person asks (dashboard-widgets.ts),
// through `/rpc` as the dashboard reaches them and from a chat's code, with
// the model provider behind connect faked. The ways it can fail come
// first: a widget showing what its person can't see, or no longer can; an
// answer that isn't a widget, or doesn't fit, kept anyway or sent back
// without end; a widget changed or removed by someone else; a change no
// one can trace; and a chat's agent learning more than it asked.

const idp = mockIdp();

const day = 24 * 60 * 60 * 1000;

/** A run of `workflow` of `app`'s, started `ago` UTC days before today, as core keeps it. */
const seedRun = async (
  app: string,
  workflow: string,
  status: "completed" | "failed",
  ago: number
): Promise<void> => {
  const start = (Math.floor(Date.now() / day) - ago) * day;
  const at =
    start + Math.floor((Math.min(Date.now(), start + day - 1) - start) / 2);
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, ?, 1, NULL, ?, ?, ?)"
  )
    .bind(`run-${unique()}`, app, workflow, status, at, at)
    .run();
};

/**
 * A builder with an engine of two workflows, `approve` and `remind`, that
 * a user can open too, and their runs: this week `approve` completed
 * twice and failed once, `remind` failed once; `remind` also completed
 * before the week. And another builder's engine neither can open.
 */
const engines = async () => {
  const [owner, other, user] = await Promise.all([
    signedInApi(idp, "builder"),
    signedInApi(idp, "builder"),
    signedInApi(idp, "user"),
  ]);
  const name = `Invoices ${unique()}`;
  const { id: app } = await owner.api.apps.create({ name });
  const { version } = await owner.api.apps.files.commit(
    app,
    {
      "workflows/approve.ts": "export default {};\n",
      "workflows/remind.ts": "export default {};\n",
    },
    "Workflows"
  );
  await verifiedCandidate(app, version);
  await env.DB.prepare(
    "UPDATE apps SET current_version = ?, status = 'published' WHERE id = ?"
  )
    .bind(version, app)
    .run();
  await owner.api.apps.members.add(app, {
    type: "person",
    id: user.userId,
    role: "user",
  });
  const { id: hidden } = await other.api.apps.create({
    name: `Payroll ${unique()}`,
  });
  await Promise.all([
    seedRun(app, "approve", "completed", 0),
    seedRun(app, "approve", "completed", 1),
    seedRun(app, "approve", "failed", 2),
    seedRun(app, "remind", "failed", 0),
    seedRun(app, "remind", "completed", 9),
    seedRun(hidden, "pay", "failed", 0),
  ]);
  return { owner, user, app, name, hidden };
};

/** What `run` returns while the provider answers with `replies`, and what was sent to it. */
const answering = async <T>(
  replies: ProviderReply[],
  run: () => Promise<T>
) => {
  const { requests } = await fakeProvider(...replies);
  return { requests, result: await run() };
};

/** The model's answer: `widget`, as JSON, with a note when given. */
const answer = (widget: unknown, note?: string): ProviderReply => ({
  text: JSON.stringify({ widget, ...(note === undefined ? {} : { note }) }),
  inputTokens: 900,
  outputTokens: 80,
});

/** What each request asked the model, as sent. */
const sentOf = (requests: { body: unknown }[]): string[] =>
  requests.map(({ body }) => JSON.stringify(body));

/** Failures this week by workflow, of the engine `app`. */
const failures = (app: string): WidgetSpec => ({
  title: "Failures this week",
  days: 7,
  parts: [
    {
      type: "number",
      label: "Failed",
      measure: "failed",
      filter: { engines: [app] },
    },
    { type: "bars", measure: "started", by: "workflow" },
  ],
});

describe("widgets Grasp makes from what a person asks", () => {
  it("makes one from their own workflows' numbers, puts it last on their board, and records it", async () => {
    const { owner, app, name, hidden } = await engines();
    const { requests, result } = await answering(
      [answer(failures(app))],
      async () =>
        await owner.api.dashboard.makeWidget(
          "How many runs failed this week, and which workflows ran?"
        )
    );
    const { widget, note } = result;
    const events = await allEvents();
    const made = events.find(
      ({ action, target }) =>
        action === "dashboard.widget_made" && target?.id === widget.id
    );
    const call = events.findLast(
      ({ action, detail }) =>
        action === "model.call" && detail.purpose === "dashboard.widget"
    );
    const [sent = ""] = sentOf(requests);

    expect({
      note,
      view: widget.view,
      asked: widget.asked,
      shown: await owner.api.dashboard.widgets(),
      layout: await owner.api.dashboard.layout(),
      // The model is told the person's engines, never another's.
      toldTheirs: sent.includes(name) && sent.includes(`${app}/remind`),
      toldOthers: sent.includes(hidden),
      made: made?.actor,
      call: { actor: call?.actor, platform: call?.detail.platform },
    }).toStrictEqual({
      note: null,
      view: {
        title: "Failures this week",
        days: 7,
        parts: [
          { type: "number", label: "Failed", measure: "failed", value: 2 },
          {
            type: "bars",
            label: null,
            measure: "started",
            by: "workflow",
            bars: [
              { key: `${app}/approve`, name: "approve", value: 3 },
              { key: `${app}/remind`, name: "remind", value: 1 },
            ],
          },
        ],
      },
      asked: "How many runs failed this week, and which workflows ran?",
      shown: [widget],
      layout: { widgets: [...offeredWidgets(false), widget.id] },
      toldTheirs: true,
      toldOthers: false,
      made: { type: "person", userId: owner.userId },
      call: {
        actor: { type: "person", userId: owner.userId },
        platform: "dashboard_widgets",
      },
    });
  });

  it("works its numbers out as its person sees them now, never as they did when it was made", async () => {
    const { owner, user, app } = await engines();
    const { result } = await answering(
      [answer(failures(app))],
      async () => await user.api.dashboard.makeWidget("Failures this week")
    );
    // The user can no longer open the engine.
    await owner.api.apps.members.remove(app, {
      type: "person",
      id: user.userId,
    });
    const [later] = await user.api.dashboard.widgets();

    expect({
      made: result.widget.view.parts[0],
      later: later?.view.parts,
    }).toStrictEqual({
      made: { type: "number", label: "Failed", measure: "failed", value: 2 },
      later: [
        { type: "number", label: "Failed", measure: "failed", value: 0 },
        {
          type: "bars",
          label: null,
          measure: "started",
          by: "workflow",
          bars: [],
        },
      ],
    });
  });

  it("sends back what doesn't read, doesn't fit or names what isn't theirs, and keeps what it then makes", async () => {
    const { owner, app, hidden } = await engines();
    const tooBig: WidgetSpec = {
      title: "Everything",
      days: 30,
      parts: [
        { type: "table", columns: ["workflow", "failed"], limit: 10 },
        { type: "bars", measure: "failed", by: "workflow", limit: 10 },
        { type: "trend", measure: "failed" },
      ],
    };
    const { requests, result } = await answering(
      [
        // Not a widget: a part the dashboard doesn't have, and code.
        answer({
          title: "Script",
          days: 7,
          parts: [{ type: "html", html: "<script>alert(1)</script>" }],
        }),
        // An engine the person can't open, in a widget too big for a block.
        answer({
          ...tooBig,
          parts: [
            ...tooBig.parts,
            {
              type: "number",
              label: "Pay",
              measure: "failed",
              filter: { engines: [hidden] },
            },
          ],
        }),
        answer(failures(app), "Shown for the week, not the month."),
      ],
      async () =>
        await owner.api.dashboard.makeWidget(
          "Everything that failed this month"
        )
    );
    const [, second = "", third = ""] = sentOf(requests);
    const kept = await owner.api.dashboard.widgets();

    expect({
      calls: requests.length,
      // Each repair says what was wrong with the answer before.
      unknownPart: second.includes("parts.0.type"),
      unknownEngine: third.includes(hidden),
      tooBig: third.includes("units of room"),
      note: result.note,
      kept: kept.map(({ id }) => id),
    }).toStrictEqual({
      calls: 3,
      unknownPart: true,
      unknownEngine: true,
      tooBig: true,
      note: "Shown for the week, not the month.",
      kept: [result.widget.id],
    });
  });

  it("tells the page that asked how it goes, each attempt as it is written, checked, put right and kept, and makes it whatever the page does", async () => {
    const { owner, app } = await engines();
    const told: WidgetProgress[] = [];
    const { result } = await answering(
      [
        // A part the dashboard doesn't have: sent back to be put right.
        answer({
          title: "Script",
          days: 7,
          parts: [{ type: "html", html: "<b>hi</b>" }],
        }),
        answer(failures(app)),
        answer({ ...failures(app), title: "Failed again" }),
      ],
      async () => {
        const made = await owner.api.dashboard.makeWidget(
          "Failures this week",
          (progress) => {
            told.push(progress);
          }
        );
        // A page whose callback fails still gets its widget.
        const anyway = await owner.api.dashboard.makeWidget(
          "Failures again",
          () => {
            throw new Error("The page went away");
          }
        );
        return { made, anyway };
      }
    );
    // Stages in order, each once however often its draft grew.
    const stages = told
      .map((each) =>
        each.stage === "keeping" ? each.stage : `${each.stage} ${each.attempt}`
      )
      .filter((each, at, all) => each !== all[at - 1]);
    const lastDrafts = told.flatMap((each, at) =>
      each.stage === "writing" && told[at + 1]?.stage !== "writing"
        ? [each.draft]
        : []
    );

    expect({
      stages,
      lastDrafts,
      firstDraft: told[0],
      made: result.made.widget.view.title,
      anyway: result.anyway.widget.view.title,
    }).toStrictEqual({
      stages: ["writing 1", "checking 1", "writing 2", "checking 2", "keeping"],
      lastDrafts: [
        // A part the dashboard doesn't have isn't one.
        { title: "Script", parts: [] },
        { title: "Failures this week", parts: ["number", "bars"] },
      ],
      firstDraft: {
        stage: "writing",
        attempt: 1,
        attempts: 3,
        draft: { title: null, parts: [] },
      },
      made: "Failures this week",
      anyway: "Failed again",
    });
  });

  it("gives up after the answer is sent back twice, keeping nothing and recording no widget", async () => {
    const { owner } = await engines();
    const nonsense: ProviderReply = {
      text: "I'd make a pie chart.",
      inputTokens: 10,
      outputTokens: 10,
    };
    const earlier = await allEvents();
    const { requests, result } = await answering(
      [nonsense, nonsense, nonsense, nonsense],
      async () => await outcome(owner.api.dashboard.makeWidget("A pie chart"))
    );
    const later = await allEvents();
    const made = later
      .slice(earlier.length)
      .filter(({ action }) => action.startsWith("dashboard.widget"));

    expect({
      result,
      calls: requests.length,
      kept: await owner.api.dashboard.widgets(),
      layout: await owner.api.dashboard.layout(),
      made,
    }).toStrictEqual({
      result: "dashboard.widget_unreadable",
      calls: 3,
      kept: [],
      layout: null,
      made: [],
    });
  });

  it("changes a widget where it stands, and says so when the answer is the widget as it was", async () => {
    const { owner, app } = await engines();
    const { result: made } = await answering(
      [answer(failures(app))],
      async () => await owner.api.dashboard.makeWidget("Failures")
    );
    const { id } = made.widget;
    await owner.api.dashboard.saveLayout({ widgets: [id, "runs"] });
    const changed: WidgetSpec = {
      title: "Completed this week",
      days: 7,
      parts: [{ type: "number", label: "Completed", measure: "completed" }],
    };
    const { requests, result } = await answering(
      [answer(changed), answer(changed)],
      async () => ({
        changed: await owner.api.dashboard.changeWidget(
          id,
          "Show completed runs instead"
        ),
        again: await outcome(
          owner.api.dashboard.changeWidget(id, "Show completed runs")
        ),
      })
    );
    const [first = ""] = sentOf(requests);
    const events = await allEvents();
    const changedEvent = events.find(
      ({ action, target }) =>
        action === "dashboard.widget_changed" && target?.id === id
    );

    expect({
      id: result.changed.widget.id,
      view: result.changed.widget.view,
      asked: result.changed.widget.asked,
      // The model is given the widget as it was.
      toldCurrent: first.includes("Failures this week"),
      again: result.again,
      layout: await owner.api.dashboard.layout(),
      recorded: changedEvent?.actor,
    }).toStrictEqual({
      id,
      view: {
        title: "Completed this week",
        days: 7,
        parts: [
          {
            type: "number",
            label: "Completed",
            measure: "completed",
            value: 2,
          },
        ],
      },
      asked: "Show completed runs instead",
      toldCurrent: true,
      again: "dashboard.widget_unchanged",
      layout: { widgets: [id, "runs"] },
      recorded: { type: "person", userId: owner.userId },
    });
  });

  it("takes a widget off the board for good, and records it", async () => {
    const { owner, app } = await engines();
    const { result } = await answering(
      [answer(failures(app))],
      async () => await owner.api.dashboard.makeWidget("Failures")
    );
    const { id } = result.widget;
    await owner.api.dashboard.removeWidget(id);
    const events = await allEvents();
    const removed = events.find(
      ({ action, target }) =>
        action === "dashboard.widget_removed" && target?.id === id
    );

    expect({
      kept: await owner.api.dashboard.widgets(),
      layout: await owner.api.dashboard.layout(),
      again: await outcome(owner.api.dashboard.removeWidget(id)),
      onBoard: await outcome(
        owner.api.dashboard.saveLayout({ widgets: ["runs", id] })
      ),
      removed: removed?.actor,
    }).toStrictEqual({
      kept: [],
      layout: { widgets: offeredWidgets(false) },
      again: "dashboard.widget_not_found",
      onBoard: "dashboard.invalid_layout",
      removed: { type: "person", userId: owner.userId },
    });
  });

  it("is each person's own: no one else sees, changes, places or removes it", async () => {
    const { owner, user, app } = await engines();
    const { result } = await answering(
      [answer(failures(app))],
      async () => await owner.api.dashboard.makeWidget("Failures")
    );
    const { id } = result.widget;
    const { requests, result: tried } = await answering([], async () => ({
      widgets: await user.api.dashboard.widgets(),
      change: await outcome(user.api.dashboard.changeWidget(id, "Mine now")),
      remove: await outcome(user.api.dashboard.removeWidget(id)),
      place: await outcome(user.api.dashboard.saveLayout({ widgets: [id] })),
    }));

    const still = await owner.api.dashboard.widgets();

    expect({
      ...tried,
      calls: requests.length,
      still: still.map((each) => each.id),
    }).toStrictEqual({
      widgets: [],
      change: "dashboard.widget_not_found",
      remove: "dashboard.widget_not_found",
      place: "dashboard.invalid_layout",
      calls: 0,
      still: [id],
    });
  });

  it("refuses a request that says nothing or too much before any model is asked", async () => {
    const { owner } = await engines();
    const { requests, result } = await answering([], async () => ({
      empty: await outcome(owner.api.dashboard.makeWidget("   ")),
      long: await outcome(owner.api.dashboard.makeWidget("x".repeat(501))),
      notText: await outcome(
        owner.api.dashboard.makeWidget(
          // SAFETY: invalid on purpose: Cap'n Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          { request: "Failures" } as never
        )
      ),
    }));

    expect({ ...result, calls: requests.length }).toStrictEqual({
      empty: "dashboard.invalid_request",
      long: "dashboard.invalid_request",
      notText: "dashboard.invalid_request",
      calls: 0,
    });
  });

  it("lets go of a widget when the model fails, so it can be asked for again", async () => {
    const { owner, app } = await engines();
    const { result } = await answering(
      [
        { status: 400, errorType: "invalid_request_error" },
        answer(failures(app)),
      ],
      async () => ({
        failed: await outcome(owner.api.dashboard.makeWidget("Failures")),
        again: await outcome(owner.api.dashboard.makeWidget("Failures")),
      })
    );

    const kept = await owner.api.dashboard.widgets();

    expect({
      failed: result.failed === "ok" ? "kept" : "refused",
      again: result.again,
      kept: kept.length,
    }).toStrictEqual({ failed: "refused", again: "ok", kept: 1 });
  });

  it("makes one from a chat for its person, telling the agent only its ID and what was asked", async () => {
    const { owner, app } = await engines();
    // One provider for the chat and the widget: the code step, the widget it
    // asks for, then the chat's answer.
    const { ask, provider } = await chatOf(
      owner.userId,
      codeStep(
        "export default async (self, env) => await env.dashboard.makeWidget({ request: 'What failed lately' });"
      ),
      answer(failures(app)),
      says("It is on your dashboard.")
    );
    await ask("Put this week's failures on my dashboard");
    const [kept] = await owner.api.dashboard.widgets();
    // What the code's step returned to the agent: its next request carries it.
    const toAgent = JSON.stringify(provider.requests.at(-1)?.body ?? null);
    const events = await allEvents();
    const call = events.findLast(
      ({ action, detail }) =>
        action === "model.call" && detail.purpose === "dashboard.widget"
    );

    expect({
      calls: provider.requests.length,
      asked: kept?.asked,
      agentGotId: kept !== undefined && toAgent.includes(kept.id),
      // The widget's title, written from the person's workflows, stays on the dashboard.
      agentGotTitle: toAgent.includes("Failures this week"),
      by: call?.actor.type,
    }).toStrictEqual({
      calls: 3,
      asked: "What failed lately",
      agentGotId: true,
      agentGotTitle: false,
      by: "agent",
    });
  });
});
