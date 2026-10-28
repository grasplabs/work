import {
  outcomeCursors,
  outcomesFor,
  outcomesOf,
} from "@grasp-os/brain/outcomes";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { eraseRunCaptures } from "../src/brain-capture.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { sweepRunDetails } from "../src/workflows/retention.ts";
import { projectStatus } from "../src/workflows/runs.ts";
import { model, pointAtGateway, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { workflowFiles, workflowsApp } from "./workflow-apps.ts";

// Settled tasks' outcomes, captured for the Brain with no learning step in
// any task (brain-capture.ts): workflow runs as their row ends, chat turns
// as they settle. The ways capture could fail, tried below:
// 1. A settled task is lost: the process dies, or the Brain is out of
//    reach, between the settle and the delivery.
// 2. A delivery made again becomes a second event.
// 3. Evaluation or test work trains production behaviour.
// 4. A person who was removed, or a record that was erased, stays
//    learnable: delivered after the revocation, or kept after the erasure.
// 5. An event copies what the task read, wrote or said.
// The outside failure is the Brain's database out of reach: a binding
// whose writes fail, as an outage or a crash before delivery leaves it.

const idp = mockIdp();

/** The Brain's database, as the tests' env binds it. */
const knowledge = env.KNOWLEDGE;

/** The Brain's database, with every batch failing: out of reach. */
const unreachable = new Proxy(knowledge, {
  get: (target, property) => {
    if (property === "batch") {
      return async () => {
        await Promise.resolve();
        throw new Error("D1_ERROR: Network connection lost.");
      };
    }
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function"
      ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
      : value;
  },
});

/**
 * The Brain's database, with `first` run just before its first batch
 * lands: a change made between a delivery's check and its write.
 */
const racingKnowledge = (first: () => Promise<unknown>): D1Database => {
  let raced = false;
  return new Proxy(knowledge, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await first();
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/**
 * The Brain's database, with its first batch landing and its reply lost:
 * a delivery that recorded its event and stopped before its check after.
 * `first` runs just before that batch lands, `lostNow` as its reply goes.
 */
const lostReply = (
  first: () => Promise<unknown> = async () => {
    await Promise.resolve();
  },
  lostNow: () => void = () => {
    // Nothing to note.
  }
): D1Database => {
  let lost = false;
  return new Proxy(knowledge, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!lost) {
            await first();
          }
          const results = await target.batch(statements);
          if (!lost) {
            lost = true;
            lostNow();
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/** The Brain's events of the run or chat `id`. */
const eventsOf = async (id: string) => await outcomesOf(brainOf(env), id);

/** How each of the Brain's events of `id` says its execution ended. */
const executionsOf = async (id: string): Promise<string[]> => {
  const events = await eventsOf(id);
  return events.map(({ execution }) => execution);
};

/** The highest sequence the Brain has recorded of runs' captures. */
const runCursor = async (): Promise<number> => {
  const cursors = await outcomeCursors(brainOf(env));
  return cursors.find(({ source }) => source === "workflow.run")?.seq ?? 0;
};

/** The capture intent of run `run` in core's database, if any is left. */
const runIntent = async (run: string) =>
  await env.DB.prepare(
    "SELECT seq, state, attempts, last_error AS lastError FROM brain_capture_intents WHERE evidence_id = ?"
  )
    .bind(run)
    .first<{
      seq: number;
      state: string;
      attempts: number;
      lastError: string | null;
    }>();

/** A new App of `builder`'s, `published` or a draft. */
const newApp = async (published: boolean) => {
  const builder = await signedInApi(idp, "builder");
  if (published) {
    const app = await workflowsApp(
      builder,
      workflowFiles(
        "tidy",
        `return await step.do("one", { description: "Tidy up" }, async () => 1);`,
        { one: 1 }
      )
    );
    return { builder, app };
  }
  const { id: app } = await builder.api.apps.create({ name: "Invoices" });
  return { builder, app };
};

/** A running run of App `app`'s, started by `startedBy`, as its row is. */
const runningRun = async (app: string, startedBy: string): Promise<string> => {
  const run = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'tidy', 1, ?, 'running', ?)"
  )
    .bind(run, app, startedBy, Date.now())
    .run();
  return run;
};

/** The engine's notification that `run` completed, on `on`. */
const completed = async (run: string, on: Env = env): Promise<void> => {
  await projectStatus(on, run, {
    status: "complete",
    at: Date.now(),
    sequence: 9,
  });
};

/** Once the background delivery after a settle has failed once. */
const failedOnce = async (run: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(runIntent(run)).resolves.toMatchObject({
        state: "pending",
        attempts: 1,
      });
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** How many `action` events the audit log has of `id`. */
const audited = async (action: string, id: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === action && event.target?.id === id
  ).length;
};

describe("a workflow run's outcome", () => {
  it("is captured once, with no learning step, when an ordinary run ends", async () => {
    const { builder, app } = await newApp(true);
    const run = await builder.api.workflows.start(app, "tidy");
    await finished(run.id);

    const [event] = await vi.waitFor(
      async () => {
        const events = await eventsOf(run.id);
        expect(events).toHaveLength(1);
        return events;
      },
      { timeout: 10_000, interval: 100 }
    );

    const { endedAt } = await builder.api.workflows.status(run.id);

    expect({ event, intent: await runIntent(run.id) }).toStrictEqual({
      event: {
        eventId: `workflow.run:${run.id}`,
        source: "workflow.run",
        ownerId: builder.userId,
        scope: "person",
        audience: null,
        taskType: `workflow:${app}/tidy`,
        execution: "completed",
        // Completing is not success: no check the host trusts says so.
        result: "unknown",
        evidenceId: run.id,
        // References to the run, never its input or output.
        evidenceRefs: [{ kind: "workflow_run", id: run.id }],
        versionRefs: [
          { kind: "app", id: app, version: "1" },
          { kind: "workflow", id: "tidy" },
        ],
        // When the run ended, as its row says.
        occurredAt: endedAt,
      },
      intent: null,
    });
  });

  it("survives the Brain being out of reach between the run's end and delivery", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);

    await completed(run, { ...env, KNOWLEDGE: unreachable });
    await failedOnce(run);
    const lost = await eventsOf(run);
    // The clock's catch-up, with the Brain back.
    await runMinuteTasks();
    const seq = await runCursor();

    expect({
      lost,
      repaired: await executionsOf(run),
      intent: await runIntent(run),
      cursorReached: seq > 0,
    }).toStrictEqual({
      lost: [],
      repaired: ["completed"],
      intent: null,
      cursorReached: true,
    });
  });

  it("stays one event when it is delivered again", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    await completed(run);
    await vi.waitFor(
      async () => {
        await expect(runIntent(run)).resolves.toBeNull();
      },
      { timeout: 10_000, interval: 100 }
    );

    // As though the intent's removal was lost after the Brain had it.
    await env.DB.prepare(
      "INSERT INTO brain_capture_intents (event_id, evidence_id, state, attempts, created_at) VALUES (?, ?, 'pending', 0, ?)"
    )
      .bind(`workflow.run:${run}`, run, Date.now())
      .run();
    await runMinuteTasks();

    expect({
      events: await executionsOf(run),
      intent: await runIntent(run),
      recorded: await audited(
        "knowledge.episode.recorded",
        `workflow.run:${run}`
      ),
    }).toStrictEqual({ events: ["completed"], intent: null, recorded: 1 });
  });

  it("is never captured for a draft App's run, its builder trying it", async () => {
    const { builder, app } = await newApp(false);
    const run = await runningRun(app, builder.userId);

    await completed(run);
    await runMinuteTasks();

    expect({
      events: await eventsOf(run),
      intent: await runIntent(run),
    }).toStrictEqual({ events: [], intent: null });
  });

  it("isn't delivered once its person is removed before delivery", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    const admin = await signedInApi(idp, "admin");

    await completed(run, { ...env, KNOWLEDGE: unreachable });
    await failedOnce(run);
    await admin.api.members.remove(builder.userId);
    await runMinuteTasks();

    expect({
      events: await eventsOf(run),
      intent: await runIntent(run),
    }).toStrictEqual({ events: [], intent: null });
  });

  it("is taken back when its person is removed while it is recorded", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    const admin = await signedInApi(idp, "admin");
    const racing = racingKnowledge(
      async () => await admin.api.members.remove(builder.userId)
    );

    await completed(run, { ...env, KNOWLEDGE: racing });
    await vi.waitFor(
      async () => {
        await expect(runIntent(run)).resolves.toBeNull();
      },
      { timeout: 10_000, interval: 100 }
    );

    expect({
      events: await eventsOf(run),
      // Recorded, then taken back: each audited once.
      recorded: await audited(
        "knowledge.episode.recorded",
        `workflow.run:${run}`
      ),
      erased: await audited("knowledge.episode.erased", `workflow.run:${run}`),
    }).toStrictEqual({ events: [], recorded: 1, erased: 1 });
  });

  it("is taken back on its next delivery when the last one recorded it and stopped short, its person removed meanwhile", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    const admin = await signedInApi(idp, "admin");

    await completed(run, { ...env, KNOWLEDGE: lostReply() });
    await failedOnce(run);
    const recordedBefore = await executionsOf(run);
    await admin.api.members.remove(builder.userId);
    await runMinuteTasks();

    expect({
      recordedBefore,
      events: await eventsOf(run),
      intent: await runIntent(run),
    }).toStrictEqual({
      recordedBefore: ["completed"],
      events: [],
      intent: null,
    });
  });

  it("stays taken back when another delivery found it ineligible while one from before was recorded and its reply lost", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    const admin = await signedInApi(idp, "admin");
    // The first delivery's check passes. Before its record lands, its
    // person is removed and another drain finds the intent ineligible,
    // takes the event back (none yet) and removes the intent. Then the
    // first delivery's record lands and its reply is lost: no intent is
    // left to take the event back later.
    let lost = false;
    const racing = lostReply(
      async () => {
        await admin.api.members.remove(builder.userId);
        await runMinuteTasks();
      },
      () => {
        lost = true;
      }
    );

    await completed(run, { ...env, KNOWLEDGE: racing });
    await vi.waitFor(
      () => {
        expect(lost).toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
    await runMinuteTasks();

    expect({
      events: await eventsOf(run),
      intent: await runIntent(run),
      recorded: await audited(
        "knowledge.episode.recorded",
        `workflow.run:${run}`
      ),
    }).toStrictEqual({ events: [], intent: null, recorded: 0 });
  });

  it("isn't recorded again after a personal purge erased it, when its delivery is made again", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    const admin = await signedInApi(idp, "admin");
    // A personal purge needs the person's own collection.
    await builder.api.memory.collections();

    await completed(run, { ...env, KNOWLEDGE: lostReply() });
    await failedOnce(run);
    const recordedBefore = await executionsOf(run);
    const input = {
      type: "personal" as const,
      userId: builder.userId,
      reason: "offboarding" as const,
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);
    // Still a member: the delivery made again finds the run eligible.
    await runMinuteTasks();

    expect({
      recordedBefore,
      events: await eventsOf(run),
      intent: await runIntent(run),
      recorded: await audited(
        "knowledge.episode.recorded",
        `workflow.run:${run}`
      ),
    }).toStrictEqual({
      recordedBefore: ["completed"],
      events: [],
      intent: null,
      recorded: 1,
    });
  });

  it("stays erased when its run's details go between its check and a delivery whose reply is lost", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    // The check passes, then retention erases the run's captures, then the
    // delivery's record lands and its reply is lost.
    let lost = false;
    const racing = lostReply(
      async () => {
        await eraseRunCaptures(env, [run]);
      },
      () => {
        lost = true;
      }
    );

    await completed(run, { ...env, KNOWLEDGE: racing });
    await vi.waitFor(
      () => {
        expect(lost).toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
    await runMinuteTasks();

    expect({
      events: await eventsOf(run),
      intent: await runIntent(run),
      recorded: await audited(
        "knowledge.episode.recorded",
        `workflow.run:${run}`
      ),
    }).toStrictEqual({ events: [], intent: null, recorded: 0 });
  });

  it("goes with the run's details when its retention is over", async () => {
    const { builder, app } = await newApp(true);
    const run = await runningRun(app, builder.userId);
    await completed(run);
    const captured = await vi.waitFor(
      async () => {
        const events = await eventsOf(run);
        expect(events).toHaveLength(1);
        return events.length;
      },
      { timeout: 10_000, interval: 100 }
    );

    await sweepRunDetails(
      { ...env, RUN_RETENTION_DAYS: "1" },
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    );

    expect({
      captured,
      after: await eventsOf(run),
      erased: await audited("knowledge.episode.erased", run),
    }).toStrictEqual({ captured: 1, after: [], erased: 1 });
  });
});

