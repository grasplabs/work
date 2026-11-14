import type { FunctionResult } from "@grasp-os/shared/functions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callPageFunction } from "../src/app-functions.ts";
import { appKind } from "../src/apps.ts";
import { rollback } from "../src/publish.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { boundIn, withFiles } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { person, queryReference, seal } from "./sealed-apps.ts";
import {
  codeOf,
  definitionOf,
  failingDefinition,
  files,
  greetingOf,
  historySchema,
  longDefinitionOf,
  objectSchema,
  passing,
  refusalOf,
  requestsApp,
  startedRuns,
} from "./sealed-workflow-starts-harness.ts";
import { unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// Starting workflows from a sealed App's functions, as they run in their
// sandbox (spec 7.4, 9.5): the action's start and the mutation's staged
// start cross the isolate as every capability does, and land as runs of
// the workflow version the App binds. The threat model is tested
// against the function host directly (workflow-app-starts.test.ts);
// this is the same path from the release's own code.

describe("a workflow reference's run list", { timeout: 120_000 }, () => {
  it("offer a run as watchable exactly when the reference's useWorkflow shows it, whichever version of the workflow is live since", async () => {
    const admin = await person("admin");
    const bob = await person("user");
    const owner = await person("builder");
    const workflow = await greetingOf(owner);
    const { release, ...fixture } = await requestsApp(
      admin,
      [bob],
      workflow.id,
      owner
    );
    const { app } = fixture;
    const { result: kicked } = await callAppFunction(
      env,
      bob,
      app,
      JSON.stringify({
        reference: { name: "requests.kickOff", kind: "action" },
        args: { who: "Ada" },
      })
    );
    if (!kicked.ok) {
      throw new Error(kicked.error.code);
    }
    const started = z.object({ runId: z.string() }).parse(kicked.value).runId;
    // A run of the App's that no App version's contract accounts for: its
    // receipt names no version that started it.
    await startedRuns(app, workflow.id, bob.userId, 1);
    const runs = queryReference(release, "followUp", "runs");
    /** What the reference's `run` query answers of run `runId`. */
    const runOf = async (runId: string) =>
      await callPageFunction(
        env,
        bob,
        app,
        JSON.stringify({
          reference: queryReference(release, "followUp", "run"),
          args: { runId },
        }),
        Date.now() + 30_000
      );
    // Each listed run: what its row offers, and whether `run` shows it.
    const offered = async () => {
      const { result } = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({ reference: runs, args: { pagination: {} } })
      );
      const items = result.ok
        ? z
            .object({
              items: z.array(
                z.object({
                  run: z.object({ runId: z.string() }),
                  canWatch: z.boolean(),
                })
              ),
            })
            .parse(result.value).items
        : [];
      const rows = await Promise.all(
        items.map(async ({ run, canWatch }) => {
          const { result: read } = await runOf(run.runId);
          let watched = "shown";
          if (!read.ok) {
            watched = read.error.code;
          } else if (read.value === null) {
            watched = "unavailable";
          }
          return { started: run.runId === started, canWatch, watched };
        })
      );
      // The run Bob started first, then the one no version accounts for.
      return rows.toSorted((a, b) => Number(b.started) - Number(a.started));
    };
    const pinned = await offered();
    // A newer version of the workflow live, which the alias follows: the
    // run Bob started keeps its version, still watchable.
    await publishDefinition(env, owner, workflow.id, definitionOf("1 second"));
    const newer = await offered();
    // Completed, then its details removed, as the retention sweep removes
    // them: its watch has no output to show.
    await vi.waitFor(
      async () => {
        const { result: read } = await runOf(started);
        expect(read).toMatchObject({
          ok: true,
          value: { status: "completed" },
        });
      },
      { timeout: 30_000, interval: 100 }
    );
    await env.DB.prepare(
      "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
    )
      .bind(Date.now(), started)
      .run();
    const [removed] = await offered();
    const offeredOnce = [
      { started: true, canWatch: true, watched: "shown" },
      {
        started: false,
        canWatch: false,
        watched: "unavailable",
      },
    ];
    expect({
      pinned,
      newer,
      removed,
    }).toStrictEqual({
      pinned: offeredOnce,
      newer: offeredOnce,
      removed: {
        started: true,
        canWatch: false,
        watched: "workflow.run_details_removed",
      },
    });
  });
});

/** Any value of a history entry the engine sets, as a matcher. */
const anyValue: unknown = expect.anything();

const pageOf = (result: FunctionResult) =>
  historySchema.parse(result.ok ? result.value : result);

