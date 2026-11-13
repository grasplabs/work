import type { FunctionResult } from "@grasp-os/shared/functions";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor } from "../src/apps.ts";
import { installShippedSkills } from "../src/brain-skills.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// The Brain's skills for code (GRA-1830; the threat model is on the
// issue): an App's action (`ctx.brain.skills.select` / `.read`) and a
// workflow's step (`ctx.brain.<alias>.skills.select` / `.read`) select and
// read the skills a chat's code does (`env.skills`), through the
// grant to read the Brain recall uses. How it can fail, and what each
// test holds it to:
// 1. The surfaces drift apart: an App, a workflow and a chat get the same
//    skills for the same person and task, and the same text at a version.
// 2. Code without the grant reads skills: an App no admin bound, or one
//    whose grant was revoked, gets nothing; a run whose binding wasn't
//    approved never calls.
// 3. Untrusted input reaches the Brain, or a refusal or the audit log
//    carries the task or a skill's text: each is refused in the host's
//    fixed words, and the audit event says who, for whom and how many or
//    which version, never what.
// The leak harness (brain-next-leaks.test.ts) probes the same calls with
// marked sources, every way they answer, for someone who isn't a member
// too.

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 90_000 };

type Member = Awaited<ReturnType<typeof person>>;

/** A task the release's draw-a-workflow skill is for. */
const task = "Draw how invoices are paid as a workflow";

const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** A permission `by` asks for and `admin` grants, for App `version` if any. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest,
  version: number | null = null
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version });
  return asked.id;
};

/** The Brain's grant for `subject`, as an admin gives it. */
const brainGrant = (
  subject: PermissionRequest["subject"]
): PermissionRequest => ({
  subject,
  object: { type: "platform" },
  actions: ["brain"],
  binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
});

// An App.

/**
 * An App whose action selects the skills for a task and reads the first
 * (`howTo`), and one that hands either operation what it is given, as
 * JSON (`ask`).
 */
const skillsApp = () =>
  testApp(
    {
      name: "How to",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
      permissions: [
        'permission.brain({ operations: ["skills.select", "skills.read"] })',
      ],
    },
    {
      "server/skills.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const howTo = action({
  args: { task: v.string() },
  handler: async (ctx, args) => {
    const { skills } = await ctx.brain.skills.select({ task: args.task });
    const [first] = skills;
    return {
      skills,
      read: first === undefined ? null : await ctx.brain.skills.read({ skill: first }),
    };
  },
});

export const ask = action({
  args: { operation: v.string(), input: v.string() },
  handler: async (ctx, args) =>
    args.operation === "select"
      ? await ctx.brain.skills.select(JSON.parse(args.input))
      : await ctx.brain.skills.read(JSON.parse(args.input)),
});
`,
    }
  );

/** The App, sealed and current, of `owner`'s. */
const appOf = async (owner: Member) => {
  const fixture: Fixture = await appWith(skillsApp(), "How to", owner);
  const release: Release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** The App, its declaration bound by `admin` to a grant of its own. */
const boundAppOf = async (owner: Member, admin: Member) => {
  const app = await appOf(owner);
  const permissionId = await granted(
    owner,
    admin,
    brainGrant({ type: "app", appId: app.app }),
    app.release.manifest.resourceVersion
  );
  await approveResourceBinding(env, admin, {
    app: app.app,
    alias: "brain",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  return { ...app, permissionId };
};

/** What function `name` of `app` answers `by`: its value, or its error's code. */
const calledOf = async (
  app: Awaited<ReturnType<typeof appOf>>,
  by: Member,
  name: string,
  args: Record<string, string>
): Promise<unknown> => {
  const fn = app.release.app.functions[name];
  if (fn === undefined) {
    throw new Error(`No ${name}`);
  }
  const { result }: { result: FunctionResult } = await callAppFunction(
    env,
    by,
    app.app,
    JSON.stringify({ reference: { name, kind: fn.kind }, args })
  );
  return result.ok ? result.value : { failed: result.error.code };
};

/** The `ask` function's arguments for a selection of `input`. */
const selecting = (input: unknown) => ({
  operation: "select",
  input: JSON.stringify(input),
});

/** The `ask` function's arguments for a read of `input`. */
const reading = (input: unknown) => ({
  operation: "read",
  input: JSON.stringify(input),
});

// A workflow.

/** A skill read whole, as a workflow declares what it returns. */
const skillDescriptor = {
  kind: "object",
  fields: {
    scope: { kind: "string" },
    name: { kind: "string" },
    version: { kind: "number" },
    text: { kind: "string" },
  },
};

/**
 * A workflow of `by`'s that selects the skills for its args' task and
 * returns the first, read, its `brain` permission bound by `admin` to a
 * grant of its own.
 */
const skillsWorkflow = async (by: Member, admin: Member) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const workflow = await createWorkflowResource(env, by, `skills-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: { kind: "object", fields: { task: { kind: "string" } } },
      returns: skillDescriptor,
      result: { $expr: "howTo" },
      permissions: { brain: { docs: { contract: key } } },
      steps: [
        {
          id: "chosen",
          type: "call",
          brain: "docs",
          action: "skills.select",
          args: { task: { $expr: "args.task" } },
        },
        {
          id: "howTo",
          type: "call",
          brain: "docs",
          action: "skills.read",
          args: { skill: { $expr: "chosen.skills[0]" } },
        },
      ],
    }),
    basedOn: null,
  });
  const permissionId = await granted(
    by,
    admin,
    brainGrant({ type: "workflow", workflowId: workflow.id })
  );
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  return workflow;
};

