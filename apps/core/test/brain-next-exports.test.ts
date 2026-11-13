import { brainExportErrors } from "@grasp-os/shared/brain-exports";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import { runSource } from "../src/brain-next-origins.ts";
import {
  addSource,
  readSourceVersionAs,
  workBrain,
} from "../src/brain-next.ts";
import {
  owedErasuresMax,
  settleOwedErasures,
} from "../src/brain-owed-erasures.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { sweepRunDetails } from "../src/workflows/retention.ts";
import {
  ledgerOf,
  newMark,
  nextBucketPut,
  wordOf,
} from "./brain-next-traces.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  greetingTasks,
  jsonWorkflowAppsOf,
  publishedWorkflow,
  startedBy,
} from "./json-workflow-apps.ts";
import { noProducers } from "./no-producers.ts";
import {
  auditedDuring,
  outcome,
  routed,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";

// Exports of the new Brain over core's routes (src/brain-next-exports.ts,
// GRA-1755): who may start and read which, and what each holds. The
// Brain's own tests (packages/brain-next/test/exports.test.ts) hold the
// rest: history, erasure, restore. The threat model is on GRA-1755.

const idp = mockIdp();
const workflowApps = jsonWorkflowAppsOf(idp);

const day = 24 * 60 * 60 * 1000;

/**
 * Fails the shared Brain store's next write to its bucket, as an R2 out
 * of reach: the ledger entry of the next erasure, which so doesn't return.
 */
const failNextBucketPut = async (): Promise<void> => {
  await nextBucketPut(async () => {
    await Promise.resolve();
    throw new Error("R2 out of reach, for the test");
  });
};

/**
 * A builder's run that ended, its result handed to the Brain with `mark`
 * as its producer hands a run over: the person it ran for alone.
 */
const runInBrain = async (mark: string) => {
  const builder = await workflowApps.signedIn("builder");
  const { id } = await publishedWorkflow(builder, greetingTasks());
  const runId = await startedBy(builder, id, { who: "the guest" });
  await endedRun(builder, id, runId);
  await addSource(env, {
    source: runSource(runId),
    change: crypto.randomUUID(),
    text: `What the run said: ${wordOf(mark)}.`,
    readers: { kind: "owner", personId: builder.userId },
  });
  return { runId, builderId: builder.userId };
};

/** A team's source with `mark`, in the shared store, as a company export holds it. */
const teamSource = async (mark: string) => {
  const source = { producer: "upload", id: crypto.randomUUID() } as const;
  const readers = { kind: "team", teamId: crypto.randomUUID() } as const;
  await addSource(env, {
    source,
    change: "1",
    text: `What the team said: ${wordOf(mark)}.`,
    readers,
  });
  return { source, readers };
};

/**
 * Runs `run` 31 days on, past the retention of every run that ended
 * before it began, in core's clock and the Brain's (one isolate). Last in
 * this file: the Brain's ledger orders entries by when they are written,
 * so nothing may be erased at today's date after it.
 */
const pastRetention = async <T>(run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * day });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** A request of core's own page, signed in on `cookie`. */
const request = async (
  cookie: string,
  path: string,
  init: { method?: string; body?: unknown; site?: string } = {}
): Promise<Response> =>
  await routed(path, {
    method: init.method ?? "GET",
    headers: {
      cookie,
      "sec-fetch-site": init.site ?? "same-origin",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** The R2 calls the Brain's store makes, passed through. */
const r2Calls = ["get", "head", "put", "delete", "list"] as const;

/**
 * The shared Brain store's bucket failing every read and write of a
 * source's file (`sources/`), as R2 out of reach for them: what a skill's
 * write meets. Every other call goes through. Answers how to heal it.
 */
const failingSourceFiles = async (): Promise<() => Promise<void>> => {
  const store = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
  const bucket = env.BRAIN_OBJECTS;
  const swap = async (to: unknown): Promise<void> => {
    await runInDurableObject(store, (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: to });
    });
  };
  await swap(
    Object.fromEntries(
      r2Calls.map((name) => [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          const [key] = args;
          if (typeof key === "string" && key.startsWith("sources/")) {
            await Promise.resolve();
            throw new Error("R2 out of reach");
          }
          const method: unknown = Reflect.get(bucket, name);
          if (typeof method !== "function") {
            throw new TypeError(`R2 has no ${name}`);
          }
          const result: unknown = await Reflect.apply(method, bucket, args);
          return result;
        },
      ])
    )
  );
  return async () => {
    await swap(bucket);
  };
};

const startedSchema = z.object({ id: z.uuid() });

const statusSchema = z.object({
  state: z.string(),
  files: z.array(z.string()),
});

/** Starts an export of the company's Brain on `cookie`: its id. */
const start = async (cookie: string): Promise<string> => {
  const response = await request(cookie, brainExportsPath, { method: "POST" });
  const { id } = startedSchema.parse(await response.json());
  return id;
};

