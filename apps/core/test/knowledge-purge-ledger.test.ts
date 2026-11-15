import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { purgeFromKnowledge } from "../src/person-erasure.ts";
import { mockIdp } from "./idp.ts";
import { erasing, holding, saveOver, setUpTime } from "./knowledge-purge.ts";
import { ownCollectionOf } from "./knowledge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { openRpc, outcome, signedInApi, unique } from "./sign-in.ts";

// The ledger a person's purge from Knowledge runs on (GRA-1122), as a
// person's erasure reaches it (person-erasure.ts `purgeFromKnowledge`, the
// `brain` area): the only guard on that area when an admin's
// `members.erase` and the clock's `members.erasures` run it at once, as
// `runErasure` claims no area. The ways it can fail, tried here through
// those entry points: two runs both writing; a run reading as done, or a
// later one never finishing; a run that lost its hold marking the search
// index's rebuild as no longer owed while another still writes.

const idp = mockIdp();

/** The message a purge another run holds is refused with. */
const conflict = knowledgeErrors.create("knowledge.conflict").message;

/** A failed area of an erasure, as `runErasure` logs it. */
const failureSchema = z.object({
  event: z.literal("member.erasure_failed"),
  area: z.string(),
  errorMessage: z.string().optional(),
});

/** The statement of a purge's batch that deletes the person's collections. */
const deletesCollections = (statements: D1PreparedStatement[]): boolean =>
  statements.some((statement) =>
    JSON.stringify(statement).includes('delete from \\"collections\\"')
  );

/**
 * Knowledge's database, but a purge's batch that deletes collections waits
 * for `release` once, after saying it got there (`reached`), and then
 * fails with `failWith` if given, or runs.
 */
const holdingPurge = (failWith?: string) => {
  const real = env.KNOWLEDGE;
  const reached = Promise.withResolvers<null>();
  const released = Promise.withResolvers<null>();
  let held = false;
  const knowledge = new Proxy(real, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!held && deletesCollections(statements)) {
            held = true;
            reached.resolve(null);
            await released.promise;
            if (failWith !== undefined) {
              throw new Error(failWith);
            }
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
  return {
    coreEnv: { ...env, KNOWLEDGE: knowledge },
    reached: reached.promise,
    release: () => {
      released.resolve(null);
    },
  };
};

/** A person with a note of their own that holds `marker`, and an admin. */
const leaverWith = async (marker: string) => {
  const admin = await signedInApi(idp, "admin");
  const leaver = await signedInApi(idp, "user");
  await saveOver(
    leaver,
    await ownCollectionOf(leaver),
    "about.md",
    `# About me\nCall me ${marker}.`
  );
  return { admin, leaver };
};

/** Where area `area` of `userId`'s erasure stands, and how often it failed. */
const areaOf = async (userId: string, area: string) =>
  await env.DB.prepare(
    "SELECT state, attempts FROM person_erasure_areas WHERE user_id = ? AND area = ?"
  )
    .bind(userId, area)
    .first<{ state: string; attempts: number }>();

describe("a person's purge, as their erasure runs it", setUpTime, () => {
  it("lets one run hold it when an admin's erasure and the clock meet, and a later tick finishes it", async () => {
    const marker = `meeting${unique()}`;
    const { admin, leaver } = await leaverWith(marker);
    await admin.api.members.remove(leaver.userId);
    // The admin's erasure, its purge held as it deletes, then failing.
    const held = holdingPurge("D1 is unavailable");
    const { core } = await openRpc(admin.session, { coreEnv: held.coreEnv });
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      logged.push(line);
    });
    let byAdmin: Promise<string> | undefined;
    let whileHeld: Awaited<ReturnType<typeof areaOf>> = null;
    let afterAdmin: Awaited<ReturnType<typeof areaOf>> = null;
    try {
      byAdmin = outcome(
        core
          .authenticate()
          .members.erase(leaver.userId, String(leaver.person.name))
      );
      await held.reached;
      // The clock, meanwhile: the area is the admin's run's.
      await runMinuteTasks();
      whileHeld = await areaOf(leaver.userId, "brain");
      held.release();
      await byAdmin;
      afterAdmin = await areaOf(leaver.userId, "brain");
      // The next tick finishes it.
      await runMinuteTasks();
    } finally {
      spy.mockRestore();
      core[Symbol.dispose]();
    }
    const brainFailures = logged.flatMap((line) => {
      const parsed = failureSchema.safeParse(line);
      return parsed.success && parsed.data.area === "brain"
        ? [parsed.data]
        : [];
    });
    const done = await admin.api.members.erasure(leaver.userId);

    expect({
      byAdmin: await byAdmin,
      whileHeld,
      afterAdmin,
      conflicts: brainFailures.filter(
        ({ errorMessage }) => errorMessage === conflict
      ).length,
      failures: brainFailures.length,
      brain: await areaOf(leaver.userId, "brain"),
      done: typeof done.erasure?.completedAt,
      held: await holding(marker),
    }).toStrictEqual({
      byAdmin: "ok",
      // Refused to the clock, which tried while the admin's run held it.
      whileHeld: { state: "pending", attempts: 1 },
      afterAdmin: { state: "pending", attempts: 2 },
      conflicts: 1,
      // The clock's conflict and the admin's run failing.
      failures: 2,
      brain: { state: "complete", attempts: 2 },
      done: "string",
      held: [],
    });
  });

  it("keeps the search index's rebuild owed when a run that lost the purge ends while another still writes", async () => {
    const marker = `lapsed${unique()}`;
    const { admin, leaver } = await leaverWith(marker);
    await erasing(admin, leaver.userId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const lapsed = holdingPurge();
    const current = holdingPurge();
    try {
      // The first run holds the purge, then stalls as it deletes.
      const first = outcome(
        purgeFromKnowledge(lapsed.coreEnv, admin.userId, leaver.userId)
      );
      await lapsed.reached;
      // Its lease runs out; another run takes the purge over, and stalls
      // as it deletes too.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      const second = purgeFromKnowledge(
        current.coreEnv,
        admin.userId,
        leaver.userId
      );
      await current.reached;
      // The first run goes on: it holds the purge no more.
      lapsed.release();
      const firstEnded = await first;
      const purge = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_purges WHERE by = ?"
      )
        .bind(admin.userId)
        .first<{ id: string }>();
      const rebuild = await env.KNOWLEDGE.prepare(
        "SELECT writes_done_at AS done FROM search_rebuilds WHERE id = ?"
      )
        .bind(purge?.id ?? "")
        .first<{ done: number | null }>();
      current.release();
      const result = await second;

      expect({
        firstEnded,
        // Still owed: the run that holds the purge is still writing.
        whileOtherWrites: rebuild === null ? "none" : rebuild.done,
        documents: result.documents,
        held: await holding(marker),
      }).toStrictEqual({
        firstEnded: "knowledge.conflict",
        whileOtherWrites: null,
        documents: 1,
        held: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
