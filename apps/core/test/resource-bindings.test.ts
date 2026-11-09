import { knowledgeSearchMaxLength } from "@grasp-os/shared/function-limits";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { appMembers, appResourceBindings } from "../src/db/core/schema.ts";
import { revokePermission } from "../src/permissions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import {
  approveResourceBinding,
  listResourceBindings,
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { publishTemplate } from "../src/resource-templates.ts";
import { isRestricted } from "../src/restricted.ts";
import {
  answer,
  answerOf,
  approveModel,
  auditedFor,
  call,
  chooseModel,
  codeOfError,
  deepLetter,
  hitsSchema,
  knowledgeApp,
  knowledgeFiles,
  modelFiles,
  nextVersion,
  outcomeOf,
  providerEnv,
  publishRefusal,
  requestFor,
  sealedApp,
  searchTextOf,
  sentText,
  writerApproval,
} from "./resource-bindings-harness.ts";
import { failure, person } from "./sealed-apps.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// operation host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only the model
// provider behind connect faked.

describe("resource bindings", { timeout: 120_000 }, () => {
  beforeEach(chooseModel);

  it("refuse a model an action declares until an admin binds it", async () => {
    const sealed = await sealedApp(modelFiles());
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("A short draft."),
    ]);
    const unbound = await call(withProvider, sealed, "assist.draft", {
      prompt: "Hi",
    });
    const sentUnbound = provider.requests.length;
    await approveModel(sealed);
    const bound = await call(withProvider, sealed, "assist.draft", {
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

  it("call a bound model through the gateway, accounted", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("A short draft."),
    ]);
    await call(withProvider, sealed, "assist.draft", { prompt: "Hi" });
    const [sent] = provider.requests;
    // The declared token bound, the instructions as the system prompt.
    expect(sent?.body).toMatchObject({
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    // Recorded and settled by the ledger, for the App.
    const [called] = await auditedFor("model.call", sealed.app);
    expect(called).toMatchObject({
      actor: { type: "app", appId: sealed.app },
      detail: { purpose: "app.resource" },
    });
  });

  it("bind a model only when it can give each request's share of the declared bound", async () => {
    // Mistral Large answers at most a quarter of its 262,144-token window,
    // 65,536 tokens. A request for text asks for the whole bound at once;
    // one for a value for half of it each time, as it may ask again.
    const tooLong = await sealedApp(modelFiles(65_537));
    const admin = await person("admin");
    const refused = await failure(
      async () =>
        await approveResourceBinding(env, admin, writerApproval(tooLong))
    );
    const sealed = await sealedApp(modelFiles(65_536));
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer('{"tags": ["launch"]}'),
    ]);
    const tagged = await call(withProvider, sealed, "assist.tag", {
      text: "Notes",
    });
    const bindings = await listResourceBindings(env, admin, tooLong.app);
    expect({
      refused,
      bound: bindings.length,
      tagged: outcomeOf(tagged),
      sent: provider.requests.map(({ body }) => body),
    }).toStrictEqual({
      refused: "resource.model_too_small",
      bound: 0,
      tagged: { tags: ["launch"] },
      sent: [expect.objectContaining({ max_completion_tokens: 32_768 })],
    });
  });

  it("send an App's request the whole bound a model can answer", async () => {
    const sealed = await sealedApp(modelFiles(65_536));
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("A long draft."),
    ]);
    const drafted = await call(withProvider, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      drafted: outcomeOf(drafted),
      sent: provider.requests.map(({ body }) => body),
    }).toStrictEqual({
      drafted: "A long draft.",
      sent: [expect.objectContaining({ max_completion_tokens: 65_536 })],
    });
  });

  it("enforce the value a request asks for, asking again once", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer('{"tags": ["  padded  "]}'),
      answer('{"tags": ["launch", "plans"]}'),
      answer("not json"),
      answer('{"tags": [""]}'),
    ]);
    const fitted = await call(withProvider, sealed, "assist.tag", {
      text: "Notes",
    });
    const neverFitted = await call(withProvider, sealed, "assist.tag", {
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
    // The declared 300 tokens bound the App's request as a whole: each of
    // its two attempts may take half.
    const ceilings = provider.requests
      .slice(0, 2)
      .map(
        ({ body }) =>
          z.object({ max_completion_tokens: z.number() }).parse(body)
            .max_completion_tokens
      );
    expect(ceilings).toStrictEqual([150, 150]);
    // The model was told the descriptor's JSON Schema, and why its first
    // answer didn't fit: not in its exact form.
    expect([sentText(provider, 0), sentText(provider, 1)]).toStrictEqual([
      expect.stringContaining(String.raw`\"maxItems\":5`),
      expect.stringContaining("exact form"),
    ]);
  });

  it("stop a binding revoked between two requests of one call", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed);
    const gate = Promise.withResolvers<unknown>();
    const { provider, providerEnv: withProvider } = await providerEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withProvider, sealed, "assist.twice", {});
    while (provider.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    await revokeResourceBinding(env, await person("admin"), binding.id);
    gate.resolve(null);
    const result = await running;
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|resource.unavailable", sent: 1 });
  });

  it("serve only the declaration an admin approved", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    // The next version asks for longer answers: the binding no longer
    // matches what was reviewed.
    const widened = await nextVersion(sealed, modelFiles(5000), 2);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Longer."),
    ]);
    const before = await call(withProvider, widened, "assist.draft", {
      prompt: "Hi",
    });
    const sentBefore = provider.requests.length;
    await approveModel(widened, 2);
    const after = await call(withProvider, widened, "assist.draft", {
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

  it("stop a model the organization no longer chooses", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv(
      [answer("Hidden.")],
      ["openai/gpt-5.4"]
    );
    const result = await call(withProvider, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
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
        target: { kind: "guests", permissionId: crypto.randomUUID() },
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

  it("leave out a binding whose target no longer parses, as one to another App an older version wrote", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const binding = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    // Written by the version before, while this one deployed: past the
    // migration that removed the rest.
    const stale = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO app_resource_bindings (id, app_id, alias, kind, target,
        declaration_hash, contract_id, fingerprint, reviewed_version, status,
        approved_by, approved_at)
       VALUES (?, ?, 'crm', 'app', ?, 'hash', 'app:crm', 'fingerprint', 1, 'active', ?, 0)`
    )
      .bind(
        stale,
        sealed.app,
        JSON.stringify({ kind: "app", appId: "crm" }),
        admin.userId
      )
      .run();
    const listed = await listResourceBindings(env, admin, sealed.app);
    const review = await reviewResourceBindings(env, admin, sealed.app);
    expect({
      listed: listed.map(({ id }) => id),
      undeclared: review.undeclared.map(({ id }) => id),
      revoked: await failure(
        async () => await revokeResourceBinding(env, admin, stale)
      ),
    }).toStrictEqual({
      listed: [binding.id],
      undeclared: [],
      revoked: "resource.binding_not_found",
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

  it("hand App code no key, token or gateway detail", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Plain text."),
    ]);
    const result = await call(withProvider, sealed, "assist.probe", {});
    const seen =
      result.ok && typeof result.value === "string" ? result.value : "";
    // Every secret core holds, and the provider's key its requests carry.
    const secrets = [
      env.CAPABILITY_SIGNING_KEY,
      env.BETTER_AUTH_SECRET,
      env.ROUTER_SECRET,
      provider.key,
      "Bearer",
    ];
    expect({
      answered: seen.startsWith("Plain text."),
      leaked: secrets.filter((secret) => seen.includes(secret)),
    }).toStrictEqual({ answered: true, leaked: [] });
  });

  it("serve one App's binding to that App only", async () => {
    const sealed = await sealedApp(modelFiles());
    const other = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Mine."),
    ]);
    // The same declaration, in another App with no binding of its own.
    const result = await call(withProvider, other, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
  });

  it("keep one active binding when two approvals of an alias race", async () => {
    const sealed = await sealedApp(modelFiles());
    const [one, two] = await Promise.allSettled([
      approveModel(sealed),
      approveModel(sealed),
    ]);
    const active = await drizzle(env.DB)
      .select({ id: appResourceBindings.id })
      .from(appResourceBindings)
      .where(
        and(
          eq(appResourceBindings.appId, sealed.app),
          eq(appResourceBindings.status, "active")
        )
      );
    const settled = [one, two].map((outcome) =>
      outcome?.status === "fulfilled"
        ? "approved"
        : codeOfError(outcome?.reason)
    );
    expect({
      active: active.length,
      settled: settled.every(
        (each) => each === "approved" || each === "app.conflict"
      ),
      approved: settled.includes("approved"),
    }).toStrictEqual({ active: 1, settled: true, approved: true });
  });

  it("refuse an approval by an admin demoted since their session was checked", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const refused = await failure(
      async () =>
        await approveResourceBinding(env, admin, writerApproval(sealed))
    );
    const rows = await drizzle(env.DB)
      .select({ id: appResourceBindings.id })
      .from(appResourceBindings)
      .where(eq(appResourceBindings.appId, sealed.app));
    expect({ refused, rows: rows.length }).toStrictEqual({
      refused: "role.forbidden",
      rows: 0,
    });
  });

  it("tell the model a defaulted field must be given, as the exact form is checked", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer('{"label": "Launch", "status": "draft"}'),
    ]);
    const result = await call(withProvider, sealed, "assist.label", {
      text: "Notes",
    });
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
      told: sentText(provider, 0).includes(
        String.raw`\"required\":[\"label\",\"status\"]`
      ),
    }).toStrictEqual({
      outcome: { label: "Launch", status: "draft" },
      sent: 1,
      told: true,
    });
  });

  it("stop a release revoked between two requests of one call", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const gate = Promise.withResolvers<unknown>();
    const { provider, providerEnv: withProvider } = await providerEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withProvider, sealed, "assist.twice", {});
    while (provider.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    await revokeRelease(
      env,
      await person("admin"),
      { app: sealed.app, version: 1 },
      "Compromised"
    );
    gate.resolve(null);
    const result = await running;
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|version.revoked", sent: 1 });
  });

  it("stop a page caller whose App role is removed between two requests", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const user = await person("user");
    await drizzle(env.DB).insert(appMembers).values({
      appId: sealed.app,
      memberType: "person",
      memberId: user.userId,
      role: "user",
      addedBy: sealed.owner.userId,
      addedAt: new Date(),
    });
    const gate = Promise.withResolvers<unknown>();
    const { provider, providerEnv: withProvider } = await providerEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = callAppFunction(
      withProvider,
      user,
      sealed.app,
      requestFor(sealed.release, "assist.twice", {})
    );
    while (provider.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    // No longer shared with them: the action already running goes on,
    // but reaches nothing more.
    await drizzle(env.DB)
      .delete(appMembers)
      .where(
        and(
          eq(appMembers.appId, sealed.app),
          eq(appMembers.memberId, user.userId)
        )
      );
    gate.resolve(null);
    const answered = await running;
    expect({
      outcome: outcomeOf(answered.result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|app.not_found", sent: 1 });
  });

  it("stop a call once what admitted its caller no longer holds, between two requests", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("first"),
      answer("never sent"),
    ]);
    // As an agent's permission revoked mid-call: it holds as the call
    // starts and for its first request, then no more.
    let checks = 0;
    const stillAllowed = async () => {
      checks += 1;
      if (checks > 2) {
        throw permissionErrors.create("permission.denied", { action: "call" });
      }
      await Promise.resolve();
    };
    const answered = await callAppFunction(
      withProvider,
      sealed.owner,
      sealed.app,
      requestFor(sealed.release, "assist.twice", {}),
      Date.now() + 60_000,
      stillAllowed
    );
    expect({
      outcome: outcomeOf(answered.result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|permission.denied", sent: 1 });
  });

  it("answer two racing revocations with the binding as it is", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed);
    const admins = [await person("admin"), await person("admin")];
    // Both read it active before either writes.
    const [one, two] = await Promise.all(
      admins.map(
        async (admin) => await revokeResourceBinding(env, admin, binding.id)
      )
    );
    // Revoking it twice records it once: the loser reads it again.
    const revoked = await auditedFor(
      "app.resource_binding.revoked",
      sealed.app
    );
    expect({
      one: one?.status,
      two: two?.status,
      recorded: revoked.length,
    }).toStrictEqual({ one: "revoked", two: "revoked", recorded: 1 });
  });

  it("search and read only the bound collections, as the person may", async () => {
    const { sealed, documents, collections } = await knowledgeApp();
    const found = await answerOf(sealed, "help.find", { text: "leave" });
    const opened = await answerOf(sealed, "help.open", {
      id: documents.leave,
    });
    // A document of a collection the binding doesn't name is no item at
    // all, whatever else the App may read.
    const unbound = await answerOf(sealed, "help.open", {
      id: documents.secret,
    });
    const hits = hitsSchema.parse(outcomeOf(found.result));
    expect({
      // Each collection's best, interleaved; a hit is a title and an excerpt.
      found: hits.map(({ title, excerpt }) => [
        title,
        excerpt.toLowerCase().includes("leave"),
      ]),
      opened: outcomeOf(opened.result),
      unbound: outcomeOf(unbound.result),
    }).toStrictEqual({
      found: [
        ["Leave", true],
        ["Pay", true],
      ],
      opened: {
        title: "Leave",
        text: "# Leave\nAsk your lead before you take leave.",
      },
      unbound: { failed: "resource.item_not_found" },
    });
    // The handbook alone was read: nothing sensitive in the answer.
    expect(opened.provenance).toStrictEqual({
      collectionIds: [collections.handbook],
      sensitive: false,
      restricted: false,
      connections: [],
      truncated: false,
    });
  });

  it("search what the person may read of the bound collections, and nothing else", async () => {
    const { sealed, documents, collections, team } = await knowledgeApp();
    // The App's owner leaves the payroll team: its salaries collection is
    // still bound, but no longer theirs to read.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(team, sealed.owner.userId)
      .run();
    const found = await answerOf(sealed, "help.find", { text: "leave" });
    const opened = await answerOf(sealed, "help.open", { id: documents.pay });
    expect({
      found: hitsSchema
        .parse(outcomeOf(found.result))
        .map(({ title }) => title),
      provenance: found.provenance,
      opened: outcomeOf(opened.result),
    }).toStrictEqual({
      found: ["Leave"],
      provenance: {
        collectionIds: [collections.handbook],
        sensitive: false,
        restricted: false,
        connections: [],
        truncated: false,
      },
      // As a document that doesn't exist.
      opened: { failed: "resource.item_not_found" },
    });
  });

  it("search with text up to Knowledge's own limit, and refuse longer up front", async () => {
    const { sealed } = await knowledgeApp();
    const atLimit = await answerOf(sealed, "help.find", {
      text: searchTextOf(knowledgeSearchMaxLength),
    });
    const pastLimit = await answerOf(sealed, "help.find", {
      text: searchTextOf(knowledgeSearchMaxLength + 1),
    });
    expect({
      atLimit: hitsSchema
        .parse(outcomeOf(atLimit.result))
        .map(({ title }) => title),
      pastLimit: outcomeOf(pastLimit.result),
    }).toStrictEqual({
      atLimit: ["Leave", "Pay"],
      pastLimit: { failed: "contract.invalid_args" },
    });
  });

  it("carry a sensitive source's classification and restrict the App", async () => {
    const { sealed, documents, collections } = await knowledgeApp();
    const authority = {
      subject: { type: "app" as const, appId: sealed.app },
      onBehalfOf: sealed.owner.userId,
      mode: "interactive" as const,
      appVersion: 1,
    };
    const context = { type: "app" as const, appId: sealed.app };
    const before = await isRestricted(env, authority, context);
    const opened = await answerOf(sealed, "help.open", { id: documents.pay });
    expect({
      before,
      after: await isRestricted(env, authority, context),
      provenance: opened.provenance,
    }).toStrictEqual({
      before: false,
      after: true,
      provenance: {
        collectionIds: [collections.salaries],
        sensitive: true,
        restricted: true,
        connections: [],
        truncated: false,
      },
    });
  });

  it("stop knowledge whose collection permission was revoked", async () => {
    const { sealed, admin, permissions } = await knowledgeApp();
    await revokePermission(env, admin, permissions.salaries);
    const found = await answerOf(sealed, "help.find", { text: "leave" });
    expect(outcomeOf(found.result)).toStrictEqual({
      failed: "resource.unavailable",
    });
  });

  it("bind knowledge only to the App's own grants, for every collection declared", async () => {
    const { sealed, admin, permissions } = await knowledgeApp();
    const other = await sealedApp(knowledgeFiles());
    const refusal = async (collections: Record<string, string>, app = sealed) =>
      await failure(
        async () =>
          await approveResourceBinding(env, admin, {
            app: app.app,
            alias: "brain",
            target: { kind: "knowledge", collections },
            reviewed: { version: 1 },
          })
      );
    expect({
      missing: await refusal({ handbook: permissions.handbook }),
      extra: await refusal({ ...permissions, more: permissions.handbook }),
      anotherApps: await refusal(permissions, other),
    }).toStrictEqual({
      missing: "resource.target_invalid",
      extra: "resource.target_invalid",
      anotherApps: "resource.target_invalid",
    });
  });

  it("number a template's versions one at a time, even published at once", async () => {
    const admin = await person("admin");
    const first = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    const publishNext = async (greeting: string): Promise<string> =>
      await failure(
        async () =>
          await publishTemplate(env, admin, {
            templateId: first.templateId,
            contract: "grasp.letter@1",
            content: { greeting },
          })
      );
    const outcomes = await Promise.all([
      publishNext("Hello"),
      publishNext("Hi"),
    ]);
    const published = await auditedFor(
      "resource.template.published",
      first.templateId
    );
    expect({
      outcomes: outcomes.toSorted(),
      published: published.map(({ detail }) => detail?.version),
    }).toStrictEqual({
      outcomes: ["app.conflict", "ok"],
      published: [1, 2],
    });
  });

  it("publish templates by admins only, keeping each one's contract", async () => {
    const admin = await person("admin");
    const builder = await person("builder");
    const first = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    expect({
      builder: await publishRefusal(builder, {
        contract: "grasp.letter@1",
        content: {},
      }),
      otherContract: await publishRefusal(admin, {
        templateId: first.templateId,
        contract: "grasp.invoice@1",
        content: {},
      }),
      unknown: await publishRefusal(admin, {
        templateId: "no-such-template",
        contract: "grasp.letter@1",
        content: {},
      }),
      tooLarge: await publishRefusal(admin, {
        contract: "grasp.letter@1",
        content: { text: "x".repeat(70_000) },
      }),
      // A contract too long to name in the publication's audit event.
      longContract: await publishRefusal(admin, {
        contract: `${"a".repeat(255)}@1`,
        content: {},
      }),
      // Served inside its answer, one level down: too deep to be read.
      tooDeep: await publishRefusal(admin, {
        contract: "grasp.letter@1",
        content: deepLetter(valueDepth),
      }),
    }).toStrictEqual({
      builder: "role.forbidden",
      otherContract: "resource.template_contract_changed",
      unknown: "resource.template_not_found",
      tooLarge: "resource.template_invalid",
      longContract: "resource.template_invalid",
      tooDeep: "resource.template_invalid",
    });
  });

  it("refuse a publication by an admin demoted since their session was checked", async () => {
    const admin = await person("admin");
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const refused = await publishRefusal(admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Stale" },
    });
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM resource_templates WHERE published_by = ?"
    )
      .bind(admin.userId)
      .first<{ count: number }>();
    expect({ refused, published: rows?.count }).toStrictEqual({
      refused: "role.forbidden",
      published: 0,
    });
  });
});
