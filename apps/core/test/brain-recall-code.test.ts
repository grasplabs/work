import type { AuditEvent } from "@grasp-os/shared/audit";
import type { FunctionResult } from "@grasp-os/shared/functions";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { addMember } from "../src/app-members.ts";
import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor } from "../src/apps.ts";
import { addSource, eraseSource } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { recallFor } from "../src/brain-recall.ts";
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
import { failingAuditLog } from "./failing-audit-log.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// The one recall code reaches (GRA-1731; the threat model is on the
// issue): an App's action (`ctx.brain.recall`), a workflow's step
// (`ctx.brain.<alias>.recall`) and a chat's code (`env.brain.recall`)
// send the same request and get the same pack, from core's
// brain-recall.ts. How it can fail, and what each test holds it to:
// 1. Code without the grant to read the Brain recalls: a declaration, a
//    workflow's step or an agent with no active grant gets nothing, and a
//    revoked grant stops the next recall.
// 2. A recall reads past its person: two people asking the same App get
//    what each may read, never another's own or a team's they aren't in.
// 3. The three surfaces drift apart: the same request answers the same
//    pack in each.
// 4. Untrusted input reaches the Brain, or a refusal or the audit log
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

/** The Brain's grant for `subject`, as an admin gives it. */
const brainGrant = (
  subject: PermissionRequest["subject"]
): PermissionRequest => ({
  subject,
  object: { type: "platform" },
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
 * and a team's note neither is in: each holding `word`, which nothing
 * else does. Code reads none of a person's own: only their teams' notes.
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
  return { word, admin, ada, uma };
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
  it("answers the same pack to the same request in each, of what its person's teams may read and never their own", async () => {
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
    // The chat: its turn recalls for the question first, then runs the
    // code.
    const { stub, chat, ask, agent } = await chatOf(
      ada.userId,
      recallCode(request),
      says("Done.")
    );
    await granted(ada, admin, brainGrant(agent));
    await ask("What about leave?");
    const [, fromCode] = await codeResults(stub, chat.id);

    const fromApp = await askedOf(app, ada, {
      question: request.question,
      tokens: request.budget.tokens,
    });
    const fromRun = await ranOf(ada, workflow.id, {
      question: request.question,
      tokens: request.budget.tokens,
    });
    expect({
      app: textsOf(fromApp),
      sameInRun: fromRun,
      sameInChat: returnedOf(fromCode?.text),
    }).toStrictEqual({
      // Her team's note alone: never her own note, which only she may
      // read (GRA-1762), nor Uma's, nor the team's she isn't in.
      app: [`Ada's team: ${word} is planned in March.`],
      sameInRun: fromApp,
      sameInChat: fromApp,
    });
    // Each audited for her, with what it found counted, never said.
    const events = await recallEvents(ada.userId, 3);
    expect(JSON.stringify(events)).not.toContain(word);
  });

  it("reads as the person the call is for: the same App answers two people what each may read", async () => {
    const { word, admin, ada, uma } = await company();
    const app = await askOf(ada, [uma]);
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
    const asks = { question: word, tokens: 800 };
    expect({
      ada: textsOf(await askedOf(app, ada, asks)),
      uma: textsOf(await askedOf(app, uma, asks)),
    }).toStrictEqual({
      ada: [`Ada's team: ${word} is planned in March.`],
      uma: [`Uma's team: ${word} is planned in June.`],
    });
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
    const fromCode = results.slice(1).map(({ text }) => returnedOf(text));
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

  it("refuses what leaves a run once its person may no longer read what it recalled, and lets it through when nothing changed", async () => {
    const { admin, ada } = await company();
    const [left, kept] = await Promise.all([teamOf(ada), teamOf(ada)]);
    const words = [1, 2, 3, 4].map(
      (at) => `plan${at}${unique().replaceAll(/\W/gu, "")}`
    );
    const [leftWord = "", erasedWord = "", keptWord = "", narrowedWord = ""] =
      words;
    await added(`Route plan: ${leftWord} departs at noon.`, {
      kind: "team",
      teamId: left,
    });
    const erased = await added(`Route plan: ${erasedWord} departs at one.`, {
      kind: "team",
      teamId: kept,
    });
    const keptText = `Route plan: ${keptWord} departs at two.`;
    await added(keptText, { kind: "team", teamId: kept });
    const narrowed = await added(
      `Route plan: ${narrowedWord} departs at three.`,
      {
        kind: "team",
        teamId: kept,
      }
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
        expect(pinned).toStrictEqual([1, 1, 1, 1]);
      },
      { timeout: 10_000, interval: 50 }
    );
    // She leaves the first plan's team; the second plan is erased.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(left, ada.userId)
      .run();
    await eraseSource(env, { source: erased, reason: "deleted" });
    // The fourth is narrowed to her alone: she may still read it, but
    // what code reads is what her teams may.
    await addSource(env, {
      source: narrowed,
      change: crypto.randomUUID(),
      text: `Route plan: ${narrowedWord} departs at four.`,
      readers: { kind: "owner", personId: ada.userId },
    });
    const [afterLeaving, afterErasure, unchanged, afterNarrowing] =
      await Promise.all(
        runs.map(async (runId) => await endOf(ada, workflow.id, runId))
      );
    expect({
      afterLeaving,
      afterErasure,
      afterNarrowing,
      unchanged: textsOf(unchanged),
    }).toStrictEqual({
      afterLeaving: { failed: "brain.revoked" },
      afterErasure: { failed: "brain.revoked" },
      afterNarrowing: { failed: "brain.revoked" },
      unchanged: [keptText],
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
        await eraseSource(env, { source, reason: "deleted" });
      }),
      // Narrowed to her alone: hers to read, no longer her teams'.
      narrowed: await sentAfter(async (source, word) => {
        await addSource(env, {
          source,
          change: crypto.randomUUID(),
          text: `Route plan: ${word} departs at one.`,
          readers: { kind: "owner", personId: ada.userId },
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

// What an App recalls, it may keep: its data outlives the call. Sharing
// holds an App to what it may have read (app-provenance.ts): someone it
// is shared with must be able to read every source it read.

/** An App whose action keeps what it recalls in notes its members read. */
const keepApp = () =>
  testApp(
    {
      name: "Keep",
      tables: {
        notes: {
          fields: { text: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: ['permission.brain({ operations: ["recall"] })'],
    },
    {
      "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

export const save = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", args);
    return null;
  },
});

export const keep = action({
  args: { question: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const pack = await ctx.brain.recall({
      question: args.question,
      budget: { tokens: 800 },
    });
    for (const item of pack.items) {
      await ctx.runMutation(save, { text: item.text });
    }
    return pack.items.length;
  },
});

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map(({ text }) => text),
});
`,
    }
  );

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

describe("what an App recalls and keeps", setUpTime, () => {
  it("never reaches someone it is shared with who can't read where it came from", async () => {
    const { word, admin, ada, uma } = await company();
    // Ben is in none of the teams whose notes hold the word.
    const ben = await person("user");
    const fixture: Fixture = await appWith(keepApp(), "Keep", ada);
    const release: Release = await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
    const app = { ...fixture, release };
    const permissionId = await granted(
      ada,
      admin,
      brainGrant({ type: "app", appId: app.app }),
      release.manifest.resourceVersion
    );
    await approveResourceBinding(env, admin, {
      app: app.app,
      alias: "brain",
      target: { kind: "brain", permissionId },
      reviewed: { version: 1 },
    });
    // Shared with Uma and Ben, as the App's owner shares it.
    const shared = await Promise.all(
      [uma, ben].map(async (member) => {
        try {
          await addMember(env, ada, app.app, {
            type: "person",
            id: member.userId,
            role: "user",
          });
          return "shared";
        } catch (error) {
          return z.object({ code: z.string() }).parse(error).code;
        }
      })
    );
    // Uma recalls her team's note, and the App keeps it.
    const kept = await calledOf(app, uma, "notes.keep", { question: word });
    const seen = await calledOf(app, ben, "notes.list", {});
    // However the App is held to it (sharing refused, the call refused,
    // or the note withheld), Ben never reads her team's note.
    expect({
      shared,
      kept,
      benReadsUmasTeam: JSON.stringify(seen).includes(`Uma's team: ${word}`),
    }).toMatchObject({ benReadsUmasTeam: false });
  });
});
