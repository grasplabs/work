import { chatIdSchema } from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { chatOf, openTestRun, transcript } from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { published, release, requestGranted } from "./apps.ts";
import type { Idp } from "./idp.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// The chat, the App and the ways the build jobs tests (build-job-*.test.ts)
// hold or slow a job's step, and read what became of it. Each file calls
// `buildJobsOf(mockIdp())` once, for its people.

export const appName = "Invoice desk";

/** A screen the lint lets through. */
export const desk = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button variant="outline">Approve</Button>
    </main>
  );
}
`;

/** A workflow of the draft, with its tests: what a check keeps. */
export const intake = {
  "workflows/intake.ts": `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("intake", { params: {}, input: z.unknown() }, async (step, { input }) => {
  return await step.do("read", { description: "Read the invoice" }, async () => input as Json);
});
`,
  "workflows/intake.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./intake.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: { read: 1 }, expect: {} },
]);
`,
};

/** The screen with its button restyled, which @shadcn/lint refuses. */
export const restyled = desk.replace(
  '<Button variant="outline">',
  '<Button className="rounded-full">'
);

/** The code of the error a job's record holds, if any. */
export const errorCode = (error: string | null): string | null =>
  error === null
    ? null
    : z.object({ code: z.string() }).parse(JSON.parse(error)).code;

/** What a code step returned, as JSON. */
export const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Creates the App, writes a draft that passes, and submits its proposal. */
export const submitProposal = `export default async (self, env) => {
  const app = await env.build.create({ name: ${JSON.stringify(appName)} });
  await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": desk, ...intake })});
  return await env.build.submit(app.id, { kind: "propose", message: "An invoice desk" });
};`;

/**
 * Holds every call `held` picks to core's files (`env.FILES`) until
 * released: `reached` resolves once the first is held. The calls of a
 * job's step that it picks wait there, so a test acts while the job is
 * in that step. Set back with `restore`. The held call waits in its own
 * request, on flags, never on a promise of the test's request, which
 * workerd won't let another request wait on.
 */
export const holdFiles = (held: (method: string, key: unknown) => boolean) => {
  const { FILES: files } = env;
  const state = { reached: false, released: false };
  env.FILES = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === "string" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (held(property, args[0])) {
            state.reached = true;
            while (!state.released) {
              // oxlint-disable-next-line no-await-in-loop -- until the test releases it
              await scheduler.wait(20);
            }
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return value;
    },
  });
  return {
    reached: async () => {
      await vi.waitFor(
        () => {
          expect(state.reached).toBeTruthy();
        },
        { timeout: 60_000, interval: 20 }
      );
    },
    restore: () => {
      state.released = true;
      env.FILES = files;
    },
  };
};

/**
 * Makes every write of a check's test results to core's files take `ms`
 * longer: the files as they were, to set back.
 */
export const slowTestResults = (ms: number): typeof env.FILES => {
  const { FILES: files } = env;
  env.FILES = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "put" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (typeof args[0] === "string" && args[0].includes("tests")) {
            await scheduler.wait(ms);
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return files;
};

/** A Workspace object's own env, to change a binding of it in a test. */
export const envOf = (instance: object): Pick<Env, "CONNECT"> => {
  const objectEnv: unknown = Reflect.get(instance, "env");
  if (typeof objectEnv !== "object" || objectEnv === null) {
    throw new TypeError("The Workspace object has no env");
  }
  // SAFETY: a Workspace object's env is core's Env, which has CONNECT.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return objectEnv as Pick<Env, "CONNECT">;
};

/** A commit storing a version's files: no code run commits. */
export const storedTrees = (method: string, key: unknown): boolean =>
  method === "put" && typeof key === "string" && key.includes("/trees/");

/**
 * Writes the chat's draft of `app` from a run of its own, as the chat's
 * code would in another step: a new revision of the draft.
 */
export const writtenMeanwhile = async (
  stub: WorkspaceStub,
  chatId: string,
  app: string
): Promise<void> => {
  const id = chatIdSchema.parse(chatId);
  const draft = await stub.draft(id, app);
  const run = await openTestRun(stub, id);
  const saved = await stub.saveDraft(
    id,
    app,
    draft.base,
    { ...draft.changes, "screens/note.tsx": desk },
    [],
    draft.revision,
    run
  );
  expect(saved).toBeTruthy();
};

/**
 * A job's check, building the draft's screens: no code run builds them.
 * Held where it reads a kept build, or keeps the one it built.
 */
export const screenBuilds = (method: string, key: unknown): boolean =>
  (method === "get" || method === "put") &&
  typeof key === "string" &&
  key.startsWith("screen-builds/");

export const jobRowSchema = z.object({ id: z.string(), status: z.string() });

/** The chat's one build job, once its code submitted it. */
export const submittedJob = async (stub: WorkspaceStub, chatId: string) =>
  await vi.waitFor(
    async () => {
      const rows = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT id, status FROM chat_build_jobs WHERE chat_id = ?",
            chatId
          )
          .toArray()
      );
      expect(rows).toHaveLength(1);
      return jobRowSchema.parse(rows[0]);
    },
    { timeout: 30_000, interval: 50 }
  );

/** The chat's job `id` once it has ended, however it ended. */
export const endedJob = async (
  stub: WorkspaceStub,
  chatId: string,
  id: string
) =>
  await vi.waitFor(
    async () => {
      const job = await stub.buildJob(chatId, id);
      expect(job?.status).not.toBe("running");
      if (job === undefined) {
        throw new Error("The job is gone");
      }
      return job;
    },
    { timeout: 90_000, interval: 100 }
  );

/** How the chat's code runs ended, as their records say, and when. */
export const runRecords = async (stub: WorkspaceStub, chatId: string) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ status: string; ended_at: number | null }>(
        "SELECT status, ended_at FROM chat_code_runs WHERE chat_id = ? ORDER BY started_at",
        chatId
      )
      .toArray()
  );

/** The App the agent created, with its versions. */
export const createdApp = async (
  builder: Awaited<ReturnType<typeof signedInApi>>
) => {
  const apps = await builder.api.apps.list();
  const app = apps.find(({ name }) => name === appName);
  if (app === undefined) {
    throw new Error("The agent created no App");
  }
  return {
    app,
    versions: await builder.api.apps.versions.list(app.id),
  };
};

/** The system messages of the chat that name the job `id`. */
export const jobEvents = async (
  stub: WorkspaceStub,
  chatId: string,
  id: string
) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message, index) =>
    message.role === "system" && JSON.stringify(message.content).includes(id)
      ? [{ index, content: JSON.stringify(message.content) }]
      : []
  );
};

/** What a job's own code reads of it while it waits for the client's share. */
export const queuedForClient =
  /"status":\s*"queued",\s*"waitingFor":\s*"client"/u;

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/** The generation of the next policy a test sets: each higher than before. */
let generations = 500;

/** Sets the operator's policy to the deployment's, with `limits` lowered. */
export const policyWith = (limits: Record<string, number>): void => {
  generations += 1;
  env.QUOTA_LIMITS = {
    generation: generations,
    limits: { ...configuredLimits, ...limits },
  };
};

/** What the tests do as people of `idp`'s organization. */
export const buildJobsOf = (idp: Idp) => {
  /**
   * A builder's chat answered by `replies`, with an App released so the
   * Apps collection is there, and the agent allowed to build Apps.
   */
  const setUp = async (replies: ProviderReply[]) => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
    await published(existing);
    await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
    const chat = await chatOf(builder.userId, ...replies);
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read", "write"],
      binding: "APP_LIBRARY",
    });
    return { admin, builder, chat };
  };

  return { setUp };
};
