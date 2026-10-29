import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { allEvents } from "./audit-events.ts";
import {
  addedSince,
  deliver,
  intake,
  invoiceMail,
  readByRun,
  runsOf,
  storedName,
  storedObjects,
} from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { runQuarterHourTasks } from "./maintenance.ts";
import { aroundEngine, endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// The attachments of mail an email trigger received (email-triggers.ts):
// kept for the App's runs alone, read by them, and deleted in time.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * A workflow receiving mail at `address` that reads the message's first
 * attachment in a step, and returns its name for the message and the
 * attachment's content, as text.
 */
const reader = (address: string): Record<string, string> => ({
  "workflows/reader.ts": `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "reader",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${address}" }] },
  async (step, { input, readAttachment }) =>
    await step.do("read", { description: "Read the invoice" }, async () => {
      const pdf = await readAttachment(input, 0);
      return { stored: input.stored, content: String.fromCharCode(...pdf) };
    })
);
`,
  "workflows/reader.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./reader.ts";

const stored = "2026-09-29/${"0".repeat(64)}";
const input = { id: "m", stored, from: { name: "", address: "a@b.test" }, to: [], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [{ filename: "inv.pdf", mimeType: "application/pdf", size: 5 }] };

export default workflowTests(definition, [
  { name: "reads", input, attachments: { [stored]: [new TextEncoder().encode("%PDF-")] }, expect: { output: { stored, content: "%PDF-" } } },
]);
`,
});

/**
 * A workflow started by hand with a kept message's name, which reads its
 * first attachment, as a run of another App would try to.
 */
const snoop: Record<string, string> = {
  "workflows/snoop.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "snoop",
  { params: {}, input: z.object({ stored: z.string() }) },
  async (step, { input, readAttachment }) =>
    await step.do("read", { description: "Read another App's mail" }, async () =>
      (await readAttachment(input, 0)).byteLength
    )
);
`,
  "workflows/snoop.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./snoop.ts";

export default workflowTests(definition, [
  { name: "runs", input: { stored: "x" }, mocks: { read: 0 }, expect: { output: 0 } },
]);
`,
};

/**
 * A workflow started by hand with reads to try: each a kept message's
 * name and an attachment's index, as sent. It catches every refusal, as
 * code probing for what it may read would, and returns their codes.
 */
const probe: Record<string, string> = {
  "workflows/probe.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "probe",
  { params: {}, input: z.object({ reads: z.array(z.object({ stored: z.string(), index: z.number() })) }) },
  async (step, { input, readAttachment }) =>
    await step.do("probe", { description: "Try some reads" }, async () => {
      const codes: string[] = [];
      for (const { stored, index } of input.reads) {
        try {
          await readAttachment({ stored }, index);
          codes.push("read");
        } catch (error) {
          codes.push(String((error as { code?: unknown }).code));
        }
      }
      return codes;
    })
);
`,
  "workflows/probe.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./probe.ts";

export default workflowTests(definition, [
  { name: "runs", input: { reads: [] }, mocks: { probe: [] }, expect: { output: [] } },
]);
`,
};

/** The audit log's reads of kept messages by run `run`. */
const readsBy = async (run: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.email.read" && target?.id === run
    )
    .map(({ actor, detail }) => ({ actor, detail }));
};

describe("attachments of mail", () => {
  afterEach(endLiveRuns);

  it("are read by the run the message started, and each read is audited", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, reader("scans"));

    await deliver("scans@grasp.test", invoiceMail({ to: "scans@grasp.test" }));
    const [run] = await runsOf(builder, app);
    await finished(run?.id ?? "");
    const { output } = await builder.api.workflows.status(run?.id ?? "");
    const read = z
      .object({ stored: z.string(), content: z.string() })
      .parse(output);

    // The PDF as it was sent: its bytes, not what the message said of them.
    expect(read.content).toBe("%PDF-");
    await expect(readsBy(run?.id ?? "")).resolves.toStrictEqual([
      {
        actor: {
          type: "workflow",
          runId: run?.id,
          appId: app,
          workflowId: "reader",
        },
        detail: {
          app,
          workflow: "reader",
          version: 1,
          step: "read",
          message: read.stored,
          attachment: 0,
          bytes: 5,
        },
      },
    ]);
  });

  it("are read by a run whose first delivery stopped while starting it, started once by the delivery that comes again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, reader("restarted"));
    const to = "restarted@grasp.test";
    const messageId = `${crypto.randomUUID()}@acme.test`;
    // The first delivery stops with its run's row written and its start
    // not yet at the engine, as when core goes down there.
    const { promise: stuck, resolve: unstick } = Promise.withResolvers<null>();
    const { promise: asked, resolve: startAsked } =
      Promise.withResolvers<null>();
    let held = false;
    let first: Promise<string> | undefined;
    await aroundEngine(
      async (method, call) => {
        if (method === "start" && !held) {
          held = true;
          startAsked(null);
          await stuck;
        }
        return await call();
      },
      async () => {
        first = outcome(
          deliver(to, invoiceMail({ to, messageId, receivedBy: "mx1" }))
        );
        await asked;
        // Delivered again, through another server: it sends that run's
        // start again, and the run reads the message as the first
        // delivery kept it.
        await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx2" }));
      }
    );
    const [run] = await runsOf(builder, app);
    await finished(run?.id ?? "");
    unstick(null);
    await first;
    const { status, output } = await builder.api.workflows.status(
      run?.id ?? ""
    );

    const runs = await runsOf(builder, app);
    expect({
      runs: runs.length,
      status,
      output,
    }).toMatchObject({
      runs: 1,
      status: "completed",
      output: { content: "%PDF-" },
    });
  });

  it("can't be read by another App's run, which is refused and audited", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, reader("private"));
    const other = await appWith(builder, snoop);
    const before = await storedObjects();

    await deliver(
      "private@grasp.test",
      invoiceMail({ to: "private@grasp.test" })
    );
    const [received] = await runsOf(builder, app);
    await finished(received?.id ?? "");
    const { output } = await builder.api.workflows.status(received?.id ?? "");
    const { stored } = z.object({ stored: z.string() }).parse(output);
    const { id: run } = await builder.api.workflows.start(other, "snoop", {
      stored,
    });
    await finished(run);

    await expect(builder.api.workflows.status(run)).resolves.toMatchObject({
      status: "failed",
      failure: {
        step: "read",
        error: { code: "workflow.attachment_not_found" },
      },
    });
    await expect(readsBy(run)).resolves.toMatchObject([
      {
        detail: {
          app: other,
          message: stored,
          attachment: 0,
          errorCode: "workflow.attachment_not_found",
        },
      },
    ]);
    // It was kept for its own App only.
    await expect(addedSince(before)).resolves.toStrictEqual([
      `inbound-email/${stored.split("/")[0]}/${app}/${stored.split("/")[1]}`,
    ]);
  });

  it("are deleted once 30 days have passed since the day they were kept", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("kept"));
    await deliver("kept@grasp.test", invoiceMail({ to: "kept@grasp.test" }));
    const { id, stored } = await readByRun(builder, app);
    const day = storedName.exec(stored ?? "")?.groups?.day ?? "";
    const key = `inbound-email/${day}/${app}/${id}`;
    const dayEnded = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000;
    const kept = async (): Promise<boolean> =>
      (await env.FILES.head(key)) !== null;

    // Up to 30 days after its day ended, it stays.
    await runQuarterHourTasks(
      {},
      new Date(dayEnded + 30 * 24 * 60 * 60 * 1000 - 1)
    );
    await expect(kept()).resolves.toBeTruthy();
    // Then the next run deletes it.
    await runQuarterHourTasks(
      {},
      new Date(dayEnded + 30 * 24 * 60 * 60 * 1000)
    );
    await expect(kept()).resolves.toBeFalsy();
  });

  it("refuse, and audit, a read its code catches: a name that isn't one, or an attachment the message hasn't", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, { ...reader("probed"), ...probe });

    await deliver(
      "probed@grasp.test",
      invoiceMail({ to: "probed@grasp.test" })
    );
    const runs = await runsOf(builder, app);
    const received = runs.find(({ workflow }) => workflow === "reader");
    await finished(received?.id ?? "");
    const { output } = await builder.api.workflows.status(received?.id ?? "");
    const { stored } = z.object({ stored: z.string() }).parse(output);
    const [day, id] = stored.split("/");
    const traversal = `${day}/../${app}/${id}`;
    const { id: run } = await builder.api.workflows.start(app, "probe", {
      reads: [
        { stored, index: 5 },
        { stored: traversal, index: 0 },
        { stored, index: 0 },
      ],
    });
    await finished(run);

    await expect(builder.api.workflows.status(run)).resolves.toMatchObject({
      status: "completed",
      output: ["workflow.attachment_not_found", "workflow.invalid", "read"],
    });
    const audited = await readsBy(run);
    const reads = audited.map(({ detail }) => detail);
    expect(reads).toHaveLength(3);
    expect(reads).toStrictEqual(
      expect.arrayContaining([
        {
          app,
          workflow: "probe",
          version: 1,
          step: "probe",
          message: stored,
          attachment: 0,
          bytes: 5,
        },
        {
          app,
          workflow: "probe",
          version: 1,
          step: "probe",
          message: traversal,
          attachment: 0,
          errorCode: "workflow.invalid",
        },
        {
          app,
          workflow: "probe",
          version: 1,
          step: "probe",
          message: stored,
          attachment: 5,
          errorCode: "workflow.attachment_not_found",
        },
      ])
    );
  });
});
