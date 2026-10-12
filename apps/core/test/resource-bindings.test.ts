import type { AuditEvent } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import { appResourceBindings } from "../src/db/core/schema.ts";
import {
  approveResourceBinding,
  listResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// operation host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only AI Gateway behind
// the AI binding faked.

/** The model the tests' deployment allows. */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** An App whose actions use a text model and a structured one. */
const modelFiles = (maxOutputTokens = 300): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string() }),
});
`,
  "operations/assist.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const writer = resource.model("writer", { maxOutputTokens: ${maxOutputTokens} });

export const tagger = resource.model("tagger", {
  structuredOutput: v.object({ tags: v.array(v.string().trim().min(1)).max(5) }),
  maxOutputTokens: 200,
});

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx, args) =>
    await ctx.resources.writer.generate({ prompt: args.prompt, instructions: "Be brief." }),
});

export const tag = action({
  args: { text: v.string().min(1) },
  returns: v.object({ tags: v.array(v.string()) }),
  uses: [tagger],
  handler: async (ctx, args) => await ctx.resources.tagger.generate({ prompt: args.text }),
});

/** Two requests in one call; says how the second ended. */
export const twice = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => {
    const first = await ctx.resources.writer.generate({ prompt: "one" });
    try {
      await ctx.resources.writer.generate({ prompt: "two" });
      return \`\${first}|ran\`;
    } catch (error) {
      // A platform refusal reaches App code as an error with its code.
      return \`\${first}|\${String(Reflect.get(Object(error), "code"))}\`;
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { draft, tag, tagger, twice, writer } from "./operations/assist.ts";
import schema from "./schema.ts";

export default app({
  name: "Assistant",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { assist: { draft, tag, twice } },
  internalOperations: {},
  screens: [],
  uses: [writer, tagger],
});
`,
});

type Sealed = Fixture & { release: Release };

/** An App with `files`, sealed and current. */
const sealedApp = async (files: Record<string, string>): Promise<Sealed> => {
  const fixture = await appWith(files);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** Commits `files` as the App's next version, seals it and makes it current. */
const nextVersion = async (
  sealed: Sealed,
  files: Record<string, string>,
  version: number
): Promise<Sealed> => {
  await commitFiles(env, sealed.owner, sealed.app, files, "Next version");
  const release = await seal(sealed, version);
  await setCurrentVersion(env, sealed.owner, sealed.app, version);
  return { ...sealed, release };
};

/** The request a screen sends to call `path` of `release`. */
const requestFor = (release: Release, path: string, input: unknown): string => {
  const operation = release.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  return JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path] ?? "",
      kind: operation.kind,
    },
    input,
  });
};

/** Core's env with the fake gateway, the allowlist `models` and `rules`. */
const gatewayEnv = (
  replies: GatewayReply[],
  models: string[] = [allowedModel],
  rules: Record<string, unknown> = {}
) => {
  const gateway = fakeGateway(...replies);
  const withGateway: Env = {
    ...env,
    MODEL_GATEWAY: { gateway: "grasp-os-test", models, ...rules },
  };
  // The fake's binding is the AI binding as the model gateway reads it.
  Reflect.set(withGateway, "AI", gateway.binding);
  return { gateway, gatewayEnv: withGateway };
};

const answer = (text: string): GatewayReply => ({
  text,
  inputTokens: 100,
  outputTokens: 20,
});

/** Calls `path` of the App as its owner, through `callEnv`. */
const call = async (
  callEnv: Env,
  { app, owner, release }: Sealed,
  path: string,
  input: unknown
): Promise<OperationResult> => {
  const answered = await callAppFunction(
    callEnv,
    owner,
    app,
    requestFor(release, path, input)
  );
  return answered.result;
};

/** What a call answered: its value, or its error's code. */
const outcomeOf = (result: OperationResult): Json =>
  result.ok ? result.value : { failed: result.error.code };

