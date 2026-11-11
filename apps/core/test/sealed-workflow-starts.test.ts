import type { FunctionResult } from "@grasp-os/shared/functions";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, evaluateAppQuery } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { appWith, person, queryReference, seal } from "./sealed-apps.ts";
import {
  codeOf,
  definitionOf,
  files,
  greetingOf,
  requestsApp,
  rolesOf,
  runIds,
  startedRuns,
} from "./sealed-workflow-starts-harness.ts";
import { unique } from "./sign-in.ts";
import { tiledPage } from "./split-pages.ts";

// Starting workflows from a sealed App's functions, as they run in their
// sandbox (spec 7.4, 9.5): the action's start and the mutation's staged
// start cross the isolate as every capability does, and land as runs of
// the workflow version the App binds. The threat model is tested
// against the function host directly (workflow-app-starts.test.ts);
// this is the same path from the release's own code.

describe("a sealed App's functions", { timeout: 120_000 }, () => {
  it("start the workflow the App binds, now from an action and after the commit from a mutation, for the person calling", async () => {
    const admin = await person("admin");
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    const release = await seal(fixture);
    await publishVersion(env, owner, app, 1);
    const bob = await person("user");
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(app, bob.userId, owner.userId, Date.now())
      .run();
    const workflow = await createWorkflowResource(
      env,
      owner,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(),
      basedOn: null,
    });
    await bindWorkflowToApp(env, owner, workflow.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    const asked = await requestPermission(
      env,
      owner,
      {
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId: workflow.id },
        actions: ["start"],
        binding: "FOLLOW_UP",
      },
      rolesOf(owner)
    );
    await grantPermission(env, admin, asked.id, { version: 1 });

    const call = async (
      path: "requests.submit" | "requests.kickOff",
      input: unknown
    ): Promise<FunctionResult> => {
      const fn = release.app.functions[path];
      const { result } = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({
          reference: { name: path, kind: fn?.kind },
          args: input,
        })
      );
      return result;
    };
    const started = await call("requests.kickOff", { who: "Bob" });
    const submitted = await call("requests.submit", { who: "Ada" });
    if (release.store === null) {
      throw new Error("The release has no store");
    }
    await runDurableObjectAlarm(
      env.DATA_STORES.getByName(release.store.storeId)
    );
    const { results: receipts } = await env.DB.prepare(
      "SELECT id, principal_id FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ? ORDER BY created_at, id"
    )
      .bind(app)
      .all<{ id: string; principal_id: string }>();
    const outputs = await vi.waitFor(
      async () => {
        const runs = await Promise.all(
          receipts.map(
            async ({ id }) => await resourceRunFor(env, admin, workflow.id, id)
          )
        );
        expect(runs.every(({ endedAt }) => endedAt !== null)).toBeTruthy();
        return runs.map(({ result: output }) => output);
      },
      { timeout: 30_000, interval: 100 }
    );
    expect({
      started: started.ok ? started.value : started.error.code,
      submitted: submitted.ok,
      principals: receipts.map(({ principal_id }) => principal_id),
      outputs: outputs.toSorted((a, b) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : 1
      ),
    }).toStrictEqual({
      started: { startId: receipts[0]?.id, runId: receipts[0]?.id, version: 1 },
      submitted: true,
      principals: [bob.userId, bob.userId],
      outputs: [{ status: "Hello, Ada" }, { status: "Hello, Bob" }],
    });
  });
});