/** The query of export `id`, or of one of its files. */
const queryOf = (id: string, file?: string): string =>
  `${brainExportsPath}?${new URLSearchParams({
    id,
    ...(file === undefined ? {} : { file }),
  }).toString()}`;

/**
 * Ticks the shared store until export `id` is written, then reads every
 * file of it on `cookie`.
 */
const writtenFiles = async (cookie: string, id: string): Promise<string[]> => {
  await workBrain(env, new Date(), noProducers);
  const response = await request(cookie, queryOf(id));
  const status = statusSchema.parse(await response.json());
  expect(status.state).toBe("done");
  const bodies: string[] = [];
  for (const file of status.files) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    const downloaded = await request(cookie, queryOf(id, file));
    expect(downloaded.headers.get("content-disposition")).toMatch(
      /^attachment;/u
    );
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    bodies.push(await downloaded.text());
  }
  return bodies;
};

describe(
  "exports of the Brain over core's routes",
  { timeout: 120_000 },
  () => {
    // Staff reach no client's workspace by signing in (they act only as an
    // added user): unauthenticated here, as anyone not signed in.
    it("lets only an admin, never staff or a member, start the company's export or a restore, and only from core's own site (threat 1)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const member = await signedInWithRole(idp, "user");
      const staff = await signedIn(idp, "grasp-staff", staffPerson());
      const startCompany = { method: "POST" };
      const restore = {
        method: "POST",
        body: { exportId: crypto.randomUUID() },
      };

      const statuses = await Promise.all([
        request(member.session, brainExportsPath, startCompany),
        request(staff, brainExportsPath, startCompany),
        request("", brainExportsPath, startCompany),
        request(admin.session, brainExportsPath, {
          ...startCompany,
          site: "cross-site",
        }),
        request(member.session, brainRestorePath, restore),
        request(staff, brainRestorePath, restore),
        request(
          member.session,
          `${brainRestorePath}?id=${crypto.randomUUID()}`
        ),
        // The admin's restore of an export no one made: refused, as a
        // conflict with what the Brain holds, not an error of core's.
        request(admin.session, brainRestorePath, restore),
      ]);

      expect(statuses.map(({ status }) => status)).toStrictEqual([
        403, 401, 401, 403, 403, 401, 403, 409,
      ]);
    });

    // Run before anything is added to the shared store: a restore goes
    // only into one that holds nothing but Grasp's own skills.
    it("starts no restore when Grasp's own skills could not be installed first, on record as failed, and starts it once they can be (threat 9)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const id = await start(admin.session);
      await writtenFiles(admin.session, id);
      // The store's bucket fails every source file: no skill can be read
      // or written.
      const heal = await failingSourceFiles();
      let refused: Response | undefined;
      let events: Awaited<ReturnType<typeof auditedDuring>> = [];
      try {
        events = await auditedDuring(async () => {
          refused = await request(admin.session, brainRestorePath, {
            method: "POST",
            body: { exportId: id },
          });
        });
      } finally {
        await heal();
      }
      const { code } = z
        .object({ code: z.string() })
        .parse(await refused?.json());
      const notStarted = await request(
        admin.session,
        `${brainRestorePath}?id=${id}`
      );
      // Once the skills can be installed, the same restore starts.
      const again = await request(admin.session, brainRestorePath, {
        method: "POST",
        body: { exportId: id },
      });
      const { state } = z
        .object({ state: z.string() })
        .parse(await again.json());
      // Done, so the store takes adds and exports again for what follows.
      await workBrain(env, new Date(), noProducers);
      await workBrain(env, new Date(), noProducers);
      expect({
        status: refused?.status,
        code,
        audited: events
          .filter(({ action }) => action.startsWith("brain.restore."))
          .map(({ action, detail }) => [action, detail?.outcome ?? null]),
        notStarted: notStarted.status,
        again: again.status,
        state,
      }).toStrictEqual({
        status: 503,
        code: "brain.restore_unprepared",
        audited: [
          ["brain.restore.asked", null],
          ["brain.restore.answered", "failed"],
        ],
        notStarted: 404,
        again: 200,
        state: "running",
      });
    });

    it("gives an admin the company's export, without anything one person alone may read, on record without its content (threats 4, 12)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const member = await signedInWithRole(idp, "user");
      const shared = `shared${crypto.randomUUID().replaceAll("-", "")}`;
      const theirs = `theirs${crypto.randomUUID().replaceAll("-", "")}`;
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `The company's ${shared}`,
        readers: { kind: "team", teamId: crypto.randomUUID() },
      });
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `An interview of ${theirs}`,
        readers: { kind: "owner", personId: member.userId },
      });

      let bodies: string[] = [];
      let id = "";
      const events = await auditedDuring(async () => {
        id = await start(admin.session);
        bodies = await writtenFiles(admin.session, id);
      });
      const all = bodies.join("\n");
      const exportEvents = events.filter(({ action }) =>
        action.startsWith("brain.export.")
      );

      expect({
        shared: all.includes(shared),
        theirs: all.includes(theirs),
        // On record, naming no content.
        actions: exportEvents.map(({ action }) => action),
        answeredWith: exportEvents.find(
          ({ action }) => action === "brain.export.answered"
        )?.detail,
        named: JSON.stringify(exportEvents).includes(shared),
      }).toStrictEqual({
        shared: true,
        theirs: false,
        actions: [
          "brain.export.asked",
          "brain.export.answered",
          ...bodies.map(() => "brain.export.downloaded"),
        ],
        answeredWith: { outcome: "started", exportId: id },
        named: false,
      });
    });

    it("answers an export started, and a shared add made, while a restore runs with a code of their own, and keeps a person's own add in their own store meanwhile", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const store = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
      const restoring = crypto.randomUUID();
      // A restore under way, as the store records one.
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO restores (export, checked, part, restored, state, started_at)
          VALUES (?, 0, 0, 0, 'running', ?)`,
          restoring,
          Date.now()
        );
      });
      try {
        const started = await request(admin.session, brainExportsPath, {
          method: "POST",
        });
        const { code } = z
          .object({ code: z.string() })
          .parse(await started.json());
        let added: string | undefined;
        try {
          await addSource(env, {
            source: { producer: "upload", id: crypto.randomUUID() },
            change: "1",
            text: "words while it restores",
            readers: { kind: "team", teamId: crypto.randomUUID() },
          });
        } catch (error) {
          added = brainExportErrors.codeOf(error);
        }
        // What only one person may read goes to their own store, which no
        // restore touches: kept, never lost.
        const mine = { producer: "upload", id: crypto.randomUUID() } as const;
        const text = `mine while it restores ${crypto.randomUUID()}`;
        const { version } = await addSource(env, {
          source: mine,
          change: "1",
          text,
          readers: { kind: "owner", personId: admin.userId },
        });
        const read = await readSourceVersionAs(env, admin.userId, {
          source: mine,
          version,
        });
        expect({
          status: started.status,
          code,
          added,
          own: read?.text,
        }).toStrictEqual({
          status: 409,
          code: "brain.export_refused",
          added: "brain.restoring",
          own: text,
        });
      } finally {
        await runInDurableObject(store, (_instance, state) => {
          state.storage.sql.exec(
            "DELETE FROM restores WHERE export = ?",
            restoring
          );
        });
      }
    });

    it("makes an owed erasure of what a team reads before it answers, owed while the Brain can't record it, and an export started once it returned holds none of it", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const mark = newMark();
      const owed = await teamSource(mark);
      const lists = [
        async () =>
          await Promise.resolve([{ ...owed, reason: "deleted" as const }]),
      ];

      await failNextBucketPut();
      const failing = await settleOwedErasures(env, new Date(), lists);
      const returned = await settleOwedErasures(env, new Date(), lists);
      const id = await start(admin.session);
      const bodies = await writtenFiles(admin.session, id);

      expect({
        failing,
        returned,
        held: bodies.join("\n").includes(wordOf(mark)),
      }).toStrictEqual({ failing: "owed", returned: "settled", held: false });
    });

    it("answers owed, making no erasure, when more are owed than one settle makes", async () => {
      const mark = newMark();
      const first = await teamSource(mark);
      const rest = Array.from({ length: owedErasuresMax }, () => ({
        source: { producer: "upload", id: crypto.randomUUID() } as const,
        readers: first.readers,
        reason: "deleted" as const,
      }));
      const lists = [
        async () =>
          await Promise.resolve([{ ...first, reason: "deleted" as const }]),
        async (_env: Env, _now: Date, limit: number) =>
          await Promise.resolve(rest.slice(0, limit)),
      ];

      const answer = await settleOwedErasures(env, new Date(), lists);

      expect({
        answer,
        recorded: await ledgerOf(`upload:${first.source.id}`),
      }).toStrictEqual({ answer: "owed", recorded: [] });
    });

    it("holds up no export for an erasure owed of what one person alone may read: a run past its retention, a person's erasure, while the Brain can't record them", async () => {
      const mark = newMark();
      await runInBrain(mark);
      const { started, swept, bodies } = await pastRetention(async () => {
        const admin = await signedInApi(idp, "admin");
        const person = await signedInWithRole(idp, "user");
        await admin.api.members.remove(person.userId);
        await failNextBucketPut();
        // Pending: the Brain couldn't record their erasure.
        await admin.api.members.erase(
          person.userId,
          String(person.person.name)
        );
        await failNextBucketPut();
        const answered = await request(admin.session, brainExportsPath, {
          method: "POST",
        });
        // The Brain still failing, met by the run retention's own sweep,
        // which leaves the run's erasure owed.
        const sweep = await outcome(sweepRunDetails(env, new Date()));
        const { id } = startedSchema.parse(await answered.json());
        return {
          started: answered.status,
          swept: sweep === "ok" ? "swept" : "failed",
          bodies: await writtenFiles(admin.session, id),
        };
      });

      expect({
        started,
        swept,
        held: bodies.join("\n").includes(wordOf(mark)),
      }).toStrictEqual({ started: 200, swept: "failed", held: false });
    });
  }
);
