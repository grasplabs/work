import { brainOf } from "@grasp-os/brain-next/contract";
import { v } from "@grasp-os/runtime/app";
import { readDefinition } from "@grasp-os/runtime/definition";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { FunctionResult } from "@grasp-os/shared/functions";
import {
  appIdSchema,
  permissionIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appsReadableBy } from "../src/app-access.ts";
import { callAppFunction } from "../src/app-functions.ts";
import { addMember, listMembers, removeMember } from "../src/app-members.ts";
import { anyTeamGrant, mayReadBrainTeamsOf } from "../src/app-provenance.ts";
import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import { removeApp } from "../src/app-removal.ts";
import { resetAppData } from "../src/app-schema.ts";
import { updateApp } from "../src/app-settings.ts";
import { setArchived } from "../src/app-status.ts";
import { appFor } from "../src/apps.ts";
import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { teamsOf } from "../src/auth/identity.ts";
import {
  addSource,
  eraseSource,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { recallFor } from "../src/brain-recall.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { permissionsOpenTo } from "../src/permissions-open.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { failingAuditLog } from "./failing-audit-log.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";
import { webhookConfig } from "./source-config.ts";

// The one recall code reaches (GRA-1731, and GRA-1842 for an App's grant
// naming teams; the threat models are on the issues): an App's action (`ctx.brain.recall`), a workflow's step
// (`ctx.brain.<alias>.recall`) and a chat's code (`env.brain.recall`)
// send the same request and get the same pack, from core's
// brain-recall.ts. How it can fail, and what each test holds it to:
// 1. Code without the grant to read the Brain recalls: a declaration, a
//    workflow's step or an agent with no active grant gets nothing, and a
//    revoked grant stops the next recall.
// 2. What an App or a workflow recalls reaches someone who couldn't read
//    it at the source: it may end up in App data, a run's output, a
//    decision or an App a run writes to, which any member may read. So it
//    recalls only what everyone in the company may read, whoever calls:
//    never a team's note, never anyone's own. A chat's code recalls as its
//    person's teams, never their own: what it gets stays in their chat.
// 3. An App's grant names teams: its recall reads, of those, the teams
//    the person it acts for is in, and the App is shared with, and
//    answers, only people in all of them, so what it saved of a team's
//    text reaches nobody outside that team (but its owner and admins,
//    who manage it whatever it read). A rename breaks nothing; only an
//    App's grant names teams.
// 4. The surfaces drift apart: an App and a workflow answer the same
//    request the same pack.
// 5. Untrusted input reaches the Brain, or a refusal or the audit log
//    carries the question: each is refused in the same fixed words, and
//    the audit event says who, for whom and how many, never what.
// The leak harness (brain-next-leaks.test.ts) probes the same recall
// with marked sources, every way it answers.

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 90_000 };

type Member = Awaited<ReturnType<typeof person>>;

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

/**
 * The Brain's grant for `subject`, as an admin gives it, reaching `teams`
 * too when given.
 */
const brainGrant = (
  subject: PermissionRequest["subject"],
  teams?: string[]
): PermissionRequest => ({
  subject,
  object: { type: "platform", ...(teams === undefined ? {} : { teams }) },
  actions: ["brain"],
  binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
});

/** A source in the Brain that `readers` may read. */
const added = async (
  text: string,
  readers: SourceReaders
): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/**
 * A source everyone in the company may read, added to the shared store
 * as its producer would: core's producers add none yet, so code's recall
 * finds nothing else today.
 */
const forEveryone = async (text: string): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
    source: `upload:${source.id}`,
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group: "company" },
  });
  return source;
};

/** Runs core's hand-overs to the Brain now, as its clock would. */
const handOver = async (): Promise<void> => {
  await drainAuditOutboxes(env);
  await relayHandOvers(env);
  await workBrain(env, new Date(Date.now() + 60_000), producersOf(env));
};

/** A team of `members`, as core keeps one. */
const teamOf = async (...members: Member[]): Promise<string> => {
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Payroll', 'organization', ?)"
    ).bind(team, Date.now()),
    ...members.map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, member.userId, Date.now())
    ),
  ]);
  return team;
};

/**
 * Ada and Uma, each with a note of their own and one of a team of theirs,
 * a team's note neither is in, and a note for everyone: each holding
 * `word`, which nothing else does. An App's or a workflow's recall reads
 * the note for everyone alone; a chat's code its person's teams' notes.
 */
const company = async () => {
  const word = `leave${unique().replaceAll(/\W/gu, "")}`;
  const admin = await person("admin");
  const ada = await person("builder");
  const uma = await person("user");
  const [payroll, adas, umas] = await Promise.all([
    teamOf(admin),
    teamOf(ada),
    teamOf(uma),
  ]);
  await added(`Ada's own note: ask your lead about ${word}.`, {
    kind: "owner",
    personId: ada.userId,
  });
  await added(`Uma's own note: ${word} is booked for May.`, {
    kind: "owner",
    personId: uma.userId,
  });
  await added(`Ada's team: ${word} is planned in March.`, {
    kind: "team",
    teamId: adas,
  });
  await added(`Uma's team: ${word} is planned in June.`, {
    kind: "team",
    teamId: umas,
  });
  await added(`Payroll only: ${word} is paid at the usual rate.`, {
    kind: "team",
    teamId: payroll,
  });
  await forEveryone(`For everyone: ${word} is in the handbook.`);
  return { word, admin, ada, uma, teams: { payroll, adas, umas } };
};

/** The request every surface sends here. */
const requestOf = (word: string) => ({
  question: word,
  budget: { tokens: 800 },
});

const packTexts = z.object({ items: z.array(z.object({ text: z.string() })) });

/** The texts of a pack's items. */
const textsOf = (pack: unknown): string[] =>
  packTexts.parse(pack).items.map(({ text }) => text);

const refusal = z.object({ failed: z.unknown() });

// An App.

