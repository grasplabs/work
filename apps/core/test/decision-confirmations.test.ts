import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { answerDecision } from "../src/decisions/decisions.ts";
import { allEvents } from "./audit-events.ts";
import { asking, confirmedAnswer, outputOf, week } from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { racingDb } from "./racing-db.ts";
import { endLiveRuns, whileEngineRefuses } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// The one-use confirmation a person gives in the trusted host decision UI
// before their answer is recorded, from its threat model (GRA-624): an
// answer with no confirmation, a made-up one, one used before, one for
// another decision, person or answer, one given against a review context
// that changed since, one that expired, and the confirmation being taken
// without its answer or its answer without it. The screen bridge's own
// cases are in screen-workflows.test.ts.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user"): Promise<Person> =>
  await signedInApi(idp, role);

/** `person`'s confirmation of `answer` to `decision`, as reviewed now. */
const confirmationOf = async (
  person: Person,
  decision: string,
  answer: { approved: boolean; payload?: { comment: string } }
): Promise<string> => {
  const { revision } = await person.api.decisions.get(decision);
  const { confirmation } = await person.api.decisions.confirm(
    decision,
    revision,
    answer
  );
  return confirmation;
};

/** How many confirmations are kept for `decision`. */
const keptFor = async (decision: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS kept FROM workflow_decision_confirmations WHERE decision_id = ?"
  )
    .bind(decision)
    .first<{ kept: number }>();
  return row?.kept ?? 0;
};

/** The codes of the refused answers audited for `decision`, in order. */
const refusalsOf = async (decision: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.decision.answer_refused" && target?.id === decision
    )
    .map(({ detail }) => ({
      code: detail.errorCode,
      ...(detail.stage === undefined ? {} : { stage: detail.stage }),
    }));
};

