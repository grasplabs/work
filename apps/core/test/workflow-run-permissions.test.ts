import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { grantReviewed, outlook, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  endLiveRuns,
  finished,
  leave,
  stepDone,
  stopped,
  woken,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  appWith,
  hitCall,
  hitsOf,
  triggered,
  workflowFiles,
} from "./workflow-apps.ts";

// Workflows are code the agent writes, run for real: committed to an App,
// tested when their version is made current, and run on the engine
// (Workerflow) by the dispatcher, each in an isolate of its own. Time is
// moved on where a run sleeps (`woken`); the outside systems faked
// here are the model provider behind AI Gateway, and a mail provider's MCP
// server behind the real connect (test/mail-server.ts).
//
// A run's audit events are in an outbox by the time the run has ended: the
// dispatcher's end step writes the run's own event with its row, and each
// step's and each connection call's event is written before the step goes
// on. `allEvents` drains the outboxes before it reads, so a test reads them
// once, after the run ended, rather than wait for them: a wait with a
// deadline adds nothing, and one read of the log can take longer than a
// short deadline on a loaded runner.
//
// These are the runs that act with what their App and person may: the
// version an admin approved, granted permissions, people who left (the
// rest of workflows.test.ts).

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * A step that calls Outlook: connections don't exist in connect yet, so
 * `reached` is a call that passed every check on its way.
 */
const mailStep = (
  name: string
) => `  await step.do("${name}", { description: "Read mail" }, async () => {
    try {
      await env.OUTLOOK.call("mail.list", {});
      return "sent";
    } catch (error) {
      if ((error as { code?: string }).code === "connect.connection_not_found") {
        return "reached";
      }
      throw error;
    }
  });`;

/** A workflow `pinned` that waits, then says which version it is. */
const versioned = (label: number) =>
  workflowFiles(
    "pinned",
    `  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return { version: ${label} };`
  );