/** An App whose action recalls what its caller asks, as asked. */
const askApp = () =>
  testApp(
    {
      name: "Ask",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
      permissions: ['permission.brain({ operations: ["recall"] })'],
    },
    {
      "server/brain.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const ask = action({
  args: { question: v.string(), tokens: v.number(), asOf: v.string().optional() },
  handler: async (ctx, args) =>
    await ctx.brain.recall({
      question: args.question,
      budget: { tokens: args.tokens },
      ...(args.asOf === undefined ? {} : { asOf: args.asOf }),
    }),
});
`,
    }
  );

/** The Ask App, sealed and current; its users `users`. */
const askOf = async (owner: Member, users: Member[]) => {
  const fixture: Fixture = await appWith(askApp(), "Ask", owner);
  const release: Release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  for (const user of users) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(fixture.app, user.userId, owner.userId, Date.now())
      .run();
  }
  return { ...fixture, release };
};

/** What `brain.ask` of `app` answers `by`: its pack, or its error's code. */
const askedOf = async (
  app: Awaited<ReturnType<typeof askOf>>,
  by: Member,
  args: { question: string; tokens: number; asOf?: string }
): Promise<unknown> => {
  const fn = app.release.app.functions["brain.ask"];
  if (fn === undefined) {
    throw new Error("No brain.ask");
  }
  const { result }: { result: FunctionResult } = await callAppFunction(
    env,
    by,
    app.app,
    JSON.stringify({ reference: { name: "brain.ask", kind: fn.kind }, args })
  );
  return result.ok ? result.value : { failed: result.error.code };
};

// A workflow.

/** A pack, as a workflow declares what it returns. */
const packDescriptor = {
  kind: "object",
  fields: {
    items: {
      kind: "array",
      item: {
        kind: "object",
        fields: {
          source: {
            kind: "object",
            fields: { producer: { kind: "string" }, id: { kind: "string" } },
          },
          version: { kind: "number" },
          position: { kind: "number" },
          text: { kind: "string" },
          whole: { kind: "boolean" },
          found: { kind: "string" },
        },
      },
    },
    notFound: { kind: "array", item: { kind: "string" } },
    truncated: { kind: "boolean" },
  },
};

/**
 * A workflow of `by`'s that recalls its args' question within its args'
 * budget and returns the pack, its `brain` permission bound by `admin`
 * to a grant of its own; `grant: false` binds none.
 */
/** A step that waits a moment. */
const holdStep = { id: "hold", type: "wait", for: "3 seconds" };

const recallingWorkflow = async (
  by: Member,
  admin: Member,
  { hold }: { hold?: "before" | "after" } = {}
) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const workflow = await createWorkflowResource(env, by, `recall-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { question: { kind: "string" }, tokens: { kind: "number" } },
      },
      returns: packDescriptor,
      result: { $expr: "recalled" },
      permissions: { brain: { docs: { contract: key } } },
      steps: [
        // A pause before the recall or the run's output, for a test to act
        // in.
        ...(hold === "before" ? [holdStep] : []),
        {
          id: "recalled",
          type: "call",
          brain: "docs",
          action: "recall",
          args: {
            question: { $expr: "args.question" },
            budget: { tokens: { $expr: "args.tokens" } },
          },
        },
        ...(hold === "after" ? [holdStep] : []),
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
  return { workflow, permissionId };
};