describe("decision confirmations", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("take an answer only with its person's confirmation of exactly that answer to exactly that decision", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const ben = await personApi("user");
    const team = await newTeam(admin, [anna, ben]);
    const { run, decision } = await asking(admin, {
      from: `team:${team}`,
      timeout: week,
    });
    const other = await asking(admin, { from: `team:${team}`, timeout: week });
    const rejecting = await confirmationOf(anna, decision, {
      approved: false,
      payload: { comment: "Wrong total" },
    });
    const forOther = await confirmationOf(anna, other.decision, {
      approved: true,
    });
    const bens = await confirmationOf(ben, decision, { approved: true });

    const refused = {
      none: await outcome(
        anna.api.decisions.answer(decision, { approved: true })
      ),
      madeUp: await outcome(
        anna.api.decisions.answer(
          decision,
          { approved: true },
          "bm90LWEtY29uZmlybWF0aW9u"
        )
      ),
      // Confirmed as a rejection with a comment: neither an approval nor
      // another comment is what was confirmed.
      approving: await outcome(
        anna.api.decisions.answer(decision, { approved: true }, rejecting)
      ),
      otherComment: await outcome(
        anna.api.decisions.answer(
          decision,
          { approved: false, payload: { comment: "Fine" } },
          rejecting
        )
      ),
      otherDecision: await outcome(
        anna.api.decisions.answer(decision, { approved: true }, forOther)
      ),
      otherPerson: await outcome(
        anna.api.decisions.answer(decision, { approved: true }, bens)
      ),
    };
    const { status: stillOpen } = await anna.api.decisions.get(decision);
    // Exactly what was confirmed is taken, once, and the confirmation with it.
    const answered = await anna.api.decisions.answer(
      decision,
      { approved: false, payload: { comment: "Wrong total" } },
      rejecting
    );
    const keptAfter = await keptFor(decision);

    expect({
      refused,
      stillOpen,
      answered: answered.status,
      keptAfter,
      output: await outputOf(admin, run.id),
      refusals: await refusalsOf(decision),
    }).toStrictEqual({
      refused: {
        none: "decision.unconfirmed",
        madeUp: "decision.unconfirmed",
        approving: "decision.unconfirmed",
        otherComment: "decision.unconfirmed",
        otherDecision: "decision.unconfirmed",
        otherPerson: "decision.unconfirmed",
      },
      stillOpen: "open",
      answered: "rejected",
      // Ben's confirmation went with the decision's answer too: it can't
      // answer anything any more, and isn't kept.
      keptAfter: 0,
      output: {
        timedOut: false,
        approved: false,
        by: anna.userId,
        payload: { comment: "Wrong total" },
      },
      refusals: Array.from({ length: 6 }, () => ({
        code: "decision.unconfirmed",
      })),
    });
  });

  it("use a confirmation once, keep only the latest one, and never one past its time", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const first = await confirmationOf(decider, decision, { approved: true });
    // Confirming again replaces the first.
    const second = await confirmationOf(decider, decision, { approved: true });
    const replaced = await outcome(
      decider.api.decisions.answer(decision, { approved: true }, first)
    );
    await env.DB.prepare(
      "UPDATE workflow_decision_confirmations SET expires_at = ? WHERE decision_id = ?"
    )
      .bind(Date.now() - 1000, decision)
      .run();
    const expired = await outcome(
      decider.api.decisions.answer(decision, { approved: true }, second)
    );
    const third = await confirmationOf(decider, decision, { approved: true });
    const answered = await outcome(
      decider.api.decisions.answer(decision, { approved: true }, third)
    );
    // Used: sending it again with another answer finds the decision taken.
    const reused = await outcome(
      decider.api.decisions.answer(
        decision,
        { approved: true, payload: { comment: "again" } },
        third
      )
    );

    expect({
      replaced,
      expired,
      answered,
      reused,
      kept: await keptFor(decision),
    }).toStrictEqual({
      replaced: "decision.unconfirmed",
      expired: "decision.unconfirmed",
      answered: "ok",
      reused: "decision.closed",
      kept: 0,
    });
  });

  it("refuse an answer confirmed against a review context that changed since, as a conflict", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const seen = await decider.api.decisions.get(decision);
    const confirmation = await confirmationOf(decider, decision, {
      approved: true,
    });
    // What is asked changes after it was reviewed and confirmed (here, as
    // when the run's details are removed).
    await env.DB.prepare(
      "UPDATE workflow_decisions SET description = 'Approve the other invoice' WHERE id = ?"
    )
      .bind(decision)
      .run();

    const answering = await outcome(
      decider.api.decisions.answer(decision, { approved: true }, confirmation)
    );
    // Confirming against what was seen before is a conflict too.
    const confirming = await outcome(
      decider.api.decisions.confirm(decision, seen.revision, { approved: true })
    );
    const now = await decider.api.decisions.get(decision);
    // Reviewed again, the new context is answered.
    const answered = await confirmedAnswer(decider, decision, {
      approved: true,
    });

    expect({
      answering,
      confirming,
      changed: now.revision !== seen.revision,
      stillOpen: now.status,
      answered: answered.status,
      refusals: await refusalsOf(decision),
    }).toStrictEqual({
      answering: "decision.conflict",
      confirming: "decision.conflict",
      changed: true,
      stillOpen: "open",
      answered: "approved",
      refusals: [
        { code: "decision.conflict" },
        { code: "decision.conflict", stage: "confirm" },
      ],
    });
  });

  it("take the confirmation only with its answer, and give a recorded answer back without asking again", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    // The run's cancel is admitted while the engine can't stop it: the
    // decision takes no answer, and the confirmation isn't spent on it.
    const cancelled = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const unspent = await confirmationOf(decider, cancelled.decision, {
      approved: true,
    });
    await whileEngineRefuses(
      (method) => method === "terminate",
      async () => await outcome(builder.api.workflows.cancel(cancelled.run.id))
    );
    const refused = await outcome(
      decider.api.decisions.answer(
        cancelled.decision,
        { approved: true },
        unspent
      )
    );
    const keptAfterRefusal = await keptFor(cancelled.decision);

    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const confirmation = await confirmationOf(decider, decision, {
      approved: true,
    });
    // The same confirmed answer sent twice at once, as a retry racing its
    // original: one answer, one audit entry, one wake.
    const racing = await Promise.all([
      outcome(
        decider.api.decisions.answer(decision, { approved: true }, confirmation)
      ),
      outcome(
        decider.api.decisions.answer(decision, { approved: true }, confirmation)
      ),
    ]);
    const review = await decider.api.decisions.review(decision, {
      approved: true,
    });
    const otherReview = await outcome(
      decider.api.decisions.review(decision, { approved: false })
    );
    const output = await outputOf(builder, run.id);
    const logged = await allEvents();
    const answers = logged.filter(
      ({ action, target }) =>
        action === "workflow.decision.approved" && target?.id === decision
    );

    expect({
      refused,
      keptAfterRefusal,
      racing,
      review: review.state,
      otherReview,
      output,
      answers: answers.length,
      kept: await keptFor(decision),
    }).toStrictEqual({
      refused: "decision.closed",
      keptAfterRefusal: 1,
      racing: ["ok", "ok"],
      review: "recorded",
      otherReview: "decision.closed",
      output: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: null,
      },
      answers: 1,
      kept: 0,
    });
  });

  it("show the answer as it is recorded, and take it whatever order its payload's keys come in", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const review = await decider.api.decisions.review(decision, {
      approved: true,
      payload: { total: 42, comment: "ok", nested: { b: 1, a: null } },
    });
    if (review.state !== "review") {
      throw new Error("Already recorded");
    }
    const { confirmation } = await decider.api.decisions.confirm(
      decision,
      review.decision.revision,
      review.response
    );
    const answered = await outcome(
      decider.api.decisions.answer(
        decision,
        {
          approved: true,
          payload: { nested: { a: null, b: 1 }, comment: "ok", total: 42 },
        },
        confirmation
      )
    );

    expect({
      response: JSON.stringify(review.response),
      answered,
      output: await outputOf(builder, run.id),
    }).toStrictEqual({
      response:
        '{"approved":true,"payload":{"comment":"ok","nested":{"a":null,"b":1},"total":42}}',
      answered: "ok",
      output: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: { comment: "ok", nested: { a: null, b: 1 }, total: 42 },
      },
    });
  });

  it("recheck the confirmation and the reviewed context in the answer's own write, not only before it", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const by = await decider.api.whoami();
    /**
     * `decider`'s confirmed approval of `decision`, with `meanwhile` done
     * once, after core checked the confirmation and the context and just
     * before the answer's write lands: what another tab or core itself
     * changes in between.
     */
    const racing = async (
      decision: string,
      meanwhile: (db: D1Database) => Promise<unknown>
    ) => {
      const confirmation = await confirmationOf(decider, decision, {
        approved: true,
      });
      let done = false;
      const db = racingDb(async (target) => {
        if (!done) {
          done = true;
          await meanwhile(target);
        }
      });
      return await outcome(
        answerDecision(
          { ...env, DB: db },
          by,
          decision,
          { approved: true },
          confirmation
        )
      );
    };
    const reminted = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const emptied = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const extended = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const expiring = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    let fresh = "";

    const answers = {
      // Confirmed again in another tab: the first confirmation is gone.
      reminted: await racing(reminted.decision, async () => {
        fresh = await confirmationOf(decider, reminted.decision, {
          approved: true,
        });
      }),
      // What is asked changes, as when the run's details are removed.
      emptied: await racing(
        emptied.decision,
        async (db) =>
          await db
            .prepare(
              "UPDATE workflow_decisions SET description = '' WHERE id = ?"
            )
            .bind(emptied.decision)
            .run()
      ),
      // Until when it is asked changes.
      extended: await racing(
        extended.decision,
        async (db) =>
          await db
            .prepare(
              "UPDATE workflow_decisions SET expires_at = expires_at + 1000 WHERE id = ?"
            )
            .bind(extended.decision)
            .run()
      ),
      // The confirmation runs out while the answer is on its way: what
      // counts is the time the write runs, not the time it was read.
      expiring: await racing(expiring.decision, async (db) => {
        // Well after core read the time it answers at.
        await scheduler.wait(20);
        return await db
          .prepare(
            "UPDATE workflow_decision_confirmations SET expires_at = ? WHERE decision_id = ?"
          )
          .bind(Date.now() - 5, expiring.decision)
          .run();
      }),
    };
    const statuses = await Promise.all(
      [reminted, emptied, extended, expiring].map(async ({ decision }) => {
        const { status } = await decider.api.decisions.get(decision);
        return status;
      })
    );
    // The confirmation that replaced the first is taken.
    const withFresh = await outcome(
      decider.api.decisions.answer(reminted.decision, { approved: true }, fresh)
    );

    expect({ answers, statuses, withFresh }).toStrictEqual({
      answers: {
        reminted: "decision.unconfirmed",
        emptied: "decision.conflict",
        extended: "decision.conflict",
        expiring: "decision.unconfirmed",
      },
      statuses: ["open", "open", "open", "open"],
      withFresh: "ok",
    });
  });
});
