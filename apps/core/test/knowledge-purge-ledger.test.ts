import {
  attemptHolds,
  attemptHoldsOrIdle,
  finishPurge,
  openPurge,
  purgeAttemptLeaseMs,
  purgeStatus,
  runStep,
  whileHeld,
} from "@grasp-os/brain/purge-ledger";
import {
  owedWritesDoneWhile,
  rebuildOwedWhile,
} from "@grasp-os/brain/search-erasure";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { brainOf } from "../src/knowledge/ports.ts";
import { mockIdp } from "./idp.ts";
import { setUpTime } from "./knowledge-purge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The ledger a person's purge from Knowledge runs on (GRA-1122; since
// GRA-1911 the only purge left, person-erasure.ts `purgeFromKnowledge`).
// An admin's erasure and the clock's `members.erasures` can run the same
// person's purge at once, and an attempt can die part way. The ways it can
// fail, tried here: two runs both writing; a run that finished, or lost
// its hold, changing what another did; a rebuild of the search index left
// unowed; a failed step losing what its committed batches counted.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

/** Each step of a purge's status, as `step: state` or `step: state: reason`. */
const stateOf = (status: {
  steps: readonly { step: string; state: string; reason: string | null }[];
}) =>
  Object.fromEntries(
    status.steps.map(({ step, state, reason }) => [
      step,
      reason === null ? state : `${state}: ${reason}`,
    ])
  );

describe("a person's purge's record", setUpTime, () => {
  it("lets one run at a time hold a purge, and a trailing run change nothing of one that finished", async () => {
    const admin = await personOf("admin");
    const brain = brainOf(env);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "personal" as const,
      userId: `leaver-${unique()}`,
      reason: "erasure_request" as const,
    };
    const open = async () =>
      await openPurge(
        brain,
        by,
        input,
        ["one"],
        {},
        () => [],
        () => []
      );
    const first = await open();
    // A second run while the first holds it, within its lease.
    const secondRun = await outcome(open());
    await runStep(brain, first, "one", async () => {
      await Promise.resolve();
    });
    await finishPurge(brain, first);
    // The first run's handle, trailing after it finished, failing a step.
    const trailing = await outcome(
      runStep(brain, first, "one", async () => {
        await Promise.resolve();
        throw new Error("too late");
      })
    );
    const status = await purgeStatus(brain, first.purgeId);

    expect({
      secondRun,
      trailing,
      state: status.state,
      steps: stateOf(status),
    }).toStrictEqual({
      secondRun: "knowledge.conflict",
      trailing: "knowledge.conflict",
      state: "complete",
      steps: { one: "complete" },
    });
  });

  it("keeps the rebuild owed when an attempt that lost its purge marks its writes done", async () => {
    const admin = await personOf("admin");
    let now = Date.now();
    const real = brainOf(env);
    const brain = {
      ...real,
      ports: { ...real.ports, clock: () => new Date(now) },
    };
    const db = drizzle(env.KNOWLEDGE);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "personal" as const,
      userId: `leaver-${unique()}`,
      reason: "erasure_request" as const,
    };
    const open = async () =>
      await openPurge(
        brain,
        by,
        input,
        ["one"],
        {},
        () => [],
        (held, at) => [
          rebuildOwedWhile(db, held.purgeId, attemptHolds(held, at)),
        ]
      );
    const lapsed = await open();
    // Its lease runs out; another run takes the purge over and writes.
    now += purgeAttemptLeaseMs + 1000;
    const current = await open();
    const marked = await whileHeld(brain, lapsed, (at) => [
      owedWritesDoneWhile(db, lapsed.purgeId, attemptHoldsOrIdle(lapsed, at)),
    ]);
    const row = await env.KNOWLEDGE.prepare(
      "SELECT writes_done_at AS done FROM search_rebuilds WHERE id = ?"
    )
      .bind(lapsed.purgeId)
      .first<{ done: number | null }>();
    // Owed for good otherwise: later tests would count its rebuild.
    await env.KNOWLEDGE.prepare("DELETE FROM search_rebuilds WHERE id = ?")
      .bind(lapsed.purgeId)
      .run();

    expect({
      samePurge: current.purgeId === lapsed.purgeId,
      marked,
      // Still owed as written to: another purge's rebuild leaves it.
      owed: row !== null,
      writesDone: row?.done,
    }).toStrictEqual({
      samePurge: true,
      marked: false,
      owed: true,
      writesDone: null,
    });
  });

  it("keeps what each committed batch of a step counted when the step then fails, and adds a run again's", async () => {
    const admin = await personOf("admin");
    const brain = brainOf(env);
    const by = {
      actor: { type: "person", userId: admin.userId },
      userId: admin.userId,
    };
    const input = {
      type: "personal" as const,
      userId: `leaver-${unique()}`,
      reason: "erasure_request" as const,
    };
    const open = async () =>
      await openPurge(
        brain,
        by,
        input,
        ["versions"],
        {},
        () => [],
        () => []
      );
    const first = await open();
    const failed = await outcome(
      runStep(brain, first, "versions", async (save) => {
        // A page of versions rewritten, its count with it; the next fails.
        await brain.db.batch([save({ versions: 5 })]);
        throw new Error("D1 is unavailable");
      })
    );
    const blocked = await purgeStatus(brain, first.purgeId);
    const again = await open();
    const total = await runStep(brain, again, "versions", async (save) => {
      await brain.db.batch([save({ versions: 2 })]);
      return { versions: 2 };
    });

    expect({
      failed,
      blocked: blocked.steps.map(({ state, counts }) => ({ state, counts })),
      total,
    }).toStrictEqual({
      failed: "Error: D1 is unavailable",
      blocked: [{ state: "blocked", counts: { versions: 5 } }],
      total: { versions: 7 },
    });
  });
});
