import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import {
  connectHubspot,
  connectingAdmin,
  crmWorkflow,
} from "./hubspot-workflow.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// The workflows that use a connection, as the connection's page lists
// them: an independent workflow, through its approved binding, for those
// who can open it. What could go wrong: a workflow listed to someone it
// isn't shared with, or still listed once its approval goes. Gone with App
// workflows, each read from an App's versions and runs only: the Workflows
// page's list of every App workflow with its latest, waiting, failed and
// handled runs; the Runs tab's order, filters, paging, queued runs and
// index reads; a workflow's view of its steps and parameters; its Test;
// and the App workflows calling their App's permission on a connection.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** The workflows using `connection`, as `person` lists them. */
const workflowsUsing = async (
  person: {
    api: { workflows: Pick<Person["api"]["workflows"], "byConnection"> };
  },
  connection: string
): Promise<string[][]> => {
  const uses = await person.api.workflows.byConnection();
  const using = uses.find(({ connectionId }) => connectionId === connection);
  return (using?.workflows ?? []).map((workflow) =>
    workflow.kind === "app" ? [workflow.app, workflow.workflow] : [workflow.id]
  );
};

describe("the workflows that use a connection", { timeout: 60_000 }, () => {
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
    ).resolves.toStrictEqual([[[workflow.id]], []]);

    await revokeWorkflowBinding(
      env,
      by.identity,
      workflow.id,
      workflow.approval
    );
    await expect(workflowsUsing(asAdmin, hubspot)).resolves.toStrictEqual([]);
  });
});
