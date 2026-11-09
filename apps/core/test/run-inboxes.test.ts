import { kitModuleName } from "@grasp-os/compiler";
import { v } from "@grasp-os/sdk";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  emailReplyContract,
  emailReplyData,
  emailReplyType,
  releaseContracts,
} from "../src/release-contracts.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { workflowPendingBindings } from "../src/workflow-binding-requests.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import {
  ensureReleaseContract,
  publishCatalogContract,
} from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks } from "../src/workflows/host.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import { loadedActivation, runOf } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { inboxAt } from "../src/workflows/run-inboxes.ts";
import {
  attemptHostMethods,
  loadSealedIsolate,
  sealedMainModule,
  sealedMainModules,
} from "../src/workflows/sealed-isolate.ts";
import {
  sealedRun,
  sealedRunFrom,
  sealedRunStart,
} from "../src/workflows/sealed-run.ts";
import type { SealedRunMemory } from "../src/workflows/sealed-run.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { engineOfTest } from "./run-host.ts";
import { admittedFreely, liveStatus, runObject } from "./runs.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { unique } from "./sign-in.ts";

// A run's inboxes (run-inboxes.ts), from their threat model: a reply
// address of the run's own for each event binding whose pinned contract
// takes replies to its mail (`ingress: "email"`), which the run's code
// reads as `inbox.<alias>`. The ways one can fail, each closed:
//
// - a token stored, so a database read hands out every run's inbox: only
//   its SHA-256 is kept, and the run's code gets it derived again;
// - an inbox a run never had: rows are written with the start that admits
//   the run, only for its frozen bindings whose contract takes replies;
// - a replay reading another address: every activation derives the same;
// - a test run's mail reaching anyone: it gets placeholders on `.invalid`;
// - a token outliving its run: it goes with the run's details, after
//   which nothing has it;
// - a builder taking a run's replies by naming an email trigger after a
//   reply address: that shape is refused;
// - a contract claiming replies in a shape core doesn't deliver, or for a
//   page's type too: refused as it is published.
//
// Each run here is a real start of a real published workflow, its inbox
// read by a real isolate running a module of the test's own on the run
// host, as generated code reads its context.

const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** A value's schema: an object of exactly `fields`, each required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

const completed = "grasp.job.completed";

/** An event wait `id` for `type` through `binding`, five minutes at most. */
const listen = (id: string, type: string, binding: string) => ({
  id,
  type: "waitForEvent",
  events: binding,
  eventType: type,
  timeout: "5 minutes",
});

/** The deployment's hostname, which reply addresses are on. */
const clientHost = new URL(clientOrigin).hostname;

/** A reply address as a run's code gets it. */
const replyAddress = (): RegExp =>
  new RegExp(
    `^reply-([0-9a-f]{32})@${clientHost.replaceAll(".", "\\.")}$`,
    "u"
  );

/**
 * A workflow that waits out its hour and then waits for a reply to its
 * mail through `replies` (the release's reply contract) and for a job's
 * completion through `jobs` (a contract of the admin's that takes nothing
 * from outside), each approved.
 */
