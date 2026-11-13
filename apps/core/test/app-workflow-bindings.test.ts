import { v } from "@grasp-os/runtime/app";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appOf, boundIn, publishApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { publishDefined, racingDb, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  contractOf,
  greetingOf,
  jobEventsContract,
  jobEventsDeclared,
  jobWaitingOf,
  jsonWorkflowAppsOf,
  requestsApp,
} from "./json-workflow-apps.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { publishDefinition, publishOverRpc } from "./workflow-publishing.ts";

// Which workflows an App binds, and how an App and the workflows it binds
// change without either waiting on the other (app-workflow-bindings.ts).
// A binding is part of the App's version: what the version published
// binds is what its starts run, and the bindings are read
// (`workflowResources.appBindings`) by the App's builders alone, never by
// someone who only uses the App, nor by anyone it isn't shared with (who
// is told there is no such App), nor by Grasp staff, who never decide what
// a client's App runs. What could go wrong: a workflow version that drops
// what an App's pages name going live, or an App version declaring what
// its workflow doesn't have; an App and its workflow each blocking the
// other's change for good; an App's and a workflow's new version landing
// at once, each checked against what the other replaced.

const idp = mockIdp();

/** A builder, an App of theirs, and a workflow of theirs with a live version. */
const setUp = async () => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Ledger" });
  const flow = await builder.api.workflowResources.create(`bound-${unique()}`);
  await publishOverRpc(
    builder.api,
    flow.id,
    greetingOf(undefined, "Version 1")
  );
  return { builder, app, flow };
};

describe("an App's workflow bindings, as its builders read them", () => {
  it("lists what each alias the live version binds, and ends a binding the next version no longer makes", async () => {
    const { builder, app, flow } = await setUp();
    await release(
      builder,
      app,
      boundIn(requestsApp("summary"), { summary: flow.id })
    );
    const first = await builder.api.workflowResources.appBindings(app);
    await release(
      builder,
      app,
      boundIn(requestsApp("archive"), { archive: flow.id })
    );
    const second = await builder.api.workflowResources.appBindings(app);

    expect({
      first: first.map(({ alias, workflowId, boundBy }) => ({
        alias,
        workflowId,
        boundBy,
      })),
      second: second.map(({ alias, workflowId }) => ({ alias, workflowId })),
    }).toStrictEqual({
      first: [
        { alias: "summary", workflowId: flow.id, boundBy: builder.userId },
      ],
      second: [{ alias: "archive", workflowId: flow.id }],
    });
  });

  it("keeps an archived App's bindings readable for when it is restored", async () => {
    const { builder, app, flow } = await setUp();
    await release(
      builder,
      app,
      boundIn(requestsApp("summary"), { summary: flow.id })
    );
    const [bound] = await builder.api.workflowResources.appBindings(app);
    await builder.api.apps.archive(app);

    const listed = await builder.api.workflowResources.appBindings(app);

    expect(listed.map(({ id }) => id)).toStrictEqual([bound?.id]);
  });

  it("is read by its builders, and by nobody else, never Grasp staff", async () => {
    const { builder, app, flow } = await setUp();
    await release(
      builder,
      app,
      boundIn(requestsApp("summary"), { summary: flow.id })
    );
    const [sharedBuilder, user, stranger] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: sharedBuilder.userId,
      role: "builder",
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    const outcomes = {
      sharedBuilder: await outcome(
        sharedBuilder.api.workflowResources.appBindings(app)
      ),
      // Bindings are open to its builders only: whoever only uses it is
      // refused.
      user: await outcome(user.api.workflowResources.appBindings(app)),
      stranger: await outcome(stranger.api.workflowResources.appBindings(app)),
      staff: await outcome(staff.workflowResources.appBindings(app)),
      invalid: await outcome(builder.api.workflowResources.appBindings("")),
    };

    expect(outcomes).toStrictEqual({
      sharedBuilder: "ok",
      user: "role.forbidden",
      stranger: "app.not_found",
      staff: "role.forbidden",
      invalid: "app.not_found",
    });
  });
});