/** A run of `id` for `by` on `args`, started: its ID. */
const startedRun = async (
  by: Member,
  id: string,
  args: { question: string; tokens: number }
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, args, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of `id` ended: its pack, or its code. */
const endOf = async (
  by: Member,
  id: string,
  runId: string
): Promise<unknown> => {
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

/** How a run of `id` for `by` on `args` ended: its pack, or its code. */
const ranOf = async (
  by: Member,
  id: string,
  args: { question: string; tokens: number }
): Promise<unknown> => {
  let runId: string;
  try {
    runId = await startedRun(by, id, args);
  } catch (error) {
    // Refused before any run: as a run that failed, by its code.
    return { failed: z.object({ code: z.string() }).parse(error).code };
  }
  return await endOf(by, id, runId);
};

// A chat.

/** Code that returns what `env.brain.recall(request)` answered, or its code. */
const recallCode = (request: unknown) =>
  codeStep(
    `export default async (self, env) => { try { return await env.brain.recall(${JSON.stringify(request)}); } catch (error) { return { failed: error.code ?? "no code", message: String(error.message) }; } };`
  );

/** What the chat's code returned, its last step's. */
const returnedOf = (text: string | undefined): unknown =>
  JSON.parse((text ?? "").replace(/^Returned:\n/u, ""));

/** The `brain.recall` audit events of `onBehalfOf`, once `count` are kept. */
const recallEvents = async (
  onBehalfOf: string,
  count: number
): Promise<AuditEvent[]> =>
  await vi.waitFor(
    async () => {
      const all = await allEvents();
      const events = all.filter(
        ({ action, detail }) =>
          action === "brain.recall" && detail?.onBehalfOf === onBehalfOf
      );
      expect(events.length).toBeGreaterThanOrEqual(count);
      return events;
    },
    { timeout: 10_000, interval: 50 }
  );

describe("recall, as an App, a workflow and a chat reach it", setUpTime, () => {
  it("answers an App and a workflow the same pack, of what everyone in the company may read, and a chat's code what its person's teams may", async () => {
    const { word, admin, ada } = await company();
    const request = requestOf(word);
    // The App.
    const app = await askOf(ada, []);
    const appGrant = await granted(
      ada,
      admin,
      brainGrant({ type: "app", appId: app.app }),
      app.release.manifest.resourceVersion
    );
    await approveResourceBinding(env, admin, {
      app: app.app,
      alias: "brain",
      target: { kind: "brain", permissionId: appGrant },
      reviewed: { version: 1 },
    });
    // The workflow.
    const { workflow } = await recallingWorkflow(ada, admin);
    // The chat: its code, the turn's own recall before the question
    // being no code run of it.
    const { stub, chat, ask, agent } = await chatOf(
      ada.userId,
      recallCode(request),
      says("Done.")
    );
    await granted(ada, admin, brainGrant(agent));
    await ask("What about leave?");
    const [fromCode] = await codeResults(stub, chat.id);

    const fromApp = await askedOf(app, ada, {
      question: request.question,
      tokens: request.budget.tokens,
    });
    const fromRun = await ranOf(ada, workflow.id, {
      question: request.question,
      tokens: request.budget.tokens,
    });
    // Her own search of the Brain, as the person.
    const own = await recallAs(env, ada.userId, {
      question: request.question,
      budget: request.budget,
      personal: true,
    });
    const forEveryoneNote = `For everyone: ${word} is in the handbook.`;
    const teamNote = `Ada's team: ${word} is planned in March.`;
    expect({
      app: textsOf(fromApp),
      sameInRun: fromRun,
      chat: textsOf(returnedOf(fromCode?.text)).toSorted(),
      own: own.items.map(({ text }) => text).toSorted(),
    }).toStrictEqual({
      // The note for everyone alone: never her team's, though she is in
      // it, nor her own note (GRA-1762), nor anyone else's.
      app: [forEveryoneNote],
      sameInRun: fromApp,
      // Her chat's code: her team's note and the note for everyone, never
      // her own.
      chat: [teamNote, forEveryoneNote].toSorted(),
      // Her own search: hers too, and never a team's she isn't in.
      own: [
        `Ada's own note: ask your lead about ${word}.`,
        teamNote,
        forEveryoneNote,
      ].toSorted(),
    });
    // Each audited for her, with what it found counted, never said.
    const events = await recallEvents(ada.userId, 3);
    expect(JSON.stringify(events)).not.toContain(word);
  });

  it("answers everyone an App is shared with the same pack of what the whole company may read, admins included", async () => {
    const { word, admin, ada, uma } = await company();
    const app = await askOf(ada, []);
    const permissionId = await granted(
      ada,
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
    // Shared with Uma as its owner shares any App.
    await addMember(env, ada, app.app, {
      type: "person",
      id: uma.userId,
      role: "user",
    });
    const asks = { question: word, tokens: 800 };
    const forEveryoneNote = [`For everyone: ${word} is in the handbook.`];
    expect({
      ada: textsOf(await askedOf(app, ada, asks)),
      uma: textsOf(await askedOf(app, uma, asks)),
      admin: textsOf(await askedOf(app, admin, asks)),
    }).toStrictEqual({
      ada: forEveryoneNote,
      uma: forEveryoneNote,
      admin: forEveryoneNote,
    });
  });

  it("answers a run nobody started by hand, which acts for the workflow's owner, only what the whole company may read", async () => {
    const { word, admin, ada } = await company();
    const { workflow } = await recallingWorkflow(ada, admin);
    const trigger = await createTriggerResource(env, ada, {
      kind: "webhook",
      workflowId: workflow.id,
      version: 1,
      config: await webhookConfig(),
    });
    await granted(ada, admin, {
      subject: {
        type: "trigger",
        triggerId: triggerIdSchema.parse(trigger.id),
      },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll(/\W/gu, "_")}`,
    });
    const { runId } = await startWorkflow(
      env,
      { type: "trigger", triggerId: trigger.id },
      workflow.id,
      { version: 1, args: { question: word, tokens: 800 }, key: unique() }
    );
    if (runId === null) {
      throw new Error("The start admitted no run");
    }
    expect(textsOf(await endOf(ada, workflow.id, runId))).toStrictEqual([
      `For everyone: ${word} is in the handbook.`,
    ]);
  });

  it("recalls nothing without the grant to read the Brain, and stops at the next call once it is revoked", async () => {
    const { word, admin, ada } = await company();
    const asks = { question: word, tokens: 800 };
    // An App whose declaration no admin bound.
    const unbound = await askOf(ada, []);
    // An App bound, then its grant revoked.
    const app = await askOf(ada, []);
    const permissionId = await granted(
      ada,
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
    const before = textsOf(await askedOf(app, ada, asks));
    await revokePermission(env, admin, permissionId);
    // A workflow whose grant is revoked after its binding was approved.
    const run = await recallingWorkflow(ada, admin);
    await revokePermission(env, admin, run.permissionId);
    // A chat whose agent holds no grant: no `env.brain` at all.
    const { stub, chat, ask } = await chatOf(
      ada.userId,
      recallCode(requestOf(word)),
      says("Done.")
    );
    await ask("What about leave?");
    const [fromCode] = await codeResults(stub, chat.id);
    expect({
      unbound: await askedOf(unbound, ada, asks),
      before: before.length,
      revoked: await askedOf(app, ada, asks),
      run: await ranOf(ada, run.workflow.id, asks),
      chat: fromCode?.text.includes("no API named env.brain"),
    }).toStrictEqual({
      unbound: { failed: "permission.unavailable" },
      before: 1,
      revoked: { failed: "permission.unavailable" },
      run: { failed: "workflow.binding_unapproved" },
      chat: true,
    });
  });

  it("refuses a request outside the Brain's limits alike in each, saying nothing of it", async () => {
    const { word, admin, ada } = await company();
    const app = await askOf(ada, []);
    const permissionId = await granted(
      ada,
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
    const { workflow } = await recallingWorkflow(ada, admin);
    const tooLong = `${word} `.repeat(2001).slice(0, 2001);
    const asked = [
      { question: word, budget: { tokens: 0 } },
      { question: word, budget: { tokens: 32_001 } },
      { question: tooLong, budget: { tokens: 800 } },
      { question: word, budget: { tokens: 800 }, asOf: `${word} at noon` },
      { question: word, budget: { tokens: 800 }, reader: ada.userId },
    ];
    const { stub, chat, ask, agent } = await chatOf(
      ada.userId,
      ...asked.map((request) => recallCode(request)),
      says("Done.")
    );
    await granted(ada, admin, brainGrant(agent));
    await ask("Go on.");
    const results = await codeResults(stub, chat.id);
    const fromCode = results.map(({ text }) => returnedOf(text));
    const refused = { failed: "permission.invalid_args" };
    expect({
      app: [
        await askedOf(app, ada, { question: word, tokens: 0 }),
        await askedOf(app, ada, { question: word, tokens: 32_001 }),
        await askedOf(app, ada, { question: tooLong, tokens: 800 }),
        await askedOf(app, ada, {
          question: word,
          tokens: 800,
          asOf: `${word} at noon`,
        }),
      ],
      run: await ranOf(ada, workflow.id, { question: word, tokens: 0 }),
      chat: fromCode.map((answer) => refusal.parse(answer).failed),
      said: JSON.stringify(fromCode).includes(word),
    }).toStrictEqual({
      app: [refused, refused, refused, refused],
      run: refused,
      chat: asked.map(() => refused.failed),
      said: false,
    });
  });

  it("refuses what leaves a run once the company may no longer read what it recalled, and lets it through when nothing changed", async () => {
    const { admin, ada } = await company();
    const elsewhere = await teamOf(admin);
    const words = [1, 2, 3].map(
      (at) => `plan${at}${unique().replaceAll(/\W/gu, "")}`
    );
    const [erasedWord = "", keptWord = "", narrowedWord = ""] = words;
    const erased = await forEveryone(
      `Route plan: ${erasedWord} departs at one.`
    );
    const keptText = `Route plan: ${keptWord} departs at two.`;
    await forEveryone(keptText);
    const narrowed = await forEveryone(
      `Route plan: ${narrowedWord} departs at three.`
    );
    const { workflow } = await recallingWorkflow(ada, admin, { hold: "after" });
    const runs = await Promise.all(
      words.map(
        async (question) =>
          await startedRun(ada, workflow.id, { question, tokens: 800 })
      )
    );
    // Each has recalled, and waits before its output.
    await vi.waitFor(
      async () => {
        const pinned = await Promise.all(
          runs.map(
            async (runId) =>
              await env.DB.prepare(
                "SELECT count(*) AS n FROM run_brain_versions WHERE run_id = ?"
              )
                .bind(runId)
                .first<number>("n")
          )
        );
        expect(pinned).toStrictEqual([1, 1, 1]);
      },
      { timeout: 10_000, interval: 50 }
    );
    // The first plan is erased (it was in the shared store, as any
    // source not one person's own is); the third narrowed to a team.
    await eraseSource(env, {
      source: erased,
      readers: { kind: "none" },
      reason: "deleted",
    });
    await addSource(env, {
      source: narrowed,
      change: crypto.randomUUID(),
      text: `Route plan: ${narrowedWord} departs at four.`,
      readers: { kind: "team", teamId: elsewhere },
    });
    const [afterErasure, unchanged, afterNarrowing] = await Promise.all(
      runs.map(async (runId) => await endOf(ada, workflow.id, runId))
    );
    expect({
      afterErasure,
      afterNarrowing,
      unchanged: textsOf(unchanged),
    }).toStrictEqual({
      afterErasure: { failed: "brain.revoked" },
      afterNarrowing: { failed: "brain.revoked" },
      unchanged: [keptText],
    });
  });

  it("withholds a finished run's result once the company may no longer read what it recalled, its status and times still shown", async () => {
    const { admin, ada } = await company();
    const elsewhere = await teamOf(admin);
    const words = [1, 2, 3].map(
      (at) => `band${at}${unique().replaceAll(/\W/gu, "")}`
    );
    const [narrowedWord = "", erasedWord = "", keptWord = ""] = words;
    const narrowed = await forEveryone(`Salary band: ${narrowedWord} is 90k.`);
    const erased = await forEveryone(`Salary band: ${erasedWord} is 70k.`);
    const keptText = `Salary band: ${keptWord} is 80k.`;
    await forEveryone(keptText);
    const { workflow } = await recallingWorkflow(ada, admin);
    const runs: string[] = [];
    for (const question of words) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const runId = await startedRun(ada, workflow.id, {
        question,
        tokens: 800,
      });
      // oxlint-disable-next-line no-await-in-loop -- each ends first
      await endOf(ada, workflow.id, runId);
      runs.push(runId);
    }
    // Once they ended: the first plan narrowed to a team, the second erased.
    await addSource(env, {
      source: narrowed,
      change: crypto.randomUUID(),
      text: `Salary band: ${narrowedWord} is 95k.`,
      readers: { kind: "team", teamId: elsewhere },
    });
    await eraseSource(env, {
      source: erased,
      readers: { kind: "none" },
      reason: "deleted",
    });
    /** What its person and an admin see of a run's record. */
    const recordOf = async (by: Member, runId: string) => {
      const run = await resourceRunFor(env, by, workflow.id, runId);
      return {
        status: run.status,
        ended: run.endedAt !== null,
        result: run.result === undefined ? null : textsOf(run.result),
        error: run.error?.code ?? null,
      };
    };
    const withheld = {
      status: "completed",
      ended: true,
      result: null,
      error: "brain.revoked",
    };
    expect({
      narrowed: await recordOf(ada, runs[0] ?? ""),
      erased: await recordOf(admin, runs[1] ?? ""),
      unchanged: await recordOf(ada, runs[2] ?? ""),
    }).toStrictEqual({
      narrowed: withheld,
      erased: withheld,
      unchanged: {
        status: "completed",
        ended: true,
        result: [keptText],
        error: null,
      },
    });
  });

  it("hands a run that recalled over to its person's Brain as how it ended alone, so no copy of what it recalled outlives a narrowing or an erasure", async () => {
    const { admin, ada } = await company();
    const elsewhere = await teamOf(admin);
    const [narrowedWord = "", erasedWord = ""] = [1, 2].map(
      (at) => `hand${at}${unique().replaceAll(/\W/gu, "")}`
    );
    const narrowed = await forEveryone(`Salary band: ${narrowedWord} is 90k.`);
    const erased = await forEveryone(`Salary band: ${erasedWord} is 70k.`);
    const { workflow } = await recallingWorkflow(ada, admin);
    for (const question of [narrowedWord, erasedWord]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const runId = await startedRun(ada, workflow.id, {
        question,
        tokens: 800,
      });
      // oxlint-disable-next-line no-await-in-loop -- each ends first
      await endOf(ada, workflow.id, runId);
    }
    /** What Ada's own recall finds of her runs, for `question`. */
    const ofRuns = async (question: string) => {
      const { items } = await recallAs(env, ada.userId, {
        question,
        budget: { tokens: 4000 },
        personal: true,
      });
      return items
        .filter(({ source }) => source.producer === "run")
        .map(({ text }) => text);
    };
    await handOver();
    const handed = await ofRuns("Workflow run completed");
    const before = [await ofRuns(narrowedWord), await ofRuns(erasedWord)];
    await addSource(env, {
      source: narrowed,
      change: crypto.randomUUID(),
      text: `Salary band: ${narrowedWord} is 95k.`,
      readers: { kind: "team", teamId: elsewhere },
    });
    await eraseSource(env, {
      source: erased,
      readers: { kind: "none" },
      reason: "deleted",
    });
    await handOver();
    expect({
      // Both runs were handed over, as how they ended.
      handed: handed.length >= 2,
      handedRecalled: handed.some((text) => text.includes("Salary band")),
      before,
      after: [await ofRuns(narrowedWord), await ofRuns(erasedWord)],
    }).toStrictEqual({
      handed: true,
      handedRecalled: false,
      before: [[], []],
      after: [[], []],
    });
  });

  it("withholds what a chat's code recalled from its later requests once its person's teams may no longer read it", async () => {
    const { admin, ada } = await company();
    const team = await teamOf(ada);
    /**
     * Whether a chat whose code recalled a plan of the team's still sends
     * it in its next turn, once `change` changed the plan's source. One
     * chat at a time: the model's replies are the latest chat's.
     */
    const sentAfter = async (
      change: (source: SourceRef, word: string) => Promise<void>
    ): Promise<boolean> => {
      const word = `route${unique().replaceAll(/\W/gu, "")}`;
      const text = `Route plan: ${word} departs at noon.`;
      const source = await added(text, { kind: "team", teamId: team });
      const { ask, agent, provider } = await chatOf(
        ada.userId,
        recallCode(requestOf(word)),
        says("Read it."),
        says("And now.")
      );
      await granted(ada, admin, brainGrant(agent));
      await ask(word);
      await change(source, word);
      const before = provider.requests.length;
      await ask("And now?");
      return JSON.stringify(provider.requests[before]?.body).includes(text);
    };
    expect({
      unchanged: await sentAfter(async () => {
        await Promise.resolve();
      }),
      erased: await sentAfter(async (source) => {
        await eraseSource(env, {
          source,
          readers: { kind: "team", teamId: team },
          reason: "deleted",
        });
      }),
      // Narrowed to a team she isn't in.
      narrowed: await sentAfter(async (source, word) => {
        await addSource(env, {
          source,
          change: crypto.randomUUID(),
          text: `Route plan: ${word} departs at one.`,
          readers: { kind: "team", teamId: await teamOf() },
        });
      }),
    }).toStrictEqual({ unchanged: true, erased: false, narrowed: false });
  });

  it("answers nothing when the audit log can't take the recall", async () => {
    const { word, admin, ada } = await company();
    const { agent, chat, id } = await chatOf(ada.userId);
    const permissionId = await granted(ada, admin, brainGrant(agent));
    // The failed append is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const answered = await recallFor(
      { ...env, AUDIT_LOG: failingAuditLog() },
      {
        authority: authoritySchema.parse({
          subject: agent,
          onBehalfOf: ada.userId,
          mode: "interactive",
        }),
        context: { type: "chat", workspaceId: id, chatId: chat.id },
        permissionId: permissionIdSchema.parse(permissionId),
        actor: { type: "system" },
      },
      requestOf(word)
    ).then(
      (pack) => ({ answered: pack.items.length }),
      () => "refused"
    );
    logged.mockRestore();
    expect(answered).toBe("refused");
  });

  it("gives a run that would keep more than 1,000 recalled versions no pack, refused and audited so", async () => {
    const { word, admin, ada } = await company();
    const { workflow } = await recallingWorkflow(ada, admin, {
      hold: "before",
    });
    const runId = await startedRun(ada, workflow.id, {
      question: word,
      tokens: 800,
    });
    // While it waits, it is made to hold as many as a run may keep.
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO run_brain_versions (run_id, producer, source_id, version, permission_id, recorded_at) SELECT ?, 'upload', 'kept-' || i, 1, 'kept', ? FROM n"
    )
      .bind(runId, Date.now())
      .run();
    const ended = await endOf(ada, workflow.id, runId);
    // Once the call's outcome is in the log, kept through the outbox.
    const ofRun = await vi.waitFor(
      async () => {
        const all = await allEvents();
        const kept = all.filter(({ target }) => target?.id === runId);
        expect(
          kept.some(({ detail }) => detail?.outcome === "brain.budget_exceeded")
        ).toBeTruthy();
        return kept;
      },
      { timeout: 10_000, interval: 50 }
    );
    expect({
      // The run fails: its kept versions are no one's to read (they name
      // nothing), so even its failure is held back as revoked.
      ended,
      // The recall's call was refused for the cap, and so was the recall:
      // never audited as answered.
      call: ofRun
        .filter(
          ({ action, detail }) =>
            action === "workflow.run.called" && detail?.call === "grasp.brain"
        )
        .map(({ detail }) => detail?.outcome),
      recall: ofRun
        .filter(({ action }) => action === "brain.recall")
        .map(({ detail }) => detail?.refused ?? "answered"),
    }).toStrictEqual({
      ended: { failed: "brain.revoked" },
      call: ["started", "brain.budget_exceeded"],
      recall: ["brain.budget_exceeded"],
    });
  });
});

// What code recalls, it passes on: into an App's data, a decision, a run's
// output. It holds only what everyone in the company may read, so whoever
// reads it there could read it at the source.

/** Bob's Notes: notes its members read and write, and no Brain. */
const notesApp = () =>
  testApp(
    {
      name: "Notes",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const create = mutation({
  args: { title: v.string() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});
`,
    }
  );

/** The stable ID App `app`'s current definition gives function `name`. */
const functionIdOf = async (app: string, name: string): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT definition FROM app_versions WHERE app_id = ? ORDER BY version DESC LIMIT 1"
  )
    .bind(app)
    .first<{ definition: string }>();
  const { functions = [] } = readDefinition(
    JSON.parse(row?.definition ?? "null")
  );
  const found = functions.find((fn) => fn.name === name);
  if (found === undefined) {
    throw new Error(`No function ${name}`);
  }
  return found.id;
};

/** What `name` of `app` answers `by`: its value, or its error's code. */
const calledOf = async (
  app: Fixture & { release: Release },
  by: Member,
  name: string,
  args: Record<string, unknown>
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

/** What a run's recall handed on: its items' texts, joined. */
const joinedTexts = "recalled.items.map((item) => item.text).join(' | ')";

/**
 * A workflow of `by`'s that recalls its args' question, its `brain`
 * permission bound by `admin` to a grant of its own, then does `then`
 * with what it recalled, under `permissions` beside its Brain's.
 */
const recallingThen = async (
  by: Member,
  admin: Member,
  then: { permissions: Record<string, unknown>; steps: unknown[] }
) => {
  const key = `brain-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "brain" });
  const workflow = await createWorkflowResource(env, by, `then-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { question: { kind: "string" }, tokens: { kind: "number" } },
      },
      permissions: {
        brain: { docs: { contract: key } },
        ...then.permissions,
      },
      steps: [
        {
          id: "recalled",
          type: "call",
          brain: "docs",
          action: "recall",
          args: {
            question: { $expr: "args.question" },
            budget: { tokens: { $expr: "args.tokens" } },
          },
        },
        ...then.steps,
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

describe("what code recalls, passed on", setUpTime, () => {
  it("reaches a shared App as what everyone in the company may read: never the team text of the person the run was for", async () => {
    const { word, admin, uma } = await company();
    const bob = await person("builder");
    const ben = await person("user");
    // Bob's Notes, with no Brain, shared with Uma and Ben.
    const fixture: Fixture = await appWith(notesApp(), "Notes", bob);
    const release: Release = await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
    const notes = { ...fixture, release };
    for (const member of [uma, ben]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await addMember(env, bob, notes.app, {
        type: "person",
        id: member.userId,
        role: "user",
      });
    }
    const create = await functionIdOf(notes.app, "notes.create");
    const workflow = await recallingThen(bob, admin, {
      permissions: {
        apps: {
          notes: { app: notes.app, functions: { [create]: "notes.create" } },
        },
      },
      steps: [
        {
          id: "made",
          type: "call",
          app: "notes",
          function: create,
          args: { title: { $expr: joinedTexts } },
        },
      ],
    });
    await granted(
      bob,
      admin,
      {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "app", appId: notes.app, function: create },
        actions: ["call"],
        binding: `NOTES_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
      },
      1
    );
    await shareWorkflowResource(env, bob, workflow.id, {
      type: "person",
      id: uma.userId,
      role: "user",
    });
    // A run for Uma, who is in her team: it recalls, then writes.
    const ran = await ranOf(uma, workflow.id, { question: word, tokens: 800 });
    expect({
      ran: z.object({ failed: z.unknown() }).safeParse(ran).success,
      benReads: await calledOf(notes, ben, "notes.titles", {}),
    }).toStrictEqual({
      ran: false,
      benReads: [`For everyone: ${word} is in the handbook.`],
    });
  });

  it("asks deciders about what everyone in the company may read, never the team text of the person the run was for", async () => {
    const { word, admin, uma } = await company();
    const bob = await person("builder");
    const reviewer = await person("user");
    const contract = `recalled-review-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "decision",
      input: JSON.stringify(v.object({ amount: v.number() }).descriptor),
      response: JSON.stringify(v.null().descriptor),
    });
    const workflow = await recallingThen(bob, admin, {
      permissions: { decisions: { review: { contract } } },
      steps: [
        {
          id: "asked",
          type: "decide",
          decision: "review",
          recipients: [`person:${reviewer.userId}`],
          prompt: { $expr: joinedTexts },
          input: { amount: 1 },
        },
      ],
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "review",
      target: { kind: "decision", deciders: [`person:${reviewer.userId}`] },
      reviewed: { version: 1 },
    });
    await shareWorkflowResource(env, bob, workflow.id, {
      type: "person",
      id: uma.userId,
      role: "user",
    });
    const runId = await startedRun(uma, workflow.id, {
      question: word,
      tokens: 800,
    });
    const asked = await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT description FROM workflow_decisions WHERE resource_run_id = ?"
        )
          .bind(runId)
          .first<{ description: string }>();
        if (row === null) {
          throw new Error("No decision yet");
        }
        return row.description;
      },
      { timeout: 20_000, interval: 100 }
    );
    expect(asked).toBe(`For everyone: ${word} is in the handbook.`);
  });
});

/**
 * Keep: an action that recalls its question and saves each item's text
 * as a note its members read, and a query of those notes.
 */
const keepApp = () =>
  testApp(
    {
      name: "Keep",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: ['permission.brain({ operations: ["recall"] })'],
    },
    {
      "server/keep.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

export const save = mutation({
  args: { title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", args);
    return null;
  },
});

export const keep = action({
  args: { question: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const pack = await ctx.brain.recall({ question: args.question, budget: { tokens: 800 } });
    for (const item of pack.items) {
      await ctx.runMutation(save, { title: item.text });
    }
    return pack.items.map((item) => item.text);
  },
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title).sort(),
});
`,
    }
  );

/**
 * `app`'s `brain` declaration bound by `admin` to a grant `owner` asked
 * for, reaching `teams`.
 */
const boundToTeams = async (
  app: Fixture & { release: Release },
  owner: Member,
  admin: Member,
  teams: string[]
): Promise<string> => {
  const permissionId = await granted(
    owner,
    admin,
    brainGrant({ type: "app", appId: app.app }, teams),
    app.release.manifest.resourceVersion
  );
  await approveResourceBinding(env, admin, {
    app: app.app,
    alias: "brain",
    target: { kind: "brain", permissionId },
    reviewed: { version: 1 },
  });
  return permissionId;
};

/** The Keep App of `owner`, sealed and current. */
const keepOf = async (owner: Member) => {
  const fixture: Fixture = await appWith(keepApp(), "Keep", owner);
  const release: Release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** How `run` ended: `done`, or its error's code and details. */
const outcomeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return "done";
  } catch (error) {
    const { code, details } = z
      .object({ code: z.string(), details: z.unknown().optional() })
      .parse(error);
    return { code, details };
  }
};

/**
 * A workflow of `by`'s that calls `name` (its stable ID `fn`) of App
 * `app` and returns its answer, its grant to call it asked for by `by`:
 * the request's outcome (`outcomeOf`) and the workflow.
 */
const callingWorkflow = async (
  by: Member,
  admin: Member,
  app: string,
  fn: string,
  name: string
) => {
  const workflow = await createWorkflowResource(env, by, `calls-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: { kind: "object", fields: { question: { kind: "string" } } },
      permissions: {
        apps: { keep: { app, functions: { [fn]: name } } },
      },
      steps: [
        { id: "read", type: "call", app: "keep", function: fn, args: {} },
      ],
    }),
    basedOn: null,
  });
  const asked = await outcomeOf(
    async () =>
      await granted(
        by,
        admin,
        {
          subject: { type: "workflow", workflowId: workflow.id },
          object: { type: "app", appId: app, function: fn },
          actions: ["call"],
          binding: `KEEP_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
        },
        1
      )
  );
  return { asked, workflow };
};

/** How a run of `id` for `by` ended: its value, or its code. */
const ranOfCalls = async (by: Member, id: string): Promise<unknown> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, args: { question: "any" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return await endOf(by, id, runId);
};

/**
 * Of `answer`, a list of texts, those that carry this test's own `word`,
 * sorted; anything else (a refusal) as it is. Recall also finds what other
 * tests added by meaning, which the reader may read: never this test's to
 * count.
 */
const carrying = (word: string, answer: unknown): unknown =>
  Array.isArray(answer)
    ? answer
        .filter(
          (text): text is string =>
            typeof text === "string" && text.includes(word)
        )
        .toSorted()
    : answer;

/** `member` as a request of theirs is signed in now: their teams now. */
const now = async (member: Member): Promise<Member> => ({
  ...member,
  teams: await teamsOf(env.DB, member.userId),
});

/** `member`, put in `team` as core keeps it. */
const joined = async (team: string, member: Member): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), team, member.userId, Date.now())
    .run();
};

describe("an App whose grant names teams", setUpTime, () => {
  it("recalls its grant's team for someone in it, beside the company's, never another team's nor anyone's own, and answers nobody outside the team, an admin included", async () => {
    const { word, admin, ada, teams } = await company();
    const app = await askOf(ada, []);
    // Ada's team: she is in it, the admin isn't.
    await boundToTeams(app, ada, admin, [teams.adas]);
    const asks = { question: word, tokens: 800 };
    expect({
      ada: carrying(word, textsOf(await askedOf(app, await now(ada), asks))),
      admin: await askedOf(app, await now(admin), asks),
    }).toStrictEqual({
      ada: [
        `Ada's team: ${word} is planned in March.`,
        `For everyone: ${word} is in the handbook.`,
      ],
      admin: { failed: "app.unreadable" },
    });
  });

  it("keeps what an action saved of a team's recall from everyone outside that team it is shared with, a rename of the team breaking nothing", async () => {
    const { word, admin, ada, uma, teams } = await company();
    const ben = await person("user");
    await joined(teams.adas, ben);
    const app = await keepOf(ada);
    // What carries this test's word: what else recall finds isn't its to count.
    const own = async (...args: Parameters<typeof calledOf>) =>
      carrying(word, await calledOf(...args));
    await boundToTeams(app, ada, admin, [teams.adas]);
    const share = async (member: Member) =>
      await addMember(env, await now(ada), app.app, {
        type: "person",
        id: member.userId,
        role: "user",
      });
    // Ben is in Ada's team: shared. Uma isn't: refused. Nor is an admin
    // outside it, alike; an admin in it is shared.
    const adminInTeam = await person("admin");
    await joined(teams.adas, adminInTeam);
    await share(ben);
    await share(adminInTeam);
    await expect(share(uma)).rejects.toMatchObject({
      code: "app.share_unreadable",
    });
    await expect(share(admin)).rejects.toMatchObject({
      code: "app.share_unreadable",
    });
    // The team renamed: nothing names it by its name.
    await env.DB.prepare("UPDATE teams SET name = 'Renamed' WHERE id = ?")
      .bind(teams.adas)
      .run();
    // Ben keeps what he recalls: his team's note, and the note for
    // everyone.
    const teamNote = `Ada's team: ${word} is planned in March.`;
    const kept = [
      teamNote,
      `For everyone: ${word} is in the handbook.`,
    ].toSorted();
    expect({
      saved: await own(app, await now(ben), "keep.keep", {
        question: word,
      }),
      benReads: await own(app, await now(ben), "keep.titles", {}),
    }).toStrictEqual({ saved: kept, benReads: kept });
    // Uma shared with anyway (a share that raced the grant): every call
    // refused, so she never reads the team's note Ben saved.
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(app.app, uma.userId, ada.userId, Date.now())
      .run();
    // Ben leaves the team: from his next call, he is refused too.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(teams.adas, ben.userId)
      .run();
    expect({
      umaReads: await own(app, await now(uma), "keep.titles", {}),
      umaKeeps: await own(app, await now(uma), "keep.keep", {
        question: word,
      }),
      benReads: await own(app, await now(ben), "keep.titles", {}),
      adaReads: await own(app, await now(ada), "keep.titles", {}),
    }).toStrictEqual({
      umaReads: { failed: "app.unreadable" },
      umaKeeps: { failed: "app.unreadable" },
      benReads: { failed: "app.unreadable" },
      adaReads: kept,
    });
    // Its owner leaves the team too: she no longer reads it either.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(teams.adas, ada.userId)
      .run();
    await expect(
      own(app, await now(ada), "keep.titles", {})
    ).resolves.toStrictEqual({ failed: "app.unreadable" });
  });

  it("closes what an App kept of a team's recall to its owner and an admin outside that team, who still revoke, reset, archive and remove it", async () => {
    const { word, admin, ada, teams } = await company();
    // Carl is in payroll, as the admin is; Ada, who owns Keep, isn't, nor
    // is a second admin.
    const carl = await person("builder");
    await joined(teams.payroll, carl);
    const outsideAdmin = await person("admin");
    const app = await keepOf(ada);
    // What carries this test's word: what else recall finds isn't its to count.
    const own = async (...args: Parameters<typeof calledOf>) =>
      carrying(word, await calledOf(...args));
    await addMember(env, await now(ada), app.app, {
      type: "person",
      id: carl.userId,
      role: "builder",
    });
    const grant = await boundToTeams(app, carl, admin, [teams.payroll]);
    const payrollNote = `Payroll only: ${word} is paid at the usual rate.`;
    const kept = [
      payrollNote,
      `For everyone: ${word} is in the handbook.`,
    ].toSorted();
    expect({
      saved: await own(app, await now(carl), "keep.keep", {
        question: word,
      }),
      carlReads: await own(app, await now(carl), "keep.titles", {}),
      adminReads: await own(app, await now(admin), "keep.titles", {}),
      adaReads: await own(app, await now(ada), "keep.titles", {}),
      adaKeeps: await own(app, await now(ada), "keep.keep", {
        question: word,
      }),
      outsideAdminReads: await calledOf(
        app,
        await now(outsideAdmin),
        "keep.titles",
        {}
      ),
      adaOpens: await outcomeOf(
        async () => await appFor(env, await now(ada), app.app, "user")
      ),
    }).toStrictEqual({
      saved: kept,
      carlReads: kept,
      adminReads: kept,
      adaReads: { failed: "app.unreadable" },
      adaKeeps: { failed: "app.unreadable" },
      outsideAdminReads: { failed: "app.unreadable" },
      adaOpens: { code: "app.unreadable", details: undefined },
    });
    // Managing it reads none of its data: still theirs.
    const name = await env.DB.prepare("SELECT name FROM apps WHERE id = ?")
      .bind(app.app)
      .first<{ name: string }>();
    // Whom it is shared with is theirs to see and take back; renaming it
    // stays closed, as every change of the App does.
    const sharedWith = await listMembers(env, await now(ada), app.app);
    const adminSees = await listMembers(env, await now(outsideAdmin), app.app);
    expect({
      sharedWith: sharedWith.map(({ id }) => id),
      adminSees: adminSees.map(({ id }) => id),
      renamed: await outcomeOf(
        async () =>
          await updateApp(env, await now(ada), app.app, { name: "Renamed" })
      ),
      unshared: await outcomeOf(async () => {
        await removeMember(env, await now(ada), app.app, {
          type: "person",
          id: carl.userId,
        });
      }),
      carlAfter: await own(app, await now(carl), "keep.titles", {}),
    }).toStrictEqual({
      sharedWith: [carl.userId],
      adminSees: [carl.userId],
      renamed: { code: "app.unreadable", details: undefined },
      unshared: "done",
      carlAfter: { failed: "app.not_found" },
    });
    const listed = await permissionsOpenTo(env, await now(outsideAdmin), {
      type: "app",
      appId: app.app,
    });
    expect({
      // The grant is listed to them, to decide, as any App's.
      listed: listed.some(({ id }) => id === grant),
      revoked: await outcomeOf(
        async () => await revokePermission(env, outsideAdmin, grant)
      ),
      reset: await outcomeOf(async () => {
        await resetAppData(env, await now(outsideAdmin), app.app, name?.name);
      }),
      archived: await outcomeOf(
        async () => await setArchived(env, await now(ada), app.app, true)
      ),
      removed: await outcomeOf(async () => {
        await removeApp(env, await now(ada), app.app);
      }),
    }).toStrictEqual({
      listed: true,
      revoked: "done",
      reset: "done",
      archived: "done",
      removed: "done",
    });
  });

  it("names in a grant only teams its requester is in now, refusing a team they aren't in, one that isn't there and another company's alike", async () => {
    const { admin, ada, teams } = await company();
    const app = await askOf(ada, []);
    // Another company's team, Ada among its members.
    const other = crypto.randomUUID();
    const otherTeam = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organizations (id, name, slug, created_at) VALUES (?, 'Other', ?, ?)"
      ).bind(other, other, Date.now()),
      env.DB.prepare(
        "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Theirs', ?, ?)"
      ).bind(otherTeam, other, Date.now()),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), otherTeam, ada.userId, Date.now()),
    ]);
    const asked = async (team: string) =>
      await outcomeOf(
        async () =>
          await requestPermission(
            env,
            ada,
            brainGrant({ type: "app", appId: app.app }, [teams.adas, team]),
            rolesOf(ada)
          )
      );
    const refused = {
      code: "permission.invalid",
      details: { issues: ["object: Name only teams you are in."] },
    };
    expect({
      notIn: await asked(teams.payroll),
      none: await asked(crypto.randomUUID()),
      otherCompany: await asked(otherTeam),
      own: await outcomeOf(
        async () =>
          await granted(
            ada,
            admin,
            brainGrant({ type: "app", appId: app.app }, [teams.adas]),
            1
          )
      ),
    }).toStrictEqual({
      notIn: refused,
      none: refused,
      otherCompany: refused,
      own: "done",
    });
  });

  it("is never called from a workflow: its grant to a workflow is refused, so is naming teams once a workflow may call it, and so is a call that got past both", async () => {
    const { admin, ada: asCreated, teams } = await company();
    const ada = await now(asCreated);
    const refused = {
      code: "permission.team_brain_workflow",
      details: undefined,
    };
    // A team's Keep: a workflow's grant to call it is refused.
    const scoped = await keepOf(ada);
    await boundToTeams(scoped, ada, admin, [teams.adas]);
    const titles = await functionIdOf(scoped.app, "keep.titles");
    const toScoped = await callingWorkflow(
      ada,
      admin,
      scoped.app,
      titles,
      "keep.titles"
    );
    // A Keep a workflow may call: naming a team for it is refused.
    const called = await keepOf(ada);
    const calledTitles = await functionIdOf(called.app, "keep.titles");
    const toCalled = await callingWorkflow(
      ada,
      admin,
      called.app,
      calledTitles,
      "keep.titles"
    );
    const naming = await outcomeOf(
      async () => await boundToTeams(called, ada, admin, [teams.adas])
    );
    // A team's grant written past both (as no request can): the run's call
    // is refused all the same.
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_by, granted_at, teams) VALUES (?, 'app', ?, 'platform', 'platform', '[\"brain\"]', 'TEAM_BRAIN', 'active', ?, ?, ?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        called.app,
        ada.userId,
        Date.now(),
        admin.userId,
        Date.now(),
        JSON.stringify([teams.adas])
      )
      .run();
    expect({
      grantToScoped: toScoped.asked,
      grantToCalled: toCalled.asked,
      naming,
      run: await ranOfCalls(await now(ada), toCalled.workflow.id),
    }).toStrictEqual({
      grantToScoped: refused,
      grantToCalled: "done",
      naming: refused,
      run: { failed: "permission.team_brain_workflow" },
    });
  });

  it("reads a stored teams value no request could make as the team nobody is in, every shape alike: listed so, closing its App, refusing its recall", async () => {
    const { word, admin, ada, teams } = await company();
    const app = await askOf(ada, []);
    const shapes: Record<string, string> = {
      empty: "[]",
      twice: JSON.stringify([teams.adas, teams.adas]),
      tooMany: JSON.stringify(
        Array.from({ length: 1000 }, (_, at) => `team-${at}`)
      ),
      notAnId: "[1]",
      nullInside: JSON.stringify([teams.adas, null]),
      notJson: "not json",
      aString: JSON.stringify(teams.adas),
      aNumber: "5",
      anObject: JSON.stringify({ teams: [teams.adas] }),
    };
    const insert = env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_by, granted_at, teams) VALUES (?, 'app', ?, 'platform', 'platform', '[\"brain\"]', ?, 'active', ?, 0, ?, 0, ?)"
    );
    const rows = Object.entries(shapes).map(([name, stored]) => ({
      name,
      stored,
      listedGrant: crypto.randomUUID(),
      // An App of its own, to hold the gate and recall to it alone.
      appId: appIdSchema.parse(`app-${crypto.randomUUID()}`),
      grant: crypto.randomUUID(),
    }));
    await env.DB.batch(
      rows.flatMap(({ name, stored, listedGrant, appId, grant }) => [
        insert.bind(
          listedGrant,
          app.app,
          `TEAMS_${name.toUpperCase()}`,
          ada.userId,
          admin.userId,
          stored
        ),
        insert.bind(grant, appId, "BRAIN", ada.userId, admin.userId, stored),
      ])
    );
    const listed = await permissionsOpenTo(env, await now(admin), {
      type: "app",
      appId: app.app,
    });
    const adaNow = await now(ada);
    const adaTeams = adaNow.teams.map(({ id }) => id);
    const outcomes: Record<string, unknown> = {};
    for (const { name, listedGrant, appId, grant } of rows) {
      // oxlint-disable-next-line no-await-in-loop -- one shape at a time
      const opens = await mayReadBrainTeamsOf(env, appId, adaTeams);
      // oxlint-disable-next-line no-await-in-loop -- one shape at a time
      const recalled = await outcomeOf(
        async () =>
          await recallFor(
            env,
            {
              authority: authoritySchema.parse({
                subject: { type: "app", appId },
                onBehalfOf: ada.userId,
                mode: "interactive",
                appVersion: 1,
              }),
              context: { type: "app", appId },
              permissionId: permissionIdSchema.parse(grant),
              actor: { type: "system" },
            },
            requestOf(word)
          )
      );
      outcomes[name] = {
        listedAs: listed.find(({ id }) => id === listedGrant)?.object,
        opens,
        recalled,
      };
    }
    const unreadable = {
      listedAs: { type: "platform", teams: ["*"] },
      opens: false,
      recalled: {
        code: "permission.denied",
        details: { action: "brain" },
      },
    };
    expect({ outcomes, counted: await anyTeamGrant(env) }).toStrictEqual({
      outcomes: Object.fromEntries(rows.map(({ name }) => [name, unreadable])),
      counted: true,
    });
  });

  it("closes only the App whose stored teams don't read as teams, never another's listing", async () => {
    const { ada } = await company();
    const [broken, fine] = await Promise.all([keepOf(ada), askOf(ada, [])]);
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_by, granted_at, teams) VALUES (?, 'app', ?, 'platform', 'platform', '[\"brain\"]', 'BROKEN', 'active', ?, ?, ?, ?, '\"not a list\"')"
    )
      .bind(
        crypto.randomUUID(),
        broken.app,
        ada.userId,
        Date.now(),
        ada.userId,
        Date.now()
      )
      .run();
    expect({
      readable: [
        ...(await appsReadableBy(env, await now(ada), [broken.app, fine.app])),
      ],
      brokenOpens: await outcomeOf(
        async () => await appFor(env, await now(ada), broken.app, "user")
      ),
    }).toStrictEqual({
      readable: [fine.app],
      brokenOpens: { code: "app.unreadable", details: undefined },
    });
  });

  it("names teams only on an App's permission to read the Brain", async () => {
    const { admin, ada, teams } = await company();
    const { workflow } = await recallingWorkflow(ada, admin);
    const app = await askOf(ada, []);
    const asked = async (request: PermissionRequest) =>
      await requestPermission(env, ada, request, rolesOf(ada));
    await expect(
      asked(
        brainGrant({ type: "workflow", workflowId: workflow.id }, [teams.adas])
      )
    ).rejects.toMatchObject({ code: "permission.invalid" });
    await expect(
      asked({
        ...brainGrant({ type: "app", appId: app.app }, [teams.adas]),
        actions: ["statistics"],
      })
    ).rejects.toMatchObject({ code: "permission.invalid" });
    await expect(
      asked(
        brainGrant({ type: "app", appId: app.app }, [teams.adas, teams.adas])
      )
    ).rejects.toMatchObject({ code: "permission.invalid" });
  });
});
