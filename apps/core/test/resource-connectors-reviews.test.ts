import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { permissions as permissionRows } from "../src/db/core/schema.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import { reviewResourceBindings } from "../src/resource-bindings.ts";
import { commitApp } from "./app-definitions.ts";
import { mockIdpWith } from "./idp.ts";
import {
  archiveFiles,
  askCountingEnv,
  call,
  choicesOf,
  failure,
  heldSend,
  idp,
  mailFiles,
  mailerApp,
  outcomeOf,
  sentCount,
  servingEnv,
  someMessages,
  undeclaredMailFiles,
  unknownContractFiles,
  withOutput,
} from "./resource-connectors-harness.ts";
import type { Mailer } from "./resource-connectors-harness.ts";
import { connectDb } from "./test-env.ts";

// An App's connector resources reach an outside system only through
// connect, under a binding an admin approved and the App's own connection
// permission, checked against the generated connector contract both ways
// (spec 12). This runs the real connect and its native Microsoft 365
// connector, with only Microsoft's sign-in and Graph faked.

mockIdpWith(idp);

const refusal = async ({ admin, approval }: Mailer) =>
  await failure(async () => await admin.api.resourceBindings.approve(approval));

describe("connector resource bindings", { timeout: 120_000 }, () => {
  it("refuse to confirm a held side effect once a version widened its declaration", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Wider" },
      "wider-1"
    );
    const held = await heldSend(mailer);
    const app = mailer.release.manifest.resourceId;
    await commitApp(
      mailer.builder.api.apps.files,
      app,
      mailFiles("microsoft-365.mail@1", `["send", "list", "createDraft"]`),
      "More"
    );
    await mailer.builder.api.apps.versions.publish(app, 2);
    // An admin grants the connection again, approving the version: only
    // the binding, approved for the narrower declaration, is stale.
    await mailer.admin.api.permissions.grant(mailer.permission, { version: 2 });
    const refused = await failure(
      async () =>
        await confirmPendingAction(env, mailer.by, held.id, held.inputHash)
    );
    const waiting = await mailer.builder.api.pendingActions.list();
    expect({
      refused,
      sent: await sentCount("Wider"),
      waiting: waiting.length,
    }).toStrictEqual({
      refused: "permission.unavailable",
      sent: 0,
      waiting: 0,
    });
  });

  it("leave a dropped held call's key free: the same call is asked again, never answered as declined", async () => {
    const mailer = await mailerApp();
    const input = { to: "ada@acme.test", subject: "Again" };
    await call(mailer, "mail.send", input, "again-1");
    // Approved again: the binding is replaced, its held call dropped.
    await mailer.admin.api.resourceBindings.approve(mailer.approval);
    const afterReplace = await call(mailer, "mail.send", input, "again-1");
    // Revoked, then approved anew: dropped again.
    const [current] = await mailer.admin.api.resourceBindings.list(
      mailer.release.manifest.resourceId
    );
    await mailer.admin.api.resourceBindings.revoke(current?.id ?? "");
    await mailer.admin.api.resourceBindings.approve(mailer.approval);
    const afterRevoke = await call(mailer, "mail.send", input, "again-1");
    expect({
      afterReplace: outcomeOf(afterReplace),
      afterRevoke: outcomeOf(afterRevoke),
      sent: await sentCount("Again"),
    }).toStrictEqual({
      afterReplace: { failed: "permission.awaiting_confirmation" },
      afterRevoke: { failed: "permission.awaiting_confirmation" },
      sent: 0,
    });
  });

  it("refuse to confirm a held call whose stored binding no longer reads", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Garbled" },
      "garbled-1"
    );
    const held = await heldSend(mailer);
    await connectDb()
      .prepare("UPDATE pending_actions SET binding = ? WHERE id = ?")
      .bind("not a binding", held.id)
      .run();
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    expect({ refused, sent: await sentCount("Garbled") }).toStrictEqual({
      refused: "permission.unavailable",
      sent: 0,
    });
  });

  it("refuse to confirm a held call once the current version no longer declares its alias", async () => {
    const mailer = await mailerApp();
    await call(
      mailer,
      "mail.send",
      { to: "ada@acme.test", subject: "Unused" },
      "unused-1"
    );
    const held = await heldSend(mailer);
    const app = mailer.release.manifest.resourceId;
    await commitApp(
      mailer.builder.api.apps.files,
      app,
      undeclaredMailFiles(),
      "Quiet"
    );
    await mailer.builder.api.apps.versions.publish(app, 2);
    await mailer.admin.api.permissions.grant(mailer.permission, { version: 2 });
    const refused = await failure(
      async () =>
        await mailer.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    expect({ refused, sent: await sentCount("Unused") }).toStrictEqual({
      refused: "permission.unavailable",
      sent: 0,
    });
  });

  it("expose no binding, key or token to App code", async () => {
    const mailer = await mailerApp();
    const result = await call(mailer, "mail.probe", {});
    const seen =
      result.ok && typeof result.value === "string" ? result.value : "";
    const names = new Set(seen.split(","));
    // Core's and connect's bindings and secrets, by name and by value.
    const bindings = [
      "CONNECT",
      "DB",
      "KNOWLEDGE",
      "LOADER",
      "APPS",
      "DATA_STORES",
      "FILES",
      "WORKSPACES",
      "MODEL_GATEWAY",
      "CAPABILITY_SIGNING_KEY",
      "TOKEN_ENCRYPTION_KEY",
      "env",
    ];
    const secrets = [
      env.CAPABILITY_SIGNING_KEY,
      env.BETTER_AUTH_SECRET,
      "access.",
      "refresh.",
      "Bearer",
    ];
    expect({
      probed: seen.length > 0,
      bindings: bindings.filter((name) => names.has(name)),
      secrets: secrets.filter((secret) => seen.includes(secret)),
    }).toStrictEqual({ probed: true, bindings: [], secrets: [] });
  });

  it("stop when the connection permission is revoked", async () => {
    const mailer = await mailerApp();
    await mailer.admin.api.permissions.revoke(mailer.permission);
    expect(outcomeOf(await call(mailer, "mail.inbox", {}))).toStrictEqual({
      failed: "permission.unavailable",
    });
  });

  it("bind only a contract the connection serves, for tools it allows", async () => {
    const narrow = await mailerApp({ tools: ["mail.list"], bind: false });
    const google = await mailerApp({
      contract: "google-workspace.mail@1",
      bind: false,
    });
    expect({
      // The permission doesn't allow `mail.send`.
      narrow: await refusal(narrow),
      // A Microsoft connection serves no Google contract.
      google: await refusal(google),
      // No connector generates it: its version doesn't build.
      unknown: await failure(
        async () =>
          await mailerApp({ files: unknownContractFiles(), bind: false })
      ),
    }).toStrictEqual({
      narrow: "permission.target_invalid",
      google: "permission.target_invalid",
      unknown: "version.build_failed",
    });
  });

  it("offer an admin only the connection permissions that serve the declared actions", async () => {
    const narrow = await mailerApp({ tools: ["mail.list"], bind: false });
    const full = await mailerApp({ bind: false });
    const db = drizzle(env.DB);
    const granted = await db
      .select()
      .from(permissionRows)
      .where(eq(permissionRows.id, full.permission))
      .get();
    const connectionId = granted?.objectId ?? "";
    // On the same connection, the Mailer also holds a permission that
    // doesn't allow `mail.send`, and a copy of its full one that holds in
    // one chat only: neither is offered, nor is the other App's.
    const listOnly = await full.builder.api.permissions.request({
      subject: { type: "app", appId: full.release.manifest.resourceId },
      object: { type: "connection", connectionId },
      actions: ["mail.list"],
      binding: "MAIL_LIST",
    });
    await full.admin.api.permissions.grant(listOnly.id, { version: 1 });
    if (granted !== undefined) {
      await db.insert(permissionRows).values({
        ...granted,
        id: crypto.randomUUID(),
        chatId: crypto.randomUUID(),
      });
    }
    expect({
      narrow: await choicesOf(narrow),
      full: await choicesOf(full),
    }).toStrictEqual({
      // The permission doesn't allow `mail.send`, which the App declares.
      narrow: [
        {
          alias: "mail",
          state: "unbound",
          actions: ["send", "list"],
          choices: { kind: "connector", permissions: [], truncated: false },
        },
      ],
      full: [
        {
          alias: "mail",
          state: "unbound",
          actions: ["send", "list"],
          choices: {
            kind: "connector",
            permissions: [
              {
                permissionId: full.permission,
                connectionId,
                resource: null,
              },
            ],
            truncated: false,
          },
        },
      ],
    });
  });

  it("ask connect once per connection and contract in a review, however many bindings and choices name it", async () => {
    // A second alias of the same contract, bound to the same permission.
    const mailer = await mailerApp({ files: archiveFiles() });
    const app = mailer.release.manifest.resourceId;
    await mailer.admin.api.resourceBindings.approve({
      ...mailer.approval,
      alias: "archive",
    });
    const counted = askCountingEnv();
    const review = await reviewResourceBindings(
      counted.env,
      await mailer.admin.api.whoami(),
      app
    );
    expect({
      states: review.resources.map(({ alias, state }) => [alias, state]),
      offered: review.resources.map(
        ({ choices }) =>
          choices?.kind === "connector" && choices.permissions.length
      ),
      truncated: review.truncated,
      asks: counted.asks(),
    }).toStrictEqual({
      states: [
        ["archive", "served"],
        ["mail", "served"],
      ],
      offered: [1, 1],
      truncated: false,
      asks: 1,
    });
  });

  it("never report a connector binding served when the review's asks run out", async () => {
    const mailer = await mailerApp();
    const counted = askCountingEnv();
    const review = await reviewResourceBindings(
      counted.env,
      await mailer.admin.api.whoami(),
      mailer.release.manifest.resourceId,
      0
    );
    expect({
      states: review.resources.map(({ state }) => state),
      choices: review.resources.map(({ choices }) => choices),
      truncated: review.truncated,
      asks: counted.asks(),
    }).toStrictEqual({
      states: ["unchecked"],
      choices: [{ kind: "connector", permissions: [], truncated: true }],
      truncated: true,
      asks: 0,
    });
  });

  it("name a connector binding's own connection for the App's builder, with no choices", async () => {
    const mailer = await mailerApp();
    const review = await mailer.builder.api.resourceBindings.review(
      mailer.release.manifest.resourceId
    );
    const listed = await mailer.builder.api.connections.list();
    const granted = await drizzle(env.DB)
      .select({ objectId: permissionRows.objectId })
      .from(permissionRows)
      .where(eq(permissionRows.id, mailer.permission))
      .get();
    const connection = listed.find(({ id }) => id === granted?.objectId);
    expect(
      review.resources.map(({ binding, choices }) => ({
        label: binding?.label,
        choices,
      }))
    ).toStrictEqual([
      {
        label: {
          connection: {
            account: connection?.accountName ?? null,
            provider: "microsoft",
          },
        },
        choices: null,
      },
    ]);
  });

  it("say a connector binding no longer serves once its contract changed or its connection is gone", async () => {
    const mailer = await mailerApp();
    const admin = await mailer.admin.api.whoami();
    const app = mailer.release.manifest.resourceId;
    const stateIn = async (reviewEnv: Env) => {
      const review = await reviewResourceBindings(reviewEnv, admin, app);
      return review.resources.map(({ state }) => state);
    };
    const served = await stateIn(env);
    const reshaped = await stateIn(
      servingEnv(withOutput("list", someMessages))
    );
    const listed = await mailer.admin.api.connections.list();
    const shared = listed.find((connection) => connection.scope === "shared");
    await mailer.admin.api.connections.disconnect(shared?.id ?? "");
    expect({
      served,
      reshaped,
      disconnected: await stateIn(env),
    }).toStrictEqual({
      served: ["served"],
      reshaped: ["contract_changed"],
      disconnected: ["grant_lost"],
    });
  });
});
