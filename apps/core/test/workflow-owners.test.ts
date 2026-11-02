import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appCall, appWith, workflowFiles } from "./workflow-apps.ts";

// A workflow's owner, told when a run a trigger started fails. What could
// go wrong: someone else told, nobody told once the owner can't open the
// App, or the owner changing whom a run acts for, which stays the App's
// owner for a trigger's run. Kept as an App run until a failed JSON run
// tells anyone. Gone with App workflows: who may set an App workflow's
// owner (`workflows.setOwner`), shown on its line; an independent
// workflow's roles are covered by workflow-resources.test.ts.

const idp = mockIdp();

/** Signing people in and building Apps can be slow on CI. */
const slow = { timeout: 60_000 };

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** A workflow that fails in its one step. */
const failing = (id: string) =>
  workflowFiles(
    id,
    `  await step.do("check", { description: "Check" }, async () => {
    throw new Error("Blocked");
  });`,
    { check: null }
  );

/** A workflow that returns whom the App's function sees it call for. */
const whoAmI = (id: string) =>
  workflowFiles(
    id,
    `  return await step.do("who", { description: "Book" }, async () => await ${appCall("ledger.book", "mutation", '{ invoice: "INV-1", total: 1 }')});`,
    { who: "ledger" }
  );

/** Starts a run of `workflow` as a trigger does, and waits for it to end. */
const triggered = async (app: string, workflow: string): Promise<string> => {
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: undefined,
    startedBy: null,
    actor: { type: "system" },
  });
  await finished(run.id);
  return run.id;
};

describe("a workflow's owner", slow, () => {
  it("is told when a run a trigger started fails, while the run still acts for the App's owner", async () => {
    const [owner, answers] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await appWith(owner, {
      ...failing("careless"),
      ...whoAmI("booking"),
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: answers.userId,
      role: "user",
    });
    await owner.api.workflows.setOwner(app, "careless", answers.userId);
    await owner.api.workflows.setOwner(app, "booking", answers.userId);

    const failed = await triggered(app, "careless");
    const booked = await triggered(app, "booking");
    // Once the owner can't open the App, its owner is told instead.
    await owner.api.apps.members.remove(app, {
      type: "person",
      id: answers.userId,
    });
    const unseen = await triggered(app, "careless");
    const { output } = await owner.api.workflows.status(booked);
    const events = await allEvents();
    const notified = events
      .filter(
        ({ action, target }) =>
          action === "workflow.run.notified" &&
          (target?.id === failed || target?.id === unseen)
      )
      .map(({ target, detail }) => [target?.id, detail.person]);
    const told = async (person: Person) => {
      const { notifications } = await person.api.notifications.list();
      return notifications.flatMap((notice) =>
        notice.type === "run_failed" &&
        (notice.run === failed || notice.run === unseen)
          ? [notice.run]
          : []
      );
    };

    expect({
      notified,
      answers: await told(answers),
      owner: await told(owner),
      output,
    }).toStrictEqual({
      notified: [
        [failed, answers.userId],
        [unseen, owner.userId],
      ],
      answers: [],
      owner: [unseen],
      output: `ledger-INV-1-for-${owner.userId}`,
    });
  });
});