describe("a workflow reference's run history", { timeout: 180_000 }, () => {
  it("tells the person's own runs of the workflow the release binds, metadata only, and refuses every other run alike", async () => {
    const admin = await person("admin");
    const [bob, carol] = await Promise.all([person("user"), person("user")]);
    const owner = await person("builder");
    const workflow = await greetingOf(owner);
    const { release, ...fixture } = await requestsApp(
      admin,
      [bob, carol],
      workflow.id,
      owner
    );
    const { app } = fixture;
    const kickOff = async (
      who: Identity,
      name: string,
      other?: { app: string; release: typeof release }
    ): Promise<string> => {
      const through = other ?? { app, release };
      const { result } = await callAppFunction(
        env,
        who,
        through.app,
        JSON.stringify({
          reference: { name: "requests.kickOff", kind: "action" },
          args: { who: name },
        })
      );
      if (!result.ok) {
        throw new Error(result.error.code);
      }
      return z.object({ runId: z.string() }).parse(result.value).runId;
    };
    const settled = async (runId: string) =>
      await vi.waitFor(
        async () => {
          const run = await resourceRunFor(env, admin, workflow.id, runId);
          expect(run.endedAt).not.toBeNull();
          return run;
        },
        { timeout: 30_000, interval: 100 }
      );
    const bobs = await kickOff(bob, "Bob");
    const carols = await kickOff(carol, "Carol");
    // Bob's run of the same version, through another App pinning it too.
    const otherApp = await requestsApp(admin, [bob], workflow.id, owner);
    const throughOther = await kickOff(bob, "Bob", {
      app: otherApp.app,
      release: otherApp.release,
    });
    await Promise.all([settled(bobs), settled(carols), settled(throughOther)]);
    // The owner's own start, not through the App: never the App's to tell.
    const direct = await startWorkflow(
      env,
      { type: "person", person: owner },
      workflow.id,
      { expected: 1, args: { who: "Owner" }, key: `key-${unique()}` }
    );

    const history = queryReference(release, "followUp", "history");
    const ask = async (
      who: Identity,
      input: unknown
    ): Promise<FunctionResult> => {
      const { result } = await callAppFunction(
        env,
        who,
        app,
        JSON.stringify({ reference: history, args: input })
      );
      return result;
    };
    const whole = pageOf(await ask(bob, { runId: bobs, pagination: {} }));
    // Page by page, one entry each, from each page's cursor.
    const paged: unknown[] = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    do {
      // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
      const answer = await ask(bob, {
        runId: bobs,
        pagination: { pageSize: 1, cursor },
      });
      const page = pageOf(answer);
      paged.push(...page.items);
      ({ nextCursor: cursor } = page);
      if (cursor !== null) {
        cursors.push(cursor);
      }
    } while (cursor !== null);
    // A live list's loaded page, ended where its fourth entry's page
    // starts: its first three entries, whatever its size.
    const ended = await ask(bob, {
      runId: bobs,
      pagination: { pageSize: 1, endCursor: cursors[2] },
    });
    expect({
      told: whole.items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(
            ([key]) => key !== "id" && key !== "sequence" && key !== "at"
          )
        )
      ),
      ascending: whole.items.every(
        (item, index) =>
          index === 0 || item.sequence > (whole.items[index - 1]?.sequence ?? 0)
      ),
      paged,
      ended: ended.ok ? ended.value : ended.error.code,
    }).toStrictEqual({
      // Metadata only: no input, output or engine step ID; the task named
      // by the ID its sealed build declares.
      told: [
        { taskId: null, kind: "lifecycle", status: "queued" },
        { taskId: null, kind: "lifecycle", status: "running" },
        // Its enter step, recording its deadline, then its timer.
        { taskId: "greet", kind: "step", state: "started", attempt: 1 },
        { taskId: "greet", kind: "step", state: "completed", attempt: 1 },
        {
          taskId: "greet",
          kind: "wait",
          waitId: anyValue,
          waitKind: "timer",
          state: "opened",
          deadline: anyValue,
        },
        {
          taskId: "greet",
          kind: "wait",
          waitId: anyValue,
          waitKind: "timer",
          state: "closed",
          deadline: null,
        },
        // The output's own step, of no task.
        { taskId: null, kind: "step", state: "started", attempt: 1 },
        { taskId: null, kind: "step", state: "completed", attempt: 1 },
        { taskId: null, kind: "lifecycle", status: "completed" },
      ],
      ascending: true,
      paged: whole.items,
      // Three entries past twice its size of one: it says to split after
      // its first, as any page with an end does.
      ended: {
        items: whole.items.slice(0, 3),
        nextCursor: cursors[2],
        hasMore: true,
        splitCursor: String(whole.items[0]?.sequence),
      },
    });

    // Anyone else's run, a run started outside the App, and an ID no run
    // has are one refusal, word for word; a cursor tells nothing of them.
    const unknown = refusalOf(
      await ask(bob, { runId: crypto.randomUUID(), pagination: {} })
    );
    expect({
      carols: refusalOf(await ask(bob, { runId: carols, pagination: {} })),
      direct: refusalOf(await ask(owner, { runId: direct.id, pagination: {} })),
      otherApps: refusalOf(
        await ask(bob, { runId: throughOther, pagination: {} })
      ),
      carolsWithBadCursor: refusalOf(
        await ask(bob, { runId: carols, pagination: { cursor: "x" } })
      ),
      carolsEnded: refusalOf(
        await ask(bob, { runId: carols, pagination: { endCursor: "1" } })
      ),
      ownBadCursor: codeOf(
        await ask(bob, { runId: bobs, pagination: { cursor: "x" } })
      ),
      // Any event ID the engine can write, and none past it.
      lastCursor: pageOf(
        await ask(bob, {
          runId: bobs,
          pagination: { cursor: String(Number.MAX_SAFE_INTEGER) },
        })
      ).items.length,
      pastCursor: codeOf(
        await ask(bob, {
          runId: bobs,
          pagination: { cursor: "9007199254740992" },
        })
      ),
      carolOwn: pageOf(await ask(carol, { runId: carols, pagination: {} }))
        .items.length,
      unknownCode: unknown === "ok" ? "ok" : unknown.code,
    }).toStrictEqual({
      carols: unknown,
      direct: unknown,
      otherApps: unknown,
      carolsWithBadCursor: unknown,
      carolsEnded: unknown,
      ownBadCursor: "data.invalid_cursor",
      lastCursor: 0,
      pastCursor: "data.invalid_cursor",
      carolOwn: 9,
      unknownCode: "workflow.run_unavailable",
    });

    // Version 1's sealed build no longer verifying is the platform's
    // fault: the run's history tells nothing rather than failing the page.
    const versionRow = (text: string) =>
      env.DB.prepare(
        "UPDATE workflow_resource_versions SET manifest = ? WHERE workflow_resource_id = ? AND version = 1"
      ).bind(text, workflow.id);
    const manifest = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ manifest: string }>();
    const immutable =
      // As migration 0247 left it: only a version's label changes.
      "CREATE TRIGGER workflow_resource_versions_immutable_update BEFORE UPDATE OF workflow_resource_id, version, definition_version, definition, definition_json_hash, profile_version, evaluator_hash, contract, contract_hash, manifest, manifest_hash, author_id, created_at, seal_id ON workflow_resource_versions BEGIN SELECT RAISE(ABORT, 'workflow_resource_versions are immutable'); END";
    await env.DB.batch([
      env.DB.prepare(
        "DROP TRIGGER workflow_resource_versions_immutable_update"
      ),
      versionRow(`${manifest?.manifest ?? ""} `),
      env.DB.prepare(immutable),
    ]);
    const unverified = await ask(bob, { runId: bobs, pagination: {} });
    await env.DB.batch([
      env.DB.prepare(
        "DROP TRIGGER workflow_resource_versions_immutable_update"
      ),
      versionRow(manifest?.manifest ?? ""),
      env.DB.prepare(immutable),
    ]);

    expect(pageOf(unverified)).toStrictEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });

    // The workflow live at version 2 now, which fails on what it reads:
    // the alias follows the workflow's live version, so each release that
    // binds it tells the runs of every version of it. A failure's own
    // words never leave.
    await publishDefinition(env, owner, workflow.id, failingDefinition);
    const secret = `Secret-${unique()}`;
    const failed = await kickOff(bob, secret);
    await settled(failed);
    const throughOld = refusalOf(
      await ask(bob, { runId: failed, pagination: {} })
    );
    await commitDefined(
      env,
      owner,
      app,
      boundIn(
        withFiles(files(), {
          "server/requests.ts": `${files().files["server/requests.ts"] ?? ""}// Sealed again.\n`,
        }),
        { followUp: workflow.id }
      )
    );
    const next = await seal(fixture, 2);
    await rollback(env, appKind, owner, app, 2);
    const nextHistory = queryReference(next, "followUp", "history");
    const askNext = async (input: unknown) => {
      const answer = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({ reference: nextHistory, args: input })
      );
      return answer.result;
    };
    const failedPage = await askNext({ runId: failed, pagination: {} });
    const failedItems = pageOf(failedPage).items;
    const oldRunThroughNext = refusalOf(
      await askNext({ runId: bobs, pagination: {} })
    );
    // Once the retention sweep removed the run's details (as it marks
    // its receipt), its history tells nothing.
    await env.DB.prepare(
      "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
    )
      .bind(Date.now(), failed)
      .run();
    const removed = pageOf(await askNext({ runId: failed, pagination: {} }));
    expect({
      throughOld,
      oldRunThroughNext,
      failedStep: failedItems.find(
        (item) => item.kind === "step" && item.state === "failed"
      )?.error,
      leaks: JSON.stringify(failedPage).includes(secret),
      removed,
    }).toStrictEqual({
      throughOld: "ok",
      oldRunThroughNext: "ok",
      // Its expression failed in its code, before any step: no step of
      // it failed, and nothing of what it read is told.
      failedStep: undefined,
      leaks: false,
      removed: { items: [], nextCursor: null, hasMore: false },
    });
  });

  it("names each step of a loop's items by its task, as the run host names it", async () => {
    const admin = await person("admin");
    const bob = await person("user");
    const owner = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      owner,
      `loop-${unique()}`
    );
    await publishDefinition(
      env,
      owner,
      workflow.id,
      JSON.stringify({
        $schema: workflowSchemaUrl,
        args: objectSchema({ who: { kind: "string" } }),
        returns: objectSchema({ status: { kind: "string" } }),
        result: { status: "done" },
        steps: [
          {
            id: "each",
            type: "forEach",
            items: { $expr: "[1, 2]" },
            do: [passing("greet")],
          },
        ],
      })
    );
    const { release, ...fixture } = await requestsApp(
      admin,
      [bob],
      workflow.id,
      owner
    );
    const { result } = await callAppFunction(
      env,
      bob,
      fixture.app,
      JSON.stringify({
        reference: { name: "requests.kickOff", kind: "action" },
        args: { who: "Bob" },
      })
    );
    if (!result.ok) {
      throw new Error(result.error.code);
    }
    const { runId } = z.object({ runId: z.string() }).parse(result.value);
    await vi.waitFor(
      async () => {
        const run = await resourceRunFor(env, admin, workflow.id, runId);
        expect(run.endedAt).not.toBeNull();
      },
      { timeout: 30_000, interval: 100 }
    );
    const { result: read } = await callAppFunction(
      env,
      bob,
      fixture.app,
      JSON.stringify({
        reference: queryReference(release, "followUp", "history"),
        args: { runId, pagination: {} },
      })
    );
    const { items } = historySchema.parse(read.ok ? read.value : read);
    const greetSteps = items.filter(
      (item) => item.kind === "step" && item.taskId === "greet"
    );
    // Each item's step of `greet` (`greet:task%40<i>`), started and
    // completed: none of them left without its task.
    expect(greetSteps).toHaveLength(4);
  });

  it("ends a page of the history where the next starts, however many entries it holds", async () => {
    const admin = await person("admin");
    const bob = await person("user");
    const owner = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      owner,
      `long-${unique()}`
    );
    await publishDefinition(env, owner, workflow.id, longDefinitionOf(60));
    const { release, ...fixture } = await requestsApp(
      admin,
      [bob],
      workflow.id,
      owner
    );
    const started = await callAppFunction(
      env,
      bob,
      fixture.app,
      JSON.stringify({
        reference: { name: "requests.kickOff", kind: "action" },
        args: { who: "Bob" },
      })
    );
    const runId = started.result.ok
      ? z.object({ runId: z.string() }).parse(started.result.value).runId
      : "";
    await vi.waitFor(
      async () => {
        const run = await resourceRunFor(env, admin, workflow.id, runId);
        expect(run.endedAt).not.toBeNull();
      },
      { timeout: 60_000, interval: 200 }
    );
    const history = queryReference(release, "followUp", "history");
    const read = async (input: unknown) => {
      const { result } = await callAppFunction(
        env,
        bob,
        fixture.app,
        JSON.stringify({ reference: history, args: input })
      );
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return historySchema.parse(result.value);
    };
    // Every row, page by page as a caller pages it.
    const rows: unknown[] = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    do {
      // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
      const page = await read({ runId, pagination: { pageSize: 100, cursor } });
      rows.push(...page.items);
      ({ nextCursor: cursor } = page);
      if (cursor !== null) {
        cursors.push(cursor);
      }
    } while (cursor !== null);
    // A live list's loaded page: from the start to the first page's end,
    // however small its size, then the page after it from there.
    const [end = ""] = cursors;
    const ended = await read({
      runId,
      pagination: { pageSize: 1, endCursor: end },
    });
    const after = await read({
      runId,
      pagination: { pageSize: 100, cursor: end },
    });
    expect({
      morethanAPage: rows.length > 100,
      ended: ended.items,
      endedAt: ended.nextCursor,
      after: after.items,
    }).toStrictEqual({
      morethanAPage: true,
      ended: rows.slice(0, 100),
      endedAt: end,
      after: rows.slice(100, 200),
    });
  });
});
