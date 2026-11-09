import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { appResourceBindings } from "../src/db/core/schema.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { commitApp } from "./app-definitions.ts";
import { mockIdpWith } from "./idp.ts";
import { planOf, recordedQueries } from "./query-plans.ts";
import {
  call,
  confirmAll,
  failure,
  heldSend,
  idp,
  mailerApp,
  outcomeOf,
  sentCount,
  servingEnv,
  someMessages,
  withOutput,
} from "./resource-connectors-harness.ts";

// An App's connector resources reach an outside system only through
// connect, under a binding an admin approved and the App's own connection
// permission, checked against the generated connector contract both ways
// (spec 12). This runs the real connect and its native Microsoft 365
// connector, with only Microsoft's sign-in and Graph faked.

mockIdpWith(idp);

describe("connector resource bindings", { timeout: 120_000 }, () => {
  it("read through connect under the App's connection grant", async () => {
    const mailer = await mailerApp();
    expect(outcomeOf(await call(mailer, "mail.inbox", {}))).toBe(0);
  });

  it("find a call's binding by the index of active bindings, reading no bindings whole", async () => {
    const mailer = await mailerApp();
    const queries = await recordedQueries(async () => {
      await call(mailer, "mail.inbox", {});
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => /from "app_resource_bindings"/u.test(query))
        .map(async (recorded) => await planOf(recorded))
    );

    expect({
      looked: plans.length > 0,
      plans: new Set(plans.flat()),
    }).toStrictEqual({
      looked: true,
      plans: new Set([
        "SEARCH app_resource_bindings USING INDEX app_resource_bindings_active_idx (app_id=? AND alias=?)",
      ]),
    });
  });

  it("hold a side effect for the person, then answer it once, under the call's key", async () => {
    const mailer = await mailerApp();
    // A subject of this test's own: other files' runs send mail through
    // the same Graph fake meanwhile.
    const subject = `Launch ${crypto.randomUUID()}`;
    const input = { to: "ada@acme.test", subject };
    const held = await call(mailer, "mail.send", input, "launch-1");
    const whileHeld = await sentCount(subject);
    await confirmAll(mailer);
    const answered = await call(mailer, "mail.send", input, "launch-1");
    const again = await call(mailer, "mail.send", input, "launch-1");
    expect({
      held: outcomeOf(held),
      sentWhileHeld: whileHeld,
      answered: outcomeOf(answered),
      again: outcomeOf(again),
    }).toStrictEqual({
      held: { failed: "resource.awaiting_confirmation" },
      sentWhileHeld: 0,
      answered: { mailbox: "team@acme.test", sent: true },
      again: { mailbox: "team@acme.test", sent: true },
    });
    // Sent once, as the person confirmed it: the repeats replayed it.
    await expect(sentCount(subject)).resolves.toBe(1);
  });

  it("refuse arguments the contract doesn't allow before connect sees them", async () => {
    const mailer = await mailerApp();
    const result = await call(mailer, "mail.careless", {});
    const pending = await mailer.builder.api.pendingActions.list();
    expect({ outcome: outcomeOf(result), held: pending.length }).toStrictEqual({
      outcome: { failed: "resource.invalid_args" },
      held: 0,
    });
  });

  it("stop a binding once connect serves another contract than was approved", async () => {
    const mailer = await mailerApp();
    const changed = servingEnv(withOutput("list", someMessages));
    const reshaped = await call(mailer, "mail.inbox", {}, undefined, changed);
    // A connection that is gone serves no contract at all.
    const listed = await mailer.admin.api.connections.list();
    const shared = listed.find((connection) => connection.scope === "shared");
    await mailer.admin.api.connections.disconnect(shared?.id ?? "");
    const disconnected = await call(mailer, "mail.inbox", {});
    expect({
      reshaped: outcomeOf(reshaped),
      disconnected: outcomeOf(disconnected),
    }).toStrictEqual({
      reshaped: { failed: "resource.unavailable" },
      disconnected: { failed: "resource.unavailable" },
    });
  });

  it("refuse an answer outside the contract connect serves", async () => {
    const mailer = await mailerApp({ bind: false });
    const changed = servingEnv(withOutput("list", someMessages));
    // Approved against the stricter contract, which the real answer (no
    // messages) breaks.
    const admin = await mailer.admin.api.whoami();
    await approveResourceBinding(changed, admin, mailer.approval);
    const result = await call(mailer, "mail.inbox", {}, undefined, changed);
    expect(outcomeOf(result)).toStrictEqual({
      failed: "contract.invalid_resource_result",
    });
  });

  it("carry the connections a call read into its provenance", async () => {
    const mailer = await mailerApp();
    const answered = await callAppFunction(
      env,
      mailer.by,
      mailer.release.manifest.resourceId,
      JSON.stringify({
        reference: { name: "mail.inbox", kind: "action" },
        input: {},
      })
    );
    const permissions = await mailer.admin.api.permissions.list();
    const connection = permissions.find(({ id }) => id === mailer.permission);
    expect(answered.provenance?.truncated).toBeFalsy();
    expect(answered.provenance?.connections).toStrictEqual([
      {
        connectionId:
          connection?.object.type === "connection"
            ? connection.object.connectionId
            : "",
        resources: [],
      },
    ]);
  });

  it("refuse side effects of a version made current without an admin, until one grants it again", async () => {
    const mailer = await mailerApp();
    // The builder's next version changes nothing the binding approved,
    // but makes the connection permission asked for again.
    await commitApp(
      mailer.builder.api.apps.files,
      mailer.release.manifest.resourceId,
      { "README.md": "Mailer." },
      "Docs"
    );
    await mailer.builder.api.apps.versions.setCurrent(
      mailer.release.manifest.resourceId,
      2
    );
    const next = {
      ...mailer,
      release: await loadRelease(
        env,
        appIdSchema.parse(mailer.release.manifest.resourceId),
        2
      ),
    };
    const input = { to: "ada@acme.test", subject: "Unapproved" };
    const unapproved = await call(next, "mail.send", input, "next-1");
    await mailer.admin.api.permissions.grant(mailer.permission, {
      version: 2,
    });
    // The binding carries over to the identical declaration.
    const granted = await call(next, "mail.send", input, "next-2");
    expect({
      unapproved: outcomeOf(unapproved),
      granted: outcomeOf(granted),
      sent: await sentCount("Unapproved"),
    }).toStrictEqual({
      unapproved: { failed: "resource.unavailable" },
      granted: { failed: "resource.awaiting_confirmation" },
      sent: 0,
    });
  });

  it("refuse a call key replayed with another payload", async () => {
    const mailer = await mailerApp();
    await call(mailer, "mail.sendFresh", {}, "fresh-1");
    const replayed = await call(mailer, "mail.sendFresh", {}, "fresh-1");
    expect(outcomeOf(replayed)).toStrictEqual({
      failed: "resource.idempotency_conflict",
    });
  });

  it("answer a declined side effect as declined, under its call's key, never sent", async () => {
    const mailer = await mailerApp();
    const input = { to: "ada@acme.test", subject: "Declined" };
    await call(mailer, "mail.send", input, "declined-1");
    const waiting = await heldSend(mailer);
    await mailer.builder.api.pendingActions.decline(waiting.id);
    const again = await call(mailer, "mail.send", input, "declined-1");
    expect({
      again: outcomeOf(again),
      sent: await sentCount("Declined"),
    }).toStrictEqual({
      again: { failed: "resource.declined" },
      sent: 0,
    });
  });

  it("drop a held side effect when its binding is revoked", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Late" },
      "late-1"
    );
    await mailer.admin.api.resourceBindings.revoke(mailer.binding?.id ?? "");
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      waiting: waiting.length,
      sent: await sentCount("Late"),
    }).toStrictEqual({
      waiting: 0,
      sent: 0,
    });
  });

  it("refuse to confirm a held side effect its binding no longer serves, and drop it", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Stale" },
      "stale-1"
    );
    const held = await heldSend(mailer);
    // Revoked behind the API's back, so nothing dropped the held action:
    // only the check on confirming stands between it and Graph.
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ status: "revoked", revokedAt: new Date(), revokedBy: "test" })
      .where(eq(appResourceBindings.id, mailer.binding?.id ?? ""));
    // Through the session, as the person's client confirms: the refusal
    // reaches it with its code, not redacted.
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Stale"),
      waiting: waiting.length,
    }).toStrictEqual({ refused: "resource.unavailable", sent: 0, waiting: 0 });
  });

  it("refuse to confirm a held side effect whose contract drifted since", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Drift" },
      "drift-1"
    );
    const held = await heldSend(mailer);
    const changed = servingEnv(
      withOutput("send", {
        type: "object",
        properties: { mailbox: { type: "string" } },
        required: ["mailbox"],
        additionalProperties: false,
      })
    );
    const refused = await failure(
      async () =>
        await confirmPendingAction(changed, mailer.by, held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Drift"),
      waiting: waiting.length,
    }).toStrictEqual({ refused: "resource.unavailable", sent: 0, waiting: 0 });
  });
});