describe("workflow runs", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("keep the version they started on after a new one is current", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, versioned(1));
    const first = await builder.api.workflows.start(app, "pinned");
    await stepDone(first.id, "$params");
    await stopped(first.id);

    await release(builder, app, versioned(2));
    const second = await builder.api.workflows.start(app, "pinned");
    // The first run loads again only now, with version 2 current.
    const outputs = await Promise.all(
      [first, second].map(async ({ id }) => {
        await woken(id);
        await finished(id);
        return await builder.api.workflows.status(id);
      })
    );
    expect(outputs).toMatchObject([
      { version: 1, status: "completed", output: { version: 1 } },
      { version: 2, status: "completed", output: { version: 2 } },
    ]);
  });

  it("fail the next step of a run on a version no admin approved, whatever is granted again for another", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const version = (mark: string) =>
      workflowFiles(
        "mailer",
        `  // ${mark}
  await step.sleep("go", { description: "Wait", duration: "1 day" });
${mailStep("after")}`,
        { after: "reached" }
      );
    const app = await appWith(builder, version("First."));
    const permission = await requestGranted(idp, builder, outlook(app));
    // The attack: the builder's own code, which an admin's run starts on
    // and waits in; then harmless code, which an admin grants again for.
    await release(builder, app, version("Mails whatever it likes."));
    const run = await admin.api.workflows.start(app, "mailer");
    await stepDone(run.id, "$params");
    await stopped(run.id);
    await release(builder, app, version("Harmless."));
    await grantReviewed(admin.api, permission);

    await woken(run.id);
    await finished(run.id);
    // A run on the version the admin granted for works.
    const approved = await admin.api.workflows.start(app, "mailer");
    await woken(approved.id);
    await finished(approved.id);
    const events = await allEvents();
    const failedStep = events.find(
      ({ action, target }) =>
        action === "workflow.step.failed" && target?.id === run.id
    );

    expect({
      attacked: await admin.api.workflows.status(run.id),
      failedStep: failedStep?.detail,
      approved: await admin.api.workflows.status(approved.id),
    }).toMatchObject({
      attacked: { version: 2, status: "failed" },
      failedStep: { step: "after", errorCode: "permission.denied" },
      approved: { version: 3, status: "completed" },
    });
  });

  it("fail the next step with a permission error once a permission is revoked mid-run", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "mailer",
        `${mailStep("before")}
  await step.sleep("go", { description: "Wait", duration: "1 day" });
${mailStep("after")}`,
        { before: "reached", after: "reached" }
      )
    );
    const permission = await requestGranted(idp, admin, outlook(app));
    const run = await admin.api.workflows.start(app, "mailer");
    await stepDone(run.id, "before");
    await stopped(run.id);

    await admin.api.permissions.revoke(permission);
    await woken(run.id);
    await finished(run.id);
    const { status, error } = await admin.api.workflows.status(run.id);
    const events = await allEvents();
    const steps = events.flatMap(({ action, target, detail }) =>
      action.startsWith("workflow.step.") && target?.id === run.id
        ? [{ action, step: detail.step, errorCode: detail.errorCode }]
        : []
    );
    expect({
      status,
      clearError: error?.message.includes(
        "This workflow has no permission named OUTLOOK: it was never granted, or it was revoked."
      ),
      steps,
    }).toMatchObject({
      status: "failed",
      clearError: true,
      steps: [
        { action: "workflow.step.completed", step: "$params" },
        { action: "workflow.step.completed", step: "before" },
        {
          action: "workflow.step.failed",
          step: "after",
          errorCode: "permission.denied",
        },
      ],
    });
  });

  it("fail a triggered run once its App's owner has left, at its start or before its next step", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const app = await appWith(
      owner,
      workflowFiles(
        "triggered",
        `  await step.do("first", { description: "First" }, async () => await ${hitCall(`"first"`)});
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("book", { description: "Book" }, async () => await ${hitCall(`"book"`)});`,
        { first: 1, book: 1 }
      )
    );

    // Gone while the run waits between two steps: the next one doesn't run.
    const midWay = await triggered(app, "triggered");
    await stepDone(midWay.id, "first");
    const rejoin = await leave(owner.userId);
    await woken(midWay.id);
    await finished(midWay.id);
    await rejoin();
    const booked = await hitsOf(owner, app, "book");

    // Offboarded by an admin before the run starts.
    await admin.api.members.remove(owner.userId);
    const atStart = await triggered(app, "triggered");
    await finished(atStart.id);

    const outcomes = await Promise.all(
      [midWay, atStart].map(async ({ id }) => {
        const { status, failure } = await admin.api.workflows.status(id);
        return { status, step: failure?.step, code: failure?.error.code };
      })
    );
    const failed = {
      step: null,
      status: "failed",
      code: "permission.person_inactive",
    };
    expect({ booked, outcomes }).toStrictEqual({
      booked: 0,
      outcomes: [failed, failed],
    });
  });

  it("fail a person's run once they have left, at its next load", async () => {
    const admin = await personApi("admin");
    const leaver = await personApi("builder");
    const app = await appWith(
      leaver,
      workflowFiles(
        "waiting",
        `  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return "went on";`
      )
    );
    const run = await leaver.api.workflows.start(app, "waiting");
    await stepDone(run.id, "$params");
    await stopped(run.id);
    // Offboarded by an admin, as in the product.
    await admin.api.members.remove(leaver.userId);
    await woken(run.id);
    await finished(run.id);
    const { status, error } = await admin.api.workflows.status(run.id);
    expect({
      status,
      personGone: error?.message.includes(
        "The person this acts for no longer has access to this deployment."
      ),
    }).toStrictEqual({ status: "failed", personGone: true });
  });

  it("run with only their App's permissions, no network, and reading in their App's restricted mode", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "probe",
        `  return await step.do("probe", { description: "Probe" }, async () => {
    let fetched;
    try {
      await fetch("https://example.com/");
      fetched = "fetched";
    } catch (error) {
      fetched = String(error);
    }
    let read;
    try {
      await env.OUTLOOK.call("mail.list", {});
      read = "ok";
    } catch (error) {
      read = (error as { code?: string }).code;
    }
    let other;
    try {
      await env.DRIVE.call("files.list", {});
      other = "ok";
    } catch (error) {
      other = (error as { code?: string }).code;
    }
    return { fetched, read, other };
  });`,
        { probe: null }
      )
    );
    await requestGranted(idp, admin, outlook(app));
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "probe");
    await finished(run.id);
    const { status, output } = await admin.api.workflows.status(run.id);
    expect({
      status,
      output,
      offline: JSON.stringify(output).includes(
        "not permitted to access the internet"
      ),
    }).toMatchObject({
      status: "completed",
      // A read still reaches connect (there is no such connection). Side
      // effects wait for the person (the tests of held side effects).
      output: {
        read: "connect.connection_not_found",
        // Only what it was granted: a binding it wasn't is none.
        other: "permission.denied",
      },
      offline: true,
    });
  });

  it("build their bindings before the workflow's code loads, so a built-in it replaces is handed none of them", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "taker",
      `  return await step.do("take", { description: "Take" }, async () => {
    const bindings = taken.find((one) => typeof one?.APP?.callFunction === "function");
    if (bindings !== undefined) {
      await bindings.APP?.callFunction?.({ contractId: "counter.hit", kind: "action" }, { name: "taken", execution: crypto.randomUUID() });
    }
    return bindings === undefined ? "nothing" : "bindings";
  });`,
      { take: null }
    );
    // As the module loads, it puts its own in place of what a run's
    // bindings could be built with, each keeping what it is handed: no
    // `env` anywhere in its code.
    const takes = `const taken: { APP?: { callFunction?: (...args: object[]) => Promise<unknown> } }[] = [];
const RealProxy = globalThis.Proxy;
// Past the types, as a module that takes what it is handed would be.
globalThis.Proxy = function (target: object, handler: ProxyHandler<object>) {
  taken.push(target);
  return new RealProxy(target, handler);
} as unknown as ProxyConstructor;
const realFromEntries = Object.fromEntries;
Object.fromEntries = (entries: Iterable<readonly [PropertyKey, unknown]>) => {
  const made = realFromEntries(entries);
  taken.push(made);
  return made;
};
const realHasOwn = Object.hasOwn;
Object.hasOwn = (target: object, name: PropertyKey) => {
  taken.push(target);
  return realHasOwn(target, name);
};
`;
    const app = await appWith(admin, {
      ...files,
      "workflows/taker.ts": `${takes}${files["workflows/taker.ts"]}`,
    });

    const run = await admin.api.workflows.start(app, "taker");
    await finished(run.id);

    const { status, output } = await admin.api.workflows.status(run.id);
    expect({
      status,
      output,
      hits: await hitsOf(admin, app, "taken"),
    }).toStrictEqual({ status: "completed", output: "nothing", hits: 0 });
  });

  it("show what a run returned only to the person who started it, and admins", async () => {
    const starter = await personApi("builder");
    const other = await personApi("builder");
    const admin = await personApi("admin");
    const app = await appWith(
      starter,
      workflowFiles(
        "private",
        `  return await step.do("read", { description: "Read" }, async () => "what the starter may read");`,
        { read: "x" }
      )
    );
    await starter.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const run = await starter.api.workflows.start(app, "private");
    await finished(run.id);
    const seen = await Promise.all(
      [starter, other, admin].map(async ({ api }) => {
        const { status, output } = await api.workflows.status(run.id);
        return { status, output };
      })
    );
    expect(seen).toStrictEqual([
      { status: "completed", output: "what the starter may read" },
      { status: "completed", output: undefined },
      { status: "completed", output: "what the starter may read" },
    ]);
  });
});