/** A member with their own chats, answered by `replies`. */
const chatter = async (...replies: Parameters<typeof fakeGateway>) => {
  const person = await signedInApi(idp, "user");
  const stub = workspace(env, personalWorkspaceId(person.userId));
  await pointAtGateway(stub, fakeGateway(...replies));
  const chat = await person.api.chats.create("Questions");
  const id = chatIdSchema.parse(chat.id);
  const ask = async () => await stub.ask(id, { text: "Hello?", model });
  return { person, stub, id, ask };
};

/** The object's capture intents of chat `chatId`. */
const turnIntents = async (
  stub: ReturnType<typeof workspace>,
  chatId: string
) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM brain_capture_intents WHERE evidence_id = ?",
        chatId
      )
      .toArray()
  );

/** Sets the object's Brain database binding, as its env has it. */
const objectKnowledge = async (
  stub: ReturnType<typeof workspace>,
  binding: D1Database
): Promise<void> => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Workspace object has no env");
    }
    Object.assign(objectEnv, { KNOWLEDGE: binding });
  });
};

describe("a chat turn's outcome", () => {
  it("is captured once the turn settles, and goes when its chat is deleted", async () => {
    const { person, id, ask } = await chatter(says("Floor 3."));
    await ask();

    const [event] = await vi.waitFor(
      async () => {
        const events = await eventsOf(id);
        expect(events).toHaveLength(1);
        return events;
      },
      { timeout: 10_000, interval: 100 }
    );
    await person.api.chats.remove(id);

    expect({ event, after: await eventsOf(id) }).toMatchObject({
      event: {
        source: `chat.turn:${personalWorkspaceId(person.userId)}`,
        ownerId: person.userId,
        scope: "person",
        taskType: "chat.turn",
        execution: "completed",
        result: "unknown",
        evidenceId: id,
      },
      after: [],
    });
    // Identifiers only: nothing of the question or the answer.
    expect(JSON.stringify(event)).not.toMatch(/Floor 3|Hello/u);
  });

  it("survives the Brain being out of reach as the turn settles, through the object's alarm", async () => {
    const { stub, id, ask } = await chatter(says("Floor 3."));
    await objectKnowledge(stub, unreachable);
    try {
      await ask();
      await vi.waitFor(
        async () => {
          await expect(turnIntents(stub, id)).resolves.toStrictEqual([
            { state: "pending", attempts: 1 },
          ]);
        },
        { timeout: 10_000, interval: 100 }
      );
    } finally {
      // Objects may share the tests' env: the binding as it was.
      await objectKnowledge(stub, knowledge);
    }
    const lost = await eventsOf(id);

    await runDurableObjectAlarm(stub);

    expect({
      lost,
      repaired: await executionsOf(id),
      intents: await turnIntents(stub, id),
    }).toStrictEqual({ lost: [], repaired: ["completed"], intents: [] });
  });

  it("is never captured in a chat in restricted mode", async () => {
    const { stub, id, ask } = await chatter(says("Floor 3."));
    await runInDurableObject(stub, (instance) => instance.restrictChat(id));

    await ask();
    await runDurableObjectAlarm(stub);

    expect({
      events: await eventsOf(id),
      intents: await turnIntents(stub, id),
    }).toStrictEqual({ events: [], intents: [] });
  });

  it("is one experience for exactly a shared chat's members, reached only while they stay", async () => {
    const ann = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const cas = await signedInApi(idp, "user");
    const dee = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const stub = workspace(env, personalWorkspaceId(ann.userId));
    await pointAtGateway(stub, fakeGateway(says("Floor 3."), says("Floor 4.")));
    const agentId = crypto.randomUUID();
    /** Ann asks in the group, as its door does, with who is in it now. */
    const askInGroup = async (members: string[]) =>
      await stub.askThrough(ann.userId, agentId, "slack", "Hello?", undefined, {
        thread: "C1",
        kind: "group",
        audience: { members, outsiders: false },
      });
    /** The shared events of the chat each person reaches now. */
    const reached = async (chatId: string) =>
      await Promise.all(
        [ann, ben, cas, dee].map(async (someone) => {
          const events = await outcomesFor(brainOf(env), {
            type: "person",
            person: await someone.api.whoami(),
          });
          return events.filter(({ evidenceId }) => evidenceId === chatId)
            .length;
        })
      );

    const { chatId } = await askInGroup([ann.userId, ben.userId, cas.userId]);
    const [event] = await vi.waitFor(
      async () => {
        const events = await eventsOf(chatId);
        expect(events).toHaveLength(1);
        return events;
      },
      { timeout: 10_000, interval: 100 }
    );
    const atFirst = await reached(chatId);
    // Ben leaves the group (the next turn's roster), and Cas the company.
    await askInGroup([ann.userId, cas.userId]);
    await vi.waitFor(
      async () => {
        await expect(eventsOf(chatId)).resolves.toHaveLength(2);
      },
      { timeout: 10_000, interval: 100 }
    );
    await admin.api.members.remove(cas.userId);

    expect({
      event: { scope: event?.scope, audience: event?.audience },
      // Ann, Ben, Cas; never Dee, who was never in it.
      atFirst,
      // Ann reaches both; Ben neither, having left; Cas none, gone.
      after: await reached(chatId),
    }).toStrictEqual({
      event: { scope: "session", audience: chatId },
      atFirst: [1, 1, 1, 0],
      after: [2, 0, 0, 0],
    });
  });
});
