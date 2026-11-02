import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { confirmedAnswer } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import {
  decidingWorkflow,
  decisionOf,
  endedRun,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  startedBy,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { newTeam } from "./knowledge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { aroundEngine, resumed, stopped, whileEngineRefuses } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  callAuth,
  entraPerson,
  openRpc,
  outcome,
  signedIn as staffSignedIn,
  signIn,
  staffPerson,
  whoami,
} from "./sign-in.ts";

// A decision a run waits on, from its threat model (R8, WF1 to WF4): a
// run waits for a person's answer, which only the people the decision
// asks can give, signed in, as they are when they answer, never the run's
// own person. A decision link only leads them there. Each case below is a
// way it could go wrong: two answers, a late one, an answer to a run that
// was cancelled, people who changed since they were asked, Grasp staff,
// and an answer that isn't one. Each run is an independent JSON
// workflow's (`grasp.decision`), started and answered through people's
// sessions.
//
// Covered elsewhere, so not here (workflow-decisions.test.ts):
// - an answer whose wake is lost while the run is down: "goes on with the
//   answer once when its wake is lost and the run restarts, asking
//   nothing twice";
// - anyone but its recipient answering, the run's own person among them,
//   and an event of the decision's wake type sent to the run: "is only its
//   recipient, confirmed: not the run's person, an admin, another member,
//   nor an event of its type".
// Gone with App-owned TypeScript workflows (`step.decision`): its
// `from: "person:<starter>"` exception for the run's own person, asking
// the App's owner for a run a trigger started, its cap on how many people
// one decision is from, and its reminders (`remindAfter`). An independent
// workflow's decision never asks its run's person, asks a team past one
// ask's list ("asks more people than one ask lists without failing the
// run, audited by count, and one of them answers"), and has no reminder.

const idp = mockIdp();

const { signedIn } = jsonWorkflowAppsOf(idp);

/** Who publishes, approves and starts the decision workflows here. */
const owners = async () => ({
  admin: await signedIn("admin"),
  builder: await signedIn("builder"),
});

const joinTeam = async (
  admin: Person,
  teamId: string,
  person: Person
): Promise<void> => {
  const response = await callAuth(
    "/organization/add-team-member",
    admin.session,
    { teamId, userId: person.userId }
  );
  expect(response.ok).toBeTruthy();
};

const leaveTeam = async (
  admin: Person,
  teamId: string,
  person: Person
): Promise<void> => {
  const response = await callAuth(
    "/organization/remove-team-member",
    admin.session,
    { teamId, userId: person.userId }
  );
  expect(response.ok).toBeTruthy();
};

/**
 * A run of a new decision workflow of `builder`'s asking `recipient`,
 * waiting `timeout` seconds at most if given, once its decision waits in
 * `asked`'s inbox: the workflow, the run and the decision.
 */
const asking = async (
  people: { admin: Person; builder: Person },
  asked: Person,
  recipient: string,
  timeout?: number
) => {
  const workflow = await decidingWorkflow(people, { recipient, timeout });
  const runId = await startedBy(people.builder, workflow.id);
  const decision = await decisionOf(asked, runId);
  return { workflow, runId, decision };
};

/** How a run ended: its status, and its output's status or its error's code. */
const endOf = async (by: Person, workflow: string, runId: string) => {
  const run = await endedRun(by, workflow, runId);
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

/**
 * The audit events about `decision`, in log order. A decision's events are
 * written with the change they record (opening, asking, an answer, timing
 * out), and `allEvents` drains the outboxes before it reads, so a test
 * reads them once that change is done, without waiting for them.
 */
const eventsOf = async (decision: string) => {
  const events = await allEvents();
  return events.filter(({ target }) => target?.id === decision);
};

/** How many wakes core still owes run `runId` (workflows/wakes.ts). */
const owed = async (runId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS owed FROM workflow_run_wakes WHERE resource_run_id = ?"
  )
    .bind(runId)
    .first<{ owed: number }>();
  return row?.owed ?? 0;
};