const inboxWorkflow = async () => {
  const admin = await person("admin");
  for (const contract of releaseContracts) {
    if (contract.key === emailReplyContract) {
      // oxlint-disable-next-line no-await-in-loop -- one
      await ensureReleaseContract(env, contract, { builtin: "release" });
    }
  }
  const jobs = `job-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: jobs,
    kind: "event",
    events: {
      [completed]: {
        data: JSON.stringify(v.object({ note: v.string() }).descriptor),
        browser: false,
      },
    },
  });
  const workflow = await createWorkflowResource(
    env,
    admin,
    `inboxes-${unique()}`
  );
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectSchema({}),
      returns: objectSchema({}),
      result: {},
      permissions: {
        events: {
          replies: { contract: emailReplyContract },
          jobs: { contract: jobs },
        },
      },
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        listen("await-reply", emailReplyType, "replies"),
        listen("awaitJob", completed, "jobs"),
      ],
    }),
    basedOn: null,
  });
  const pending = await workflowPendingBindings(env, admin, workflow.id);
  for (const alias of ["replies", "jobs"]) {
    // oxlint-disable-next-line no-await-in-loop -- two approvals, in turn
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias,
      target: { kind: "event" },
      reviewed: { version: 1 },
    });
  }
  return { admin, workflow, pending };
};

type InboxWorkflow = Awaited<ReturnType<typeof inboxWorkflow>>;

/** A run of the workflow its admin started, once it waits out its hour. */
const waitingRun = async ({ admin, workflow }: InboxWorkflow) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: admin },
    workflow.id,
    { version: 1, input: {}, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

/** The rows of run `runId`'s inboxes, as stored. */
const rowsOf = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT * FROM run_inboxes WHERE run_id = ? ORDER BY binding"
  )
    .bind(runId)
    .all();
  return results;
};

const memoryOfTest = (): SealedRunMemory => ({
  sentCalls: {
    markSent: () => {},
    unmarkSent: () => {},
    sent: () => false,
    keepFailure: () => {},
    failureOf: () => {},
  },
  modelCalls: { count: () => 0, keep: () => {} },
});

const sdkWorkflow = JSON.stringify(kitModuleName("@grasp-os/sdk/workflow"));

/** A module of the test's own whose run answers the `inbox` it read. */
const readsInbox = `
import { workflow, v } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: v.object({}) }, async (step, { inbox }) => ({ ...inbox }));
`;

/** Run `runId` as the dispatcher loads it, served on the run host. */
const sealedRunOf = async (runId: string) => {
  const row = await runOf(env, runId);
  if (row === undefined) {
    throw new Error(`Run ${runId} has no row`);
  }
  const { run: activation } = await loadedActivation(
    env,
    {
      workflow: workflowResourceIdSchema.parse(row.workflowResourceId),
      version: row.version,
      manifest: row.manifestHash,
    },
    runId
  );
  return sealedRunFrom(activation);
};

/**
 * Runs `readsInbox` as an activation of run `runId` of its sealed build on
 * the run host, its calls going by `calling` if given: the inbox it read.
 */
const inboxRead = async (
  runId: string,
  calling?: (frozen: CallingRun) => CallingRun
): Promise<unknown> => {
  const loaded = await sealedRunOf(runId);
  const run =
    calling === undefined
      ? loaded
      : { ...loaded, calling: calling(loaded.calling) };
  const { step, leaseOf } = engineOfTest();
  const host = new RunHost(
    env,
    step,
    (controls) => sealedRun(env, run, memoryOfTest())(controls),
    {
      stepFailed: () => {
        // The run's end says what failed.
      },
      leaseOf: (key, attempt) => {
        const lease = leaseOf(key, attempt);
        return lease === undefined ? undefined : { ...lease, generation: 1000 };
      },
      tampered: () => {
        // Nothing here is tampering.
      },
      waiting: async () => {
        await Promise.resolve();
      },
      admitAttempt: admittedFreely satisfies NonNullable<
        HostHooks["admitAttempt"]
      >,
    }
  );
  const code = loadSealedIsolate(env, {
    owner: `test:${runId}`,
    mainModule: sealedMainModule,
    modules: async () =>
      await Promise.resolve({
        ...run.build.sdk,
        [generatedModule]: readsInbox,
        ...sealedMainModules({
          module: generatedModule,
          refusal: "No workflow.",
        }),
      }),
    attemptHostMethods,
  });
  const settled = z
    .object({ ok: z.literal(true), value: z.unknown() })
    .parse(await code.run(host, await sealedRunStart(env, run)));
  return settled.value;
};

/** The token in reply address `address`. */
const tokenIn = (address: unknown): string => {
  const token = replyAddress().exec(String(address))?.[1];
  if (token === undefined) {
    throw new Error(`Not a reply address: ${String(address)}`);
  }
  return token;
};

describe("a run's inboxes", { timeout: 120_000 }, () => {
  let sealed: InboxWorkflow;

  beforeAll(async () => {
    sealed = await inboxWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("gives a run a reply address for each event binding whose contract takes replies, keeping only its token's hash", async () => {
    const runId = await waitingRun(sealed);
    const inbox = z
      .record(z.string(), z.string())
      .parse(await inboxRead(runId));
    const token = tokenIn(inbox.replies);
    const rows = await rowsOf(runId);

    expect({
      aliases: Object.keys(inbox),
      address: replyAddress().test(inbox.replies ?? ""),
      rows: rows.map(({ binding, workflow_id: workflowId }) => ({
        binding,
        workflowId,
      })),
      hashed: rows[0]?.token_hash === (await sha256Hex(token)),
      tokenStored: JSON.stringify(rows).includes(token),
      found: await inboxAt(env, token),
    }).toStrictEqual({
      aliases: ["replies"],
      address: true,
      rows: [{ binding: "replies", workflowId: sealed.workflow.id }],
      hashed: true,
      tokenStored: false,
      found: {
        runId,
        workflowId: sealed.workflow.id,
        binding: "replies",
      },
    });
  });

  it("reads the same address on every activation, and another run another", async () => {
    const runId = await waitingRun(sealed);
    const otherRun = await waitingRun(sealed);
    const first = await inboxRead(runId);
    const replayed = await inboxRead(runId);
    const other = await inboxRead(otherRun);

    const repliesOf = (inbox: unknown) =>
      tokenIn(z.object({ replies: z.string() }).parse(inbox).replies);

    expect({
      replayed,
      otherDiffers: repliesOf(other) !== repliesOf(first),
    }).toStrictEqual({
      replayed: first,
      otherDiffers: true,
    });
  });

  it("neither hands out nor takes a run's address once core's key changed since the start", async () => {
    const runId = await waitingRun(sealed);
    const run = await sealedRunOf(runId);
    const rotated = await sealedRunStart(
      { ...env, BETTER_AUTH_SECRET: "another-auth-secret-of-32-chars-or-more" },
      run
    );

    const token = tokenIn(
      z.record(z.string(), z.string()).parse(await inboxRead(runId)).replies
    );

    expect({
      inbox: rotated.inbox,
      found: await inboxAt(
        {
          ...env,
          BETTER_AUTH_SECRET: "another-auth-secret-of-32-chars-or-more",
        },
        token
      ),
    }).toStrictEqual({ inbox: {}, found: undefined });
  });

  it("gives a test run of a draft a placeholder that reaches nobody", async () => {
    const runId = await waitingRun(sealed);
    const inbox = await inboxRead(runId, (frozen) => ({
      ...frozen,
      bindings: new Map(),
      candidate: new Map(
        [...frozen.bindings].map(([alias, binding]) => [
          alias,
          {
            kind: binding.kind,
            contractId: binding.contractId,
            fingerprint: binding.fingerprint,
            answer: undefined,
          },
        ])
      ),
    }));

    expect(inbox).toStrictEqual({
      replies: `reply-${"0".repeat(32)}@run-inbox.invalid`,
    });
  });

  it("is gone with the run's details", async () => {
    const runId = await waitingRun(sealed);
    const token = tokenIn(
      z.record(z.string(), z.string()).parse(await inboxRead(runId)).replies
    );
    await runObject(runId).terminate({ rollback: false });
    await vi.waitFor(
      async () => {
        const run = await runOf(env, runId);
        expect(run?.endedAt ?? null).not.toBeNull();
      },
      { timeout: 30_000, interval: 100 }
    );
    const ended = await inboxAt(env, token);
    const later = new Date(Date.now() + 400 * 86_400_000);
    await sweepWorkflowStartDetails(env, later, later);

    expect({
      ended: ended?.runId,
      rows: await rowsOf(runId),
      found: await inboxAt(env, token),
    }).toStrictEqual({ ended: runId, rows: [], found: undefined });
  });

  it("tells the admin approving a reply binding who can send it", () => {
    const offered = Object.fromEntries(
      (sealed.pending[0]?.bindings ?? []).map(({ alias, offered: each }) => [
        alias,
        each.map(({ label }) => label),
      ])
    );

    expect(offered).toStrictEqual({
      jobs: [""],
      replies: ["Replies to the run's mail, from anyone it reaches"],
    });
  });

  it("refuses an email trigger named like a run's reply address", async () => {
    const { admin, workflow } = sealed;

    await expect(
      createTriggerResource(env, admin, {
        kind: "email",
        workflowId: workflow.id,
        version: 1,
        config: { input: {}, address: `reply-${"a1".repeat(16)}` },
      })
    ).rejects.toMatchObject({ code: "workflow.email_taken" });
  });

  it("refuses a contract whose replies aren't the platform's, or that a page sends too", async () => {
    const { admin } = sealed;
    const refusal = async (events: Record<string, unknown>) => {
      try {
        await publishCatalogContract(env, admin, {
          key: `replies-${unique()}`,
          kind: "event",
          events,
        });
        return "published";
      } catch (error) {
        return z.object({ code: z.string() }).parse(error).code;
      }
    };
    const note = JSON.stringify(v.object({ note: v.string() }).descriptor);

    expect({
      otherData: await refusal({
        "acme.reply": { data: note, browser: false, ingress: "email" },
      }),
      pageToo: await refusal({
        "acme.reply": { data: emailReplyData, browser: true, ingress: "email" },
      }),
      twoFromOutside: await refusal({
        "acme.reply": {
          data: emailReplyData,
          browser: false,
          ingress: "email",
        },
        "acme.other": {
          data: emailReplyData,
          browser: false,
          ingress: "email",
        },
      }),
      platformReplies: await refusal({
        "acme.reply": {
          data: emailReplyData,
          browser: false,
          ingress: "email",
        },
      }),
    }).toStrictEqual({
      otherData: "workflow.contract_invalid",
      pageToo: "workflow.contract_invalid",
      twoFromOutside: "workflow.contract_invalid",
      platformReplies: "published",
    });
  });
});