/** How a run of `id` for `by` on `args` ended: its result, or its code. */
const ranOf = async (
  by: Member,
  id: string,
  args: { task: string }
): Promise<unknown> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, args, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed" ? run.result : { failed: run.error?.code };
};

// A chat.

/** Code that selects the skills for `asked` and reads the first. */
const chatCode = (asked: string) =>
  codeStep(
    `export default async (self, env) => { const { skills } = await env.skills.select({ task: ${JSON.stringify(asked)} }); return { skills, read: skills[0] === undefined ? null : await env.skills.read({ skill: skills[0] }) }; };`
  );

/** What a chat's code returned, its last step's. */
const returnedOf = (text: string | undefined): unknown =>
  JSON.parse((text ?? "").replace(/^Returned:\n/u, ""));

const answerSchema = z.object({
  skills: z.array(z.object({ name: z.string(), version: z.number() })),
  read: z.object({ name: z.string(), text: z.string() }).nullable(),
});

/** The audit events of `onBehalfOf` for the Brain's skills, once `count` are kept. */
const skillEvents = async (onBehalfOf: string, count: number) =>
  await vi.waitFor(
    async () => {
      const all = await allEvents();
      const events = all.filter(
        ({ action, detail }) =>
          action.startsWith("brain.skills.") &&
          detail?.onBehalfOf === onBehalfOf
      );
      expect(events.length).toBeGreaterThanOrEqual(count);
      return events;
    },
    { timeout: 10_000, interval: 50 }
  );

describe("skills, as an App and a workflow reach them", setUpTime, () => {
  // Each file starts with empty storage: the release's skills, as its
  // install puts them in.
  beforeAll(async () => {
    await installShippedSkills(env);
  });

  it("selects and reads, from an App's action and a workflow's step, the skills a chat's code does for the same person, and records each without the task or a text", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const app = await boundAppOf(ada, admin);
    const workflow = await skillsWorkflow(ada, admin);
    const { stub, chat, ask } = await chatOf(
      ada.userId,
      chatCode(task),
      says("Done.")
    );
    await ask("How do I draw it?");
    const [fromCode] = await codeResults(stub, chat.id);
    const returned = returnedOf(fromCode?.text);
    const inChat = answerSchema.parse(returned);

    const fromApp = await calledOf(app, ada, "skills.howTo", { task });
    const fromRun = await ranOf(ada, workflow.id, { task });
    expect({
      chose: inChat.skills.map(({ name }) => name).slice(0, 1),
      read: inChat.read?.text.length !== 0,
      app: fromApp,
      run: fromRun,
    }).toStrictEqual({
      // Grasp's own skill for the task, read whole at the version chosen.
      chose: ["draw-a-workflow"],
      read: true,
      app: returned,
      run: z.object({ read: z.unknown() }).parse(returned).read,
    });
    // An App's and a run's selection and read, each audited for her, by
    // count or version, never the task or a skill's name or text.
    const events = await skillEvents(ada.userId, 4);
    expect({
      actions: events.map(({ action }) => action).toSorted(),
      said: [task, "draw-a-workflow", inChat.read?.text ?? ""].some((said) =>
        JSON.stringify(events).includes(said)
      ),
    }).toStrictEqual({
      actions: [
        "brain.skills.read",
        "brain.skills.read",
        "brain.skills.select",
        "brain.skills.select",
      ],
      said: false,
    });
  });

  it("reads nothing without the grant to read the Brain, stops at the next call once it is revoked, and refuses what isn't a task or a skill in the host's words", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // An App whose declaration no admin bound.
    const unbound = await appOf(ada);
    // An App bound, then its grant revoked.
    const revoked = await boundAppOf(ada, admin);
    const bound = await boundAppOf(ada, admin);
    const before = await calledOf(
      revoked,
      ada,
      "skills.ask",
      selecting({ task })
    );
    await revokePermission(env, admin, revoked.permissionId);
    const tooLong = "invoice ".repeat(251);
    expect({
      before: z.object({ skills: z.array(z.unknown()) }).safeParse(before)
        .success,
      unbound: await calledOf(unbound, ada, "skills.ask", selecting({ task })),
      revoked: await calledOf(revoked, ada, "skills.ask", selecting({ task })),
      empty: await calledOf(bound, ada, "skills.ask", selecting({ task: " " })),
      tooLong: await calledOf(
        bound,
        ada,
        "skills.ask",
        selecting({ task: tooLong })
      ),
      unversioned: await calledOf(
        bound,
        ada,
        "skills.ask",
        reading({ skill: { scope: "grasp", name: "draw-a-workflow" } })
      ),
      unknown: await calledOf(
        bound,
        ada,
        "skills.ask",
        reading({ skill: { scope: "company", name: "unwritten", version: 1 } })
      ),
      unshipped: await calledOf(
        bound,
        ada,
        "skills.ask",
        reading({ skill: { scope: "grasp", name: "unwritten", version: 1 } })
      ),
    }).toStrictEqual({
      before: true,
      unbound: { failed: "permission.unavailable" },
      revoked: { failed: "permission.unavailable" },
      empty: { failed: "permission.invalid_args" },
      tooLong: { failed: "permission.invalid_args" },
      unversioned: { failed: "permission.invalid_args" },
      unknown: { failed: "permission.item_not_found" },
      unshipped: { failed: "permission.item_not_found" },
    });
    // Each refusal that reached the check audited as refused, by its code.
    const events = await skillEvents(ada.userId, 6);
    expect(
      events
        .flatMap(({ detail }) =>
          typeof detail?.refused === "string" ? [detail.refused] : []
        )
        .toSorted()
    ).toStrictEqual([
      "permission.invalid_args",
      "permission.invalid_args",
      "permission.invalid_args",
      "permission.item_not_found",
      "permission.item_not_found",
    ]);
  });
});
