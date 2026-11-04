import type { Role } from "@grasp-os/shared/roles";
import { failedRunDays } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import {
  connectHubspot,
  connectingAdmin,
  crmWorkflow,
} from "./hubspot-workflow.ts";
import { mockIdp } from "./idp.ts";
import { seedResourceRun } from "./runs.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The Workflows page: every workflow of every App a person can open, and
// the runs across them; and the workflows that use a connection. What
// could go wrong: a workflow or run of an App someone can't open showing
// up, counts that count the wrong runs, a waiting run lost below the
// others, or a workflow listed to someone it isn't shared with, or still
// listed once its approval goes. An independent workflow's use of a
// connection runs as a JSON workflow. Kept as App runs until independent
// workflows have a Workflows page: the page's list, the Runs tab (its
// order, filters, paging, queued runs and index reads), each read from
// App versions and runs only. Gone with App workflows, which read them
// from an App's code: a workflow's view of its steps and parameters, its
// Test, and the App workflows calling their App's permission on a
// connection.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** The IDs of the workflows `person` is told use `connection`. */
const workflowsUsing = async (
  person: {
    api: { workflows: Pick<Person["api"]["workflows"], "byConnection"> };
  },
  connection: string
): Promise<string[]> => {
  const uses = await person.api.workflows.byConnection();
  const using = uses.find(({ connectionId }) => connectionId === connection);
  return (using?.workflows ?? []).map(({ id }) => id);
};

/**
 * The independent workflows `person` sees summed up, each with its owner's
 * ID for its owner.
 */
const independent = async (person: Person) => {
  const all = await person.api.workflows.overview();
  return all.flatMap((row) =>
    row.type === "resource" ? [{ ...row, owner: row.owner.userId }] : []
  );
};

const minute = 60_000;
const day = 24 * 60 * minute;

// Releasing a version compiles its workflows and runs their tests, and a
// Test runs them again in an isolate: on a loaded runner that takes
// longer than the default five seconds. Sixty is room for a slow runner,
// not for a hang.
const buildTime = { timeout: 60_000 };

describe("the Workflows page", buildTime, () => {
  it("lists the independent workflows a person has a role in after the Apps', each summed up from the runs its page lists them", async () => {
    const [owner, user, stranger] = await Promise.all([
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
    ]);
    const workflow = await owner.api.workflowResources.create(
      `intake-${unique()}`
    );
    await owner.api.workflowResources.share(workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const now = Date.now();
    const runs = await Promise.all([
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "completed",
        createdAt: now - day,
      }),
      // Failed, but before the failures counted.
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "failed",
        createdAt: now - (failedRunDays + 1) * day,
      }),
      seedResourceRun({
        workflow: workflow.id,
        principal: user.userId,
        status: "failed",
        createdAt: now - minute * 2,
      }),
      seedResourceRun({
        workflow: workflow.id,
        principal: owner.userId,
        status: "running",
        createdAt: now - minute,
      }),
    ]);
    const [usersLatest, ownersLatest] = runs.slice(2);
    const summary = (change: object) => ({
      type: "resource",
      workflowId: workflow.id,
      name: workflow.name,
      version: null,
      owner: owner.userId,
      waiting: 0,
      ...change,
    });
    expect({
      owner: await independent(owner),
      user: await independent(user),
      stranger: await independent(stranger),
    }).toStrictEqual({
      // Its builder sees every run.
      owner: [
        summary({
          lastRun: {
            id: ownersLatest,
            status: "running",
            createdAt: new Date(now - minute).toISOString(),
          },
          failed: 1,
          handled: 1,
        }),
      ],
      // Its user, their own alone.
      user: [
        summary({
          lastRun: {
            id: usersLatest,
            status: "failed",
            createdAt: new Date(now - minute * 2).toISOString(),
          },
          failed: 1,
          handled: 0,
        }),
      ],
      stranger: [],
    });
  });

  it("lists an independent workflow that uses a connection through its approved binding, for those who can open it, until the approval goes", async () => {
    const by = await connectingAdmin(idp);
    const [hubspot, builder] = await Promise.all([
      connectHubspot(by),
      personApi("builder"),
    ]);
    const workflow = await crmWorkflow(by, hubspot);
    const asAdmin = { api: { workflows: by.workflows } };

    await expect(
      Promise.all([
        workflowsUsing(asAdmin, hubspot),
        // Not shared with them, so not theirs to see.
        workflowsUsing(builder, hubspot),
      ])
    ).resolves.toStrictEqual([[workflow.id], []]);

    await revokeWorkflowBinding(
      env,
      by.identity,
      workflow.id,
      workflow.approval
    );
    await expect(workflowsUsing(asAdmin, hubspot)).resolves.toStrictEqual([]);
  });
});
