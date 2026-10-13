import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { sandboxVerdictOf } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import {
  declaredParams,
  dryRunTests,
  workflowTestFailures,
} from "../../src/workflows/code.ts";

// A workflow's metadata, tests and dry runs on-prem: core's real reads
// (workflows/code.ts), each in a sandbox session owned by the App, with
// `SANDBOX_HOST` bound to the sandbox supervisor this project starts. Its
// two processes give each owner one session at a time.

const notes = workflowIdSchema.parse("notes");

/** A workflow that echoes its `note`, and spins on `spin`; and its tests. */
const notesFiles = (testParams: string): Record<string, string> => ({
  "workflows/notes.ts": `import { text, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "notes",
  { input: z.unknown(), params: { note: text({ label: "Note", default: "none" }) } },
  async (step, { params }) =>
    await step.do("echo", { description: "Echo the note" }, async () => {
      if (params.note === "spin") {
        for (;;) {}
      }
      return params.note;
    })
);
`,
  "workflows/notes.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./notes.ts";

export default workflowTests(definition, [{ name: "echoes", ${testParams} expect: { output: "none" } }]);
`,
});

const calm = notesFiles("");
/** Its test's dry run spins: its test sets `note` to `spin`. */
const spinning = notesFiles('params: { note: "spin" },');

/**
 * A refusal as its kind, and the sandbox's word for it: `busy`, the App at
 * its share, never a pool too full to take anyone.
 */
const refusal = (reason: unknown) => ({
  unavailable: reason instanceof SandboxUnavailableError,
  verdict: reason instanceof Error ? sandboxVerdictOf(reason.cause) : undefined,
});

/** A new App's ID, so nothing one test read is kept for another. */
const newApp = () => appIdSchema.parse(`app-${crypto.randomUUID()}`);

describe("a workflow's code read on-prem", () => {
  it("reads its parameters, runs its tests and dry-runs them with the values given", async () => {
    const app = newApp();
    await expect(
      declaredParams(env, app, 1, notes, calm)
    ).resolves.toMatchObject([{ name: "note" }]);
    await expect(
      workflowTestFailures(env, app, 1, calm)
    ).resolves.toStrictEqual([]);
    const [run] = await dryRunTests(env, app, 1, notes, calm, {
      note: "from the dry run",
    });
    expect(run).toMatchObject({ name: "echoes", status: "completed" });
    expect(run?.report).toContain("from the dry run");
  }, 60_000);

  it("holds each App to its own place: a held App's reads are busy, to try again, while another's go on", async () => {
    const held = newApp();
    const other = newApp();
    // Built, and version 1's parameters kept, before the App's place is held.
    await expect(
      declaredParams(env, held, 1, notes, spinning)
    ).resolves.toHaveLength(1);
    const giveUp = new AbortController();
    const spin = dryRunTests(
      env,
      held,
      1,
      notes,
      spinning,
      {},
      {
        draft: true,
        signal: giveUp.signal,
      }
    ).then(
      () => "answered",
      () => "given up"
    );
    // Until the spin holds the App's place: each read waits for it, then
    // hears it's busy.
    // A version not read yet each time, as what a read finds is kept.
    const busy = async (version: number): Promise<unknown> => {
      const [tests, params] = await Promise.allSettled([
        workflowTestFailures(env, held, version, calm),
        declaredParams(env, held, version, notes, calm),
      ]);
      return tests.status === "rejected" && params.status === "rejected"
        ? [refusal(tests.reason), refusal(params.reason)]
        : undefined;
    };
    let refusals = await busy(2);
    for (let tries = 1; refusals === undefined && tries < 5; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- until the spin starts
      refusals = await busy(2 + tries);
    }
    expect(refusals).toStrictEqual([
      { unavailable: true, verdict: "busy" },
      { unavailable: true, verdict: "busy" },
    ]);
    // What it read before is kept, and needs no session; another App's
    // reads don't wait on it.
    const [kept, others] = await Promise.all([
      declaredParams(env, held, 1, notes, spinning),
      workflowTestFailures(env, other, 1, calm),
    ]);
    expect([kept.length, others]).toStrictEqual([1, []]);
    // Given up, the spin frees the App's place at once, not after its CPU time.
    const started = Date.now();
    giveUp.abort();
    expect([
      await spin,
      await workflowTestFailures(env, held, 2, calm),
    ]).toStrictEqual(["given up", []]);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 90_000);

  it("takes a test that spins as the code's failure, on its CPU time", async () => {
    const failures = await workflowTestFailures(env, newApp(), 1, spinning);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("CPU time");
  }, 90_000);
});