/** An admin's approval of `alias` of the App to the allowed model. */
const approveModel = async (
  sealed: Sealed,
  alias: string,
  version = sealed.release.manifest.resourceVersion
) =>
  await approveResourceBinding(env, await person("admin"), {
    app: sealed.app,
    alias,
    target: { kind: "model", model: allowedModel },
    reviewed: { version },
  });

/** The audit log's events of `action` about App `app`, outboxes drained. */
const auditedFor = async (
  action: string,
  app: string
): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) =>
      event.action === action &&
      (event.target?.id === app ||
        (event.actor.type === "app" && event.actor.appId === app))
  );
};

/** The gateway's request `index`, as JSON text. */
const sentText = (
  gateway: ReturnType<typeof fakeGateway>,
  index: number
): string => JSON.stringify(gateway.requests[index]?.body ?? null);

/** An approval of the App's `writer` to the allowed model, as a client sends it. */
const writerApproval = (sealed: Sealed) => ({
  app: sealed.app,
  alias: "writer",
  target: { kind: "model", model: allowedModel },
  reviewed: { version: 1 },
});

describe("resource bindings", { timeout: 120_000 }, () => {
  it("refuse a model an action declares until an admin binds it", async () => {
    const sealed = await sealedApp(modelFiles());
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("A short draft."),
    ]);
    const unbound = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    const sentUnbound = gateway.requests.length;
    await approveModel(sealed, "writer");
    const bound = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      unbound: outcomeOf(unbound),
      sentUnbound,
      bound: outcomeOf(bound),
    }).toStrictEqual({
      unbound: { failed: "resource.unavailable" },
      sentUnbound: 0,
      bound: "A short draft.",
    });
  });

  it("call a bound model through the gateway, accounted, with no key", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("A short draft."),
    ]);
    await call(withGateway, sealed, "assist.draft", { prompt: "Hi" });
    const [sent] = gateway.requests;
    // The declared token bound, the instructions as the system prompt.
    expect(sent?.body).toMatchObject({
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    expect({
      authorization: sent?.headers.get("authorization"),
      apiKey: sent?.headers.get("x-api-key"),
    }).toStrictEqual({ authorization: null, apiKey: null });
    // Recorded and settled by the ledger, for the App.
    const [called] = await auditedFor("model.call", sealed.app);
    expect(called).toMatchObject({
      actor: { type: "app", appId: sealed.app },
      detail: { purpose: "app.resource", ledger: "settled" },
    });
  });

  it("enforce a model's structured output, asking again once", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "tagger");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer('{"tags": ["  padded  "]}'),
      answer('{"tags": ["launch", "plans"]}'),
      answer("not json"),
      answer('{"tags": [""]}'),
    ]);
    const fitted = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    const neverFitted = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    expect({
      fitted: outcomeOf(fitted),
      neverFitted: outcomeOf(neverFitted),
    }).toStrictEqual({
      fitted: { tags: ["launch", "plans"] },
      // Two answers that never fit: the contract the provider broke.
      neverFitted: { failed: "contract.invalid_resource_result" },
    });
    // The model was told the descriptor's JSON Schema, and why its first
    // answer didn't fit: not in its exact form.
    expect([sentText(gateway, 0), sentText(gateway, 1)]).toStrictEqual([
      expect.stringContaining(String.raw`\"maxItems\":5`),
      expect.stringContaining("exact form"),
    ]);
  });

  it("stop a binding revoked between two requests of one call", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed, "writer");
    const gate = Promise.withResolvers<unknown>();
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withGateway, sealed, "assist.twice", {});
    while (gateway.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    await revokeResourceBinding(env, await person("admin"), binding.id);
    gate.resolve(null);
    const result = await running;
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: "first|resource.unavailable", sent: 1 });
  });

  it("serve only the declaration an admin approved", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    // The next version asks for longer answers: the binding no longer
    // matches what was reviewed.
    const widened = await nextVersion(sealed, modelFiles(5000), 2);
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("Longer."),
    ]);
    const before = await call(withGateway, widened, "assist.draft", {
      prompt: "Hi",
    });
    const sentBefore = gateway.requests.length;
    await approveModel(widened, "writer", 2);
    const after = await call(withGateway, widened, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      before: outcomeOf(before),
      sentBefore,
      after: outcomeOf(after),
    }).toStrictEqual({
      before: { failed: "resource.unavailable" },
      sentBefore: 0,
      after: "Longer.",
    });
  });

  it("stop a model the deployment no longer allows", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv(
      [answer("Hidden.")],
      ["openai/gpt-5.4"]
    );
    const result = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
  });

  it("count every request against the person's budget", async () => {
    const sealed = await sealedApp(modelFiles(100_000));
    await approveModel(sealed, "writer");
    // Less than the longest answer the declaration allows could cost:
    // refused by the ledger before anything is sent.
    const { gateway, gatewayEnv: withGateway } = gatewayEnv(
      [answer("Too dear.")],
      [allowedModel],
      { budgets: { user: { limit: 0.01 } } }
    );
    const result = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({
      outcome: { failed: "resource.budget_exhausted" },
      sent: 0,
    });
  });

  it("are approved by admins only, never staff or builders", async () => {
    const sealed = await sealedApp(modelFiles());
    const staff = { ...(await person("admin")), staff: true };
    const approval = writerApproval(sealed);
    const refused = {
      builder: await failure(
        async () => await approveResourceBinding(env, sealed.owner, approval)
      ),
      staff: await failure(
        async () => await approveResourceBinding(env, staff, approval)
      ),
    };
    expect(refused).toStrictEqual({
      builder: "role.forbidden",
      staff: "role.forbidden",
    });
  });

  it("bind only what the reviewed version declares, to what may serve it", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const approval = writerApproval(sealed);
    const refusal = async (change: object) =>
      await failure(
        async () =>
          await approveResourceBinding(env, admin, { ...approval, ...change })
      );
    expect({
      undeclared: await refusal({ alias: "mailer" }),
      otherKind: await refusal({
        target: { kind: "template", templateId: "letter", version: 1 },
      }),
      notAllowed: await refusal({
        target: { kind: "model", model: "openai/gpt-5.4" },
      }),
      notCurrent: await refusal({ reviewed: { version: 2 } }),
    }).toStrictEqual({
      undeclared: "resource.undeclared",
      otherKind: "resource.undeclared",
      notAllowed: "resource.target_invalid",
      notCurrent: "app.conflict",
    });
  });

  it("replace an alias's binding when approved again, audited", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const first = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    const second = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    const listed = await listResourceBindings(env, sealed.owner, sealed.app);
    expect(listed.map(({ id, status }) => ({ id, status }))).toStrictEqual([
      { id: second.id, status: "active" },
      { id: first.id, status: "revoked" },
    ]);
    const approved = await auditedFor(
      "app.resource_binding.approved",
      sealed.app
    );
    const revoked = await auditedFor(
      "app.resource_binding.revoked",
      sealed.app
    );
    expect({
      approved: approved.map(({ detail }) => detail?.binding),
      revoked: revoked.map(({ detail }) => detail),
    }).toStrictEqual({
      approved: [first.id, second.id],
      revoked: [
        expect.objectContaining({ binding: first.id, replacedBy: second.id }),
      ],
    });
  });

  it("are revoked by admins only, while they are admins", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const binding = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    const byBuilder = await failure(
      async () => await revokeResourceBinding(env, sealed.owner, binding.id)
    );
    // An admin demoted since their session was checked changes nothing.
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const byDemoted = await failure(
      async () => await revokeResourceBinding(env, admin, binding.id)
    );
    const still = await drizzle(env.DB)
      .select({ status: appResourceBindings.status })
      .from(appResourceBindings)
      .where(eq(appResourceBindings.id, binding.id))
      .get();
    expect({ byBuilder, byDemoted, still }).toStrictEqual({
      byBuilder: "role.forbidden",
      byDemoted: "role.forbidden",
      still: { status: "active" },
    });
  });
});