/** What refusing a change named: its code, words and Apps; or "ok". */
const refusedOf = async (
  work: Promise<unknown>
): Promise<"ok" | { code: string; message: string; details: unknown }> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    return {
      code: workflowResourceErrors.codeOf(error) ?? String(error),
      message: error instanceof Error ? error.message : "",
      details:
        typeof error === "object" && error !== null
          ? Reflect.get(error, "details")
          : undefined,
    };
  }
};

/** `refused` without its words, and whether they say `said`. */
const saying = (
  refused: Awaited<ReturnType<typeof refusedOf>>,
  said: string
) =>
  refused === "ok"
    ? "ok"
    : {
        code: refused.code,
        details: refused.details,
        says: refused.message.includes(said),
      };

describe("an App and the workflow it binds, changing", () => {
  /** An admin, a builder, the events contract and an empty workflow of theirs. */
  const contractSetUp = async () => {
    const { signedIn: signedInPerson } = jsonWorkflowAppsOf(idp);
    const [admin, builder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInPerson("builder"),
    ]);
    const events = await jobEventsContract(admin);
    const api = builder.api.workflowResources;
    const flow = await api.create(`bound-${unique()}`);
    const { id: app } = await builder.api.apps.create({ name: "Requests" });
    const publish = async (definition: string) =>
      await refusedOf(publishOverRpc(builder.api, flow.id, definition));
    /**
     * Binds the workflow again in the App's draft, declaring what `chosen`
     * names of its live version (all of it without), and publishes it.
     */
    const rebound = async (chosen: Record<string, string[]> = {}) => {
      const changed = await builder.api.apps.define(app, {
        op: "bindWorkflow",
        alias: "review",
        workflow: flow.id,
        ...chosen,
      });
      if (!changed.ok) {
        return changed.problem;
      }
      const subject = { kind: "app", id: app } as const;
      const { revision } = await builder.api.drafts.get(subject);
      return await refusedOf(builder.api.drafts.publish(subject, revision));
    };
    /** The workflows the App binds now. */
    const bound = async () => {
      const listed = await api.appBindings(app);
      return listed.map(({ workflowId }) => workflowId);
    };
    /** Whether the App's live version's config declares `name`. */
    const declares = async (name: string) => {
      const files = await builder.api.drafts.files({ kind: "app", id: app });
      return files["grasp.config.ts"]?.includes(name) === true;
    };
    return {
      admin,
      builder,
      events,
      api,
      flow,
      app,
      publish,
      rebound,
      bound,
      declares,
    };
  };

  it("lets a workflow add events at once, which the App declares once bound again", async () => {
    const { builder, events, flow, app, publish, rebound, bound, declares } =
      await contractSetUp();
    await publish(jobWaitingOf(events));
    await release(
      builder,
      app,
      boundIn(requestsApp("review", jobEventsDeclared), { review: flow.id })
    );

    // Its version 2 waits for another event too: no App relies on it yet.
    const added = await publish(
      jobWaitingOf(events, { more: ["laterEvents"] })
    );
    const before = await declares("laterEvents");
    const declared = await rebound();

    expect({
      added,
      before,
      declared,
      after: await declares("laterEvents"),
      bound: await bound(),
    }).toStrictEqual({
      added: "ok",
      before: false,
      declared: "ok",
      after: true,
      bound: [flow.id],
    });
  });

  it("drops what an App relies on only once it no longer declares it, naming the App and what it uses until then", async () => {
    const { builder, events, flow, app, publish, rebound } =
      await contractSetUp();
    await publish(jobWaitingOf(events, { more: ["laterEvents"] }));
    await release(
      builder,
      app,
      boundIn(requestsApp("review"), { review: flow.id })
    );
    // Bound from its draft, the App declares all the live version has.
    await rebound();

    const whileDeclared = await publish(jobWaitingOf(events));
    // Its draft leaves the event and its task out, and goes live.
    const undeclared = await rebound({
      events: ["jobEvents"],
      listens: ["job"],
    });
    const dropped = await publish(jobWaitingOf(events));

    expect({
      whileDeclared: saying(
        whileDeclared,
        "Requests uses event `laterEvents`, listen task `laterEvents`"
      ),
      undeclared,
      dropped,
    }).toStrictEqual({
      whileDeclared: {
        code: "workflow.app_binding_contract_changed",
        details: {
          apps: [
            {
              id: app,
              name: "Requests",
              uses: ["event `laterEvents`", "listen task `laterEvents`"],
            },
          ],
        },
        says: true,
      },
      undeclared: "ok",
      dropped: "ok",
    });
  });

  it("refuses an App version declaring what its workflow's live version doesn't have, or has in another shape, naming it", async () => {
    const { admin, builder, events, flow, app, publish } =
      await contractSetUp();
    await publish(jobWaitingOf(events));
    const decision = `approval-${unique()}`;
    await admin.api.workflowResources.publishContract({
      key: decision,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
    });
    const { name } = await builder.api.workflowResources.get(flow.id);
    const declaring = (declares: Parameters<typeof requestsApp>[1]): TestApp =>
      boundIn(requestsApp("review", declares), { review: flow.id });
    const published = async (
      declares: Parameters<typeof requestsApp>[1],
      gap: string
    ) =>
      saying(
        await refusedOf(publishApp(builder.api, app, declaring(declares))),
        `Requests uses ${gap} of ${name}`
      );
    const refusal = (gap: string) => ({
      code: "workflow.app_binding_contract_changed",
      details: {
        apps: [{ id: app, name: "Requests", uses: [`${gap} of ${name}`] }],
      },
      says: true,
    });
    const { jobEvents } = jobEventsDeclared.events;
    if (jobEvents === undefined) {
      throw new Error("No jobEvents declared");
    }

    expect({
      missing: await published(
        contractOf({
          ...jobEventsDeclared,
          decisions: {
            approval: {
              value: v.object({ comment: v.string() }).descriptor,
              context: v.object({ who: v.string() }).descriptor,
            },
          },
        }),
        "decision `approval`"
      ),
      otherShape: await published(
        contractOf({
          ...jobEventsDeclared,
          events: { jobEvents: { ...jobEvents, type: "grasp.job.other" } },
        }),
        "event `jobEvents`"
      ),
      fits: await published(jobEventsDeclared, ""),
    }).toStrictEqual({
      missing: refusal("decision `approval`"),
      otherShape: refusal("event `jobEvents`"),
      fits: "ok",
    });
  });

  it("refuses whichever of an App's and its workflow's new version lands second over what the other checked", async () => {
    const { builder, events, api, flow, app, publish } = await contractSetUp();
    await publish(jobWaitingOf(events));
    const declaring = boundIn(requestsApp("review", jobEventsDeclared), {
      review: flow.id,
    });
    await release(builder, app, declaring);
    /** Another version of the App, declaring and binding the same. */
    const anotherApp = (title: string): TestApp =>
      appOf(declaring.definition, {
        ...declaring.files,
        "src/routes/index.tsx": (
          declaring.files["src/routes/index.tsx"] ?? ""
        ).replace("Requests", title),
      });
    // The workflow's version 2, of what the App declares, goes live as
    // the App's next version, checked against version 1, is about to.
    const appRaced = await outcome(
      publishDefined(
        {
          ...env,
          DB: racingDb(async () => {
            await publishOverRpc(
              builder.api,
              flow.id,
              jobWaitingOf(events, { label: "Version 2" })
            );
          }, /^update "apps" set "current_version"/iu),
        },
        builder.acting,
        app,
        anotherApp("Open requests")
      )
    );
    let appLive: number | undefined;
    // The App's next version goes live as the workflow's version 3,
    // checked against the App's version before, is about to.
    const workflowRaced = await outcome(
      publishDefinition(
        {
          ...env,
          DB: racingDb(async () => {
            ({ version: appLive } = await publishApp(
              builder.api,
              app,
              anotherApp("All requests")
            ));
          }, /^update "workflow_resources" set "current_version"/iu),
        },
        builder.acting,
        flow.id,
        jobWaitingOf(events, { label: "Version 3" })
      )
    );
    const { currentVersion } = await builder.api.apps.get(app);
    const workflow = await api.get(flow.id);

    expect({
      appRaced,
      workflowRaced,
      appLive: currentVersion === appLive,
      workflowLive: workflow.currentVersion,
    }).toStrictEqual({
      appRaced: "draft.conflict",
      workflowRaced: "draft.conflict",
      appLive: true,
      workflowLive: 2,
    });
  });
});