describe("a workflow reference's queries", { timeout: 120_000 }, () => {
  it("list only the runs this App started for the person, of the workflow it binds, newest first, page by page", async () => {
    const admin = await person("admin");
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    const release = await seal(fixture);
    await publishVersion(env, owner, app, 1);
    const [bob, carol] = await Promise.all([person("user"), person("user")]);
    for (const member of [bob, carol]) {
      // oxlint-disable-next-line no-await-in-loop -- two rows, one each
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, member.userId, owner.userId, Date.now())
        .run();
    }
    const workflow = await createWorkflowResource(
      env,
      owner,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(),
      basedOn: null,
    });
    const binding = await bindWorkflowToApp(env, owner, workflow.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    const asked = await requestPermission(
      env,
      owner,
      {
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId: workflow.id },
        actions: ["start"],
        binding: "FOLLOW_UP",
      },
      rolesOf(owner)
    );
    await grantPermission(env, admin, asked.id, { version: 1 });
    const kickOff = async (who: Identity): Promise<string> => {
      const { result } = await callAppFunction(
        env,
        who,
        app,
        JSON.stringify({
          reference: { name: "requests.kickOff", kind: "action" },
          args: { who: "Someone" },
        })
      );
      if (!result.ok) {
        throw new Error(result.error.code);
      }
      return z.object({ runId: z.string() }).parse(result.value).runId;
    };
    const first = await kickOff(bob);
    const second = await kickOff(bob);
    const carols = await kickOff(carol);
    // The owner starts one directly, not through the App: never the App's.
    const direct = await startWorkflow(
      env,
      { type: "person", person: owner },
      workflow.id,
      { version: 1, args: { who: "Owner" }, key: `key-${unique()}` }
    );

    const references = {
      runs: queryReference(release, "followUp", "runs"),
      history: queryReference(release, "followUp", "history"),
    };
    const ask = async (
      who: Identity,
      reference: object,
      input: unknown
    ): Promise<FunctionResult> => {
      const { result } = await callAppFunction(
        env,
        who,
        app,
        JSON.stringify({ reference, args: input })
      );
      return result;
    };

    const firstPage = await ask(bob, references.runs, {
      pagination: { pageSize: 1 },
    });
    const cursor = firstPage.ok
      ? z.object({ nextCursor: z.string() }).parse(firstPage.value).nextCursor
      : "";
    const live = await evaluateAppQuery(
      env,
      bob,
      app,
      JSON.stringify({ reference: references.runs, args: { pagination: {} } }),
      Date.now() + 30_000
    );
    expect({
      liveReads: live.reads,
      none: runIds(
        await ask(bob, references.runs, {
          status: "paused",
          pagination: {},
        })
      ),
      carol: runIds(await ask(carol, references.runs, { pagination: {} })),
      owner: runIds(await ask(owner, references.runs, { pagination: {} })),
      ownHistory: codeOf(
        await ask(bob, references.history, { runId: first, pagination: {} })
      ),
      othersHistory: codeOf(
        await ask(bob, references.history, { runId: carols, pagination: {} })
      ),
    }).toStrictEqual({
      // Read once, pushed once: no store read keeps it fresh yet.
      liveReads: undefined,
      none: [],
      carol: [carols],
      owner: [],
      // Sealed before the App bound anything, the release pins no
      // workflow version: it reads no run's history, its own included.
      ownHistory: "workflow.run_unavailable",
      othersHistory: "workflow.run_unavailable",
    });
    const bobs = runIds(await ask(bob, references.runs, { pagination: {} }));
    expect({
      bobs: bobs.toSorted(),
      pages: [
        ...runIds(firstPage),
        ...runIds(
          await ask(bob, references.runs, {
            pagination: { pageSize: 1, cursor },
          })
        ),
      ],
      // A live list's loaded page: up to where the next page starts.
      ended: await ask(bob, references.runs, {
        pagination: { pageSize: 2, endCursor: cursor },
      }),
      live: runIds(live.answer.result),
      direct: bobs.includes(direct.id),
    }).toStrictEqual({
      bobs: [first, second].toSorted(),
      pages: bobs,
      ended: firstPage,
      live: bobs,
      direct: false,
    });

    // References the release doesn't make, or arguments outside them.
    const forged = { ...references.runs, fingerprint: "0".repeat(64) };
    const unknown = {
      ...references.runs,
      name: "workflows.other.queries.runs",
    };
    expect({
      forged: codeOf(await ask(bob, forged, { pagination: {} })),
      unknown: codeOf(await ask(bob, unknown, { pagination: {} })),
      status: codeOf(
        await ask(bob, references.runs, { status: "lost", pagination: {} })
      ),
      cursor: codeOf(
        await ask(bob, references.runs, {
          pagination: { cursor: "not a cursor" },
        })
      ),
      historyEnded: codeOf(
        await ask(bob, references.history, {
          runId: first,
          pagination: { endCursor: "1" },
        })
      ),
    }).toStrictEqual({
      forged: "contract.invalid_request",
      unknown: "function.not_found",
      status: "contract.invalid_args",
      cursor: "data.invalid_cursor",
      historyEnded: "workflow.run_unavailable",
    });

    // A caller no longer allowed to call (an agent whose permission was
    // withdrawn) is refused before anything is read.
    const withdrawn = await callAppFunction(
      env,
      bob,
      app,
      JSON.stringify({ reference: references.runs, args: { pagination: {} } }),
      Date.now() + 30_000,
      async () => {
        await Promise.reject(roleErrors.create("role.forbidden"));
      }
    );
    expect(codeOf(withdrawn.result)).toBe("role.forbidden");

    // Without the binding, nothing is read.
    await unbindWorkflowFromApp(env, owner, binding.id);
    expect(codeOf(await ask(bob, references.runs, { pagination: {} }))).toBe(
      "permission.unavailable"
    );
  });

  it("split a page of runs whose end lies past what one read may examine, and past half an answer, every run once", async () => {
    const admin = await person("admin");
    const bob = await person("user");
    const owner = await person("builder");
    const workflow = await greetingOf(owner);
    const { app, release } = await requestsApp(
      admin,
      [bob],
      workflow.id,
      owner
    );
    // More of Bob's runs than one read may examine.
    await startedRuns(app, workflow.id, bob.userId, queryMaxScannedEntries + 2);
    const runs = queryReference(release, "followUp", "runs");
    const ask = async (input: unknown) => {
      const { result } = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({ reference: runs, args: input })
      );
      return result;
    };
    // An end at the oldest of them (runs list newest first): a cursor is
    // a place, its time then an ID, which anyone may write.
    const end = `${Date.UTC(2026, 0, 1)}:0`;
    const page = z.object({
      items: z.array(z.object({ run: z.object({ runId: z.string() }) })),
      splitCursor: z.string().optional(),
    });
    // Split as a live list splits it: on a `splitCursor`, its first half
    // `(from, split)`, then the rest `(split, end)`, each split again
    // should it say so.
    const tiled = await tiledPage(
      async (from, until) => {
        const answered = await ask({
          pagination: { pageSize: 100, cursor: from, endCursor: until },
        });
        return page.parse(answered.ok ? answered.value : answered);
      },
      null,
      end
    );
    const ids = tiled.items.map(({ run }) => run.runId);
    expect({
      split: tiled.reads > 2,
      runs: ids.length,
      unique: new Set(ids).size,
    }).toStrictEqual({
      split: true,
      runs: queryMaxScannedEntries + 2,
      unique: queryMaxScannedEntries + 2,
    });
  });

  it("keep each App's runs its own, end a page where the next starts, and follow access, revocation and rebinding", async () => {
    const admin = await person("admin");
    const bob = await person("user");
    const owner = await person("builder");
    const workflow = await greetingOf(owner);
    const first = await requestsApp(admin, [bob], workflow.id, owner);
    const second = await requestsApp(admin, [bob], workflow.id, owner);
    // 150 runs of Bob's through the first App, 3 through the second.
    await startedRuns(first.app, workflow.id, bob.userId, 150);
    await startedRuns(second.app, workflow.id, bob.userId, 3);
    const runs = queryReference(first.release, "followUp", "runs");
    const ask = async (input: unknown) => {
      const { result } = await callAppFunction(
        env,
        bob,
        first.app,
        JSON.stringify({ reference: runs, args: input })
      );
      return result;
    };
    const askSecond = async () => {
      const answer = await callAppFunction(
        env,
        bob,
        second.app,
        JSON.stringify({
          reference: queryReference(second.release, "followUp", "runs"),
          args: { pagination: {} },
        })
      );
      return answer.result;
    };
    const firstPage = await ask({ pagination: {} });
    const cursor = firstPage.ok
      ? z.object({ nextCursor: z.string() }).parse(firstPage.value).nextCursor
      : "";
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT runs.id FROM workflow_resource_runs AS runs JOIN workflow_start_receipts AS receipts ON receipts.id = runs.id WHERE runs.workflow_resource_id = ? AND receipts.invoker_type = 'app' AND receipts.invoker_id = ? AND receipts.principal_id = ? AND runs.principal_id = ? ORDER BY runs.created_at DESC, runs.id DESC LIMIT 51"
    )
      .bind(workflow.id, first.app, bob.userId, bob.userId)
      .all<{ detail: string }>();
    const secondPage = await ask({ pagination: { cursor } });
    const secondCursor = secondPage.ok
      ? z.object({ nextCursor: z.string() }).parse(secondPage.value).nextCursor
      : "";
    // Past twice its size, an ended page says where to split it: where a
    // page of its size from its start ends.
    const cursors = z.object({
      nextCursor: z.string().nullable(),
      splitCursor: z.string().optional(),
    });
    const grown = await ask({
      pagination: { pageSize: 40, endCursor: secondCursor },
    });
    const forty = await ask({ pagination: { pageSize: 40 } });
    expect({
      // Ended where a third page would start: two pages' worth of runs.
      ended: runIds(
        await ask({ pagination: { pageSize: 1, endCursor: secondCursor } })
      ),
      split:
        cursors.parse(grown.ok ? grown.value : {}).splitCursor ===
        cursors.parse(forty.ok ? forty.value : {}).nextCursor,
      firstPage: runIds(firstPage).length,
      secondApp: runIds(await askSecond()).length,
      indexed: plan.results.some(({ detail }) =>
        detail.includes("workflow_resource_runs_principal_idx")
      ),
    }).toStrictEqual({
      ended: [...runIds(firstPage), ...runIds(secondPage)],
      split: true,
      firstPage: 50,
      secondApp: 3,
      indexed: true,
    });

    // The alias bound to another workflow: none of the old one's runs,
    // whatever place in their list a cursor names.
    const other = await greetingOf(owner);
    await bindWorkflowToApp(env, owner, other.id, {
      app: first.app,
      alias: "followUp",
      version: 1,
    });
    const rebound = {
      fresh: runIds(await ask({ pagination: {} })),
      oldCursor: runIds(await ask({ pagination: { cursor } })),
    };

    // A call whose deadline passed while it loaded reads nothing either.
    const lateAnswer = await callAppFunction(
      env,
      bob,
      first.app,
      JSON.stringify({ reference: runs, args: { pagination: {} } }),
      Date.now() - 1
    );
    expect(codeOf(lateAnswer.result)).toBe("function.deadline_exceeded");
    // Revoked, or the person's role taken away, while the call runs:
    // checked again just before anything is read.
    const during = async (app: string, change: () => Promise<unknown>) => {
      const answer = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({
          reference:
            app === first.app
              ? runs
              : queryReference(second.release, "followUp", "runs"),
          args: { pagination: {} },
        }),
        Date.now() + 30_000,
        async () => {
          await change();
        }
      );
      return codeOf(answer.result);
    };
    const lateRemoved = await during(
      second.app,
      async () =>
        await env.DB.prepare(
          "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
        )
          .bind(second.app, bob.userId)
          .run()
    );
    const lateRevoked = await during(
      first.app,
      async () =>
        await env.DB.prepare(
          "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ? AND version = 1"
        )
          .bind(Date.now(), first.app)
          .run()
    );
    expect({ lateRemoved, lateRevoked }).toStrictEqual({
      lateRemoved: "app.not_found",
      lateRevoked: "version.revoked",
    });

    // A release revoked while current answers nothing.
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ? AND version = 1"
    )
      .bind(Date.now(), first.app)
      .run();
    const revoked = codeOf(await ask({ pagination: {} }));

    // Nor to someone no longer in the App.
    await env.DB.prepare(
      "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
    )
      .bind(second.app, bob.userId)
      .run();
    const removed = codeOf(await askSecond());
    expect({ rebound, revoked, removed }).toStrictEqual({
      rebound: { fresh: [], oldCursor: [] },
      revoked: "version.revoked",
      removed: "app.not_found",
    });
  });
});