describe("decisions", { timeout: 60_000 }, () => {
  afterEach(endLiveResourceRuns);

  it("wait durably across a restart and go on with the real answer and what it carries, audited under the person who decided", async () => {
    const people = await owners();
    const decider = await signedIn("user");
    const { workflow, runId, decision } = await asking(
      people,
      decider,
      `person:${decider.userId}`
    );
    const seen = await decider.api.decisions.get(decision);
    // The run is stopped while it waits, as a deploy or a crash does, and
    // the answer comes in while it's down.
    await stopped(runId);
    const answered = await confirmedAnswer(decider, decision, {
      approved: true,
      payload: { comment: "Matches the PO" },
    });
    await resumed(runId);

    expect({
      seen,
      answered,
      end: await endOf(people.builder, workflow.id, runId),
    }).toMatchObject({
      seen: {
        id: decision,
        run: runId,
        workflowResource: { id: workflow.id, name: workflow.name },
        description: "Greet them?",
        input: { who: "Ada" },
        status: "open",
      },
      answered: {
        status: "approved",
        decided: { by: { userId: decider.userId } },
      },
      end: {
        status: "completed",
        output: { status: `approved by ${decider.userId}: Matches the PO` },
      },
    });
    const audited = await eventsOf(decision);
    const approved = audited.find(
      ({ action }) => action === "workflow.decision.approved"
    );
    expect({
      actions: audited.map(({ action }) => action),
      askedWhom: audited.find(
        ({ action }) => action === "workflow.decision.asked"
      )?.provenance,
      approvedBy: approved?.actor,
      // Who, never what they wrote (R16).
      saysWhatTheyWrote: JSON.stringify(audited).includes("Matches the PO"),
    }).toStrictEqual({
      actions: [
        "workflow.decision.opened",
        "workflow.decision.asked",
        // Confirmed in Grasp's own dialog before it was answered.
        "workflow.decision.confirmed",
        "workflow.decision.approved",
      ],
      // Whom the ask went to, by ID: never their names or emails.
      askedWhom: [decider.userId],
      approvedBy: { type: "person", userId: decider.userId },
      saysWhatTheyWrote: false,
    });
  });

  it("give up a wake the engine refuses for good, or can't be reached for, and leave the run to read its answer at the deadline", async () => {
    const people = await owners();
    const decider = await signedIn("user");
    // The run's inbox is full: the engine will never take the wake, so
    // it is given up at once, rather than sent again for ever.
    const full = await asking(people, decider, `person:${decider.userId}`, 4);
    await aroundEngine(
      async (method, call) => (method === "sendEvent" ? "full" : await call()),
      async () =>
        await confirmedAnswer(decider, full.decision, { approved: true })
    );
    const owedWhenFull = await owed(full.runId);
    // The engine can't be reached at all: the repair tries a bounded
    // number of times (20), then gives the wake up.
    const down = await asking(people, decider, `person:${decider.userId}`);
    const owedAfter = await whileEngineRefuses(
      (method) => method === "sendEvent",
      async () => {
        await confirmedAnswer(decider, down.decision, { approved: true });
        const counts: number[] = [];
        const hours = 60 * 60 * 1000;
        for (let repair = 1; repair <= 21; repair += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one repair at a time
          await runMinuteTasks({}, new Date(Date.now() + repair * 2 * hours));
          if (repair >= 20) {
            // oxlint-disable-next-line no-await-in-loop -- one repair at a time
            counts.push(await owed(down.runId));
          }
        }
        return counts;
      }
    );

    expect({
      owedWhenFull,
      // The run still goes on with the answer, at the decision's deadline.
      end: await endOf(people.builder, full.workflow.id, full.runId),
      owedAfter,
    }).toStrictEqual({
      owedWhenFull: 0,
      end: {
        status: "completed",
        output: { status: `approved by ${decider.userId}` },
      },
      owedAfter: [1, 0],
    });
  });

  it("take the first answer only, whether someone answers twice or two people at once", async () => {
    const people = await owners();
    const anna = await signedIn("user");
    const ben = await signedIn("user");
    const team = await newTeam(people.admin, [anna, ben]);
    const { workflow, runId, decision } = await asking(
      people,
      anna,
      `team:${team}`
    );
    const racing = await Promise.all([
      outcome(confirmedAnswer(anna, decision, { approved: true })),
      outcome(confirmedAnswer(ben, decision, { approved: false })),
    ]);
    const winner = racing[0] === "ok" ? anna : ben;
    // Each of them again, with the other answer than they raced with.
    const again = await Promise.all([
      outcome(confirmedAnswer(anna, decision, { approved: false })),
      outcome(confirmedAnswer(ben, decision, { approved: true })),
    ]);
    const end = await endOf(people.builder, workflow.id, runId);
    const logged = await eventsOf(decision);
    const answers = logged.filter(({ action }) =>
      ["workflow.decision.approved", "workflow.decision.rejected"].includes(
        action
      )
    );

    expect({
      racing: racing.toSorted(),
      again,
      end,
      auditedBy: answers.map(({ actor }) => actor),
    }).toStrictEqual({
      racing: ["decision.closed", "ok"],
      again: ["decision.closed", "decision.closed"],
      end: {
        status: "completed",
        output: {
          status: `${winner === anna ? "approved" : "declined"} by ${winner.userId}`,
        },
      },
      auditedBy: [{ type: "person", userId: winner.userId }],
    });
  });

  it("time out, and refuse an answer after the timeout", async () => {
    const people = await owners();
    const decider = await signedIn("user");
    const { workflow, runId, decision } = await asking(
      people,
      decider,
      `person:${decider.userId}`,
      2
    );
    const end = await endOf(people.builder, workflow.id, runId);

    expect({
      end,
      late: await outcome(
        decider.api.decisions.answer(decision, { approved: true })
      ),
      seen: await decider.api.decisions.get(decision),
    }).toMatchObject({
      // No outcome is made up for it.
      end: { status: "failed", code: "workflow.decision_timed_out" },
      late: "decision.closed",
      seen: { status: "timed_out" },
    });
    const events = await eventsOf(decision);
    expect(events.map(({ action }) => action)).toContain(
      "workflow.decision.timed_out"
    );
  });

  it("refuse an answer once the run is cancelled", async () => {
    const people = await owners();
    const decider = await signedIn("user");
    const { workflow, runId, decision } = await asking(
      people,
      decider,
      `person:${decider.userId}`
    );
    await people.builder.api.workflowResources.terminateRun(workflow.id, runId);
    await endedRun(people.builder, workflow.id, runId);

    const answer = await outcome(
      decider.api.decisions.answer(decision, { approved: true })
    );
    const { status } = await decider.api.decisions.get(decision);
    const events = await eventsOf(decision);
    const refusals = events
      .filter(({ action }) => action === "workflow.decision.answer_refused")
      .map(({ actor, detail }) => ({
        actor,
        run: detail.run,
        errorCode: detail.errorCode,
        // Why, never what they answered.
        saysWhatTheyAnswered: "approved" in detail,
      }));

    expect({ answer, status, refusals }).toStrictEqual({
      answer: "decision.closed",
      status: "closed",
      // The refusal audited under who tried, and why.
      refusals: [
        {
          actor: { type: "person", userId: decider.userId },
          run: runId,
          errorCode: "decision.closed",
          saysWhatTheyAnswered: false,
        },
      ],
    });
  });

  it("refuse an answer past the deadline, even before the run closed the decision", async () => {
    const people = await owners();
    const decider = await signedIn("user");
    const { decision } = await asking(
      people,
      decider,
      `person:${decider.userId}`
    );
    // The run hasn't come round to closing it yet; the deadline has passed.
    await env.DB.prepare(
      "UPDATE workflow_decisions SET expires_at = ? WHERE id = ?"
    )
      .bind(Date.now() - 1000, decision)
      .run();

    await expect(
      outcome(decider.api.decisions.answer(decision, { approved: true }))
    ).resolves.toBe("decision.closed");
  });

  it("never take an answer from Grasp staff, even on an admins' decision", async () => {
    const people = await owners();
    const { decision } = await asking(people, people.admin, "role:admin");
    const staffSession = await staffSignedIn(idp, "grasp-staff", staffPerson());
    const staff = await whoami(staffSession);
    const { core } = await openRpc(staffSession);
    const { decisions } = core.authenticate();

    expect({
      role: staff.role,
      get: await outcome(decisions.get(decision)),
      answer: await outcome(decisions.answer(decision, { approved: true })),
    }).toStrictEqual({
      role: "admin",
      // A staff session reaches no decision at all, only the onboarding.
      get: "role.forbidden",
      answer: "role.forbidden",
    });
  });

  it("bring the person back to the decision's page after signing in", async () => {
    const page = "/decisions/some-decision";
    const person = entraPerson(acmeTenant);
    const { location } = await signIn(idp, "microsoft", person, {
      callbackURL: page,
    });

    expect(location?.endsWith(page)).toBeTruthy();
  });

  it("check who may answer as they are when they answer, not when they were asked", async () => {
    const people = await owners();
    const { admin } = people;
    const leaves = await signedIn("user");
    const joins = await signedIn("user");
    const team = await newTeam(admin, [leaves]);
    const inTeam = await asking(people, leaves, `team:${team}`);
    const demoted = await signedIn("builder");
    const byRole = await asking(people, demoted, "role:builder");
    const removed = await signedIn("user");
    const byPerson = await asking(people, removed, `person:${removed.userId}`);

    await leaveTeam(admin, team, leaves);
    await joinTeam(admin, team, joins);
    await admin.api.members.setRole(demoted.userId, "user");
    await admin.api.members.remove(removed.userId);

    expect({
      leftTheTeam: await outcome(
        leaves.api.decisions.answer(inTeam.decision, { approved: true })
      ),
      demoted: await outcome(
        demoted.api.decisions.answer(byRole.decision, { approved: true })
      ),
      // Refused by their session, or, while the connection still holds
      // it, by the decision: either way before anything is taken.
      removed: ["auth.unauthenticated", "decision.forbidden"].includes(
        await outcome(
          removed.api.decisions.answer(byPerson.decision, { approved: true })
        )
      ),
      // Asked before they joined, so they weren't asked, but may answer.
      joinedTheTeam: await outcome(
        confirmedAnswer(joins, inTeam.decision, { approved: true })
      ),
    }).toStrictEqual({
      leftTheTeam: "decision.forbidden",
      demoted: "decision.forbidden",
      removed: true,
      joinedTheTeam: "ok",
    });
    await expect(
      endOf(people.builder, inTeam.workflow.id, inTeam.runId)
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: `approved by ${joins.userId}` },
    });
  });

  it("refuse an answer that is too large or not of the right shape", async () => {
    const people = await owners();
    const decider = await signedIn("user");
    const { workflow, runId, decision } = await asking(
      people,
      decider,
      `person:${decider.userId}`
    );
    const answer = async (value: unknown) =>
      await outcome(
        decider.api.decisions.answer(
          decision,
          // SAFETY: invalid on purpose: anything a client can send, as Cap'n
          // Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          value as never
        )
      );

    expect({
      tooLarge: await answer({
        approved: true,
        payload: { comment: "x".repeat(5000) },
      }),
      // Who answers comes from the session, never from the request.
      naming: await answer({ approved: true, by: people.builder.userId }),
      notYesOrNo: await answer({ approved: "yes" }),
      missing: await answer({}),
      notAnObject: await answer("approve"),
      unknownDecision: await outcome(
        decider.api.decisions.answer(crypto.randomUUID(), { approved: true })
      ),
    }).toStrictEqual({
      tooLarge: "decision.invalid",
      naming: "decision.invalid",
      notYesOrNo: "decision.invalid",
      missing: "decision.invalid",
      notAnObject: "decision.invalid",
      unknownDecision: "decision.not_found",
    });
    // None of it counted: the decision is still open.
    await confirmedAnswer(decider, decision, {
      approved: true,
      payload: { comment: "Fits" },
    });
    await expect(
      endOf(people.builder, workflow.id, runId)
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: `approved by ${decider.userId}: Fits` },
    });
  });
});
