import { describe, expect, it } from "vite-plus/test";

import { commitApp } from "./app-definitions.ts";
import { mockIdpWith } from "./idp.ts";
import {
  call,
  confirmAll,
  contactsApp,
  crmAnswers,
  crmConnection,
  crmRules,
  crmTools,
  failure,
  idp,
  listArguments,
  outcomeOf,
  twoCrmFiles,
} from "./resource-connectors-harness.ts";
import type { CrmConnection } from "./resource-connectors-harness.ts";
import { signedInApi } from "./sign-in.ts";

// An App's connector resources reach an outside system only through
// connect, under a binding an admin approved and the App's own connection
// permission, checked against the generated connector contract both ways
// (spec 12). This runs the real connect and its native Microsoft 365
// connector, with only Microsoft's sign-in and Graph faked.

mockIdpWith(idp);

describe("Composio connector resource bindings", { timeout: 120_000 }, () => {
  it("read through connect, under a contract generated from the connection's own server", async () => {
    const app = await contactsApp();
    const listed = await call(app, "crm.contacts", {});
    expect({
      listed: outcomeOf(listed),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      listed: 0,
      ran: [{ tool: "CRM_LIST_CONTACTS", arguments: { limit: 5 } }],
    });
  });

  it("refuse an argument the tool doesn't name before Composio sees it", async () => {
    const app = await contactsApp();
    const result = await call(app, "crm.sloppy", {});
    expect({
      outcome: outcomeOf(result),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      outcome: { failed: "permission.invalid_args" },
      ran: [],
    });
  });

  it("stop once Composio changes a tool, until an admin approves the binding again", async () => {
    const app = await contactsApp();
    await app.crm.serve({
      list: crmTools({
        listProperties: { ...listArguments, archived: { type: "boolean" } },
      }),
    });
    const drifted = await call(app, "crm.contacts", {});
    const ranWhileDrifted = await app.crm.ran();
    await app.approve();
    const approvedAgain = await call(app, "crm.contacts", {});
    expect({
      drifted: outcomeOf(drifted),
      ranWhileDrifted,
      approvedAgain: outcomeOf(approvedAgain),
    }).toStrictEqual({
      drifted: { failed: "permission.unavailable" },
      ranWhileDrifted: [],
      approvedAgain: 0,
    });
  });

  it("stop once the admin's rules for a tool change, or the tool leaves the allowlist", async () => {
    const app = await contactsApp();
    await app.crm.allow(crmRules(false));
    const notARead = await call(app, "crm.contacts", {});
    await app.crm.allow(["CRM_CREATE_CONTACT"]);
    const notAllowed = await call(app, "crm.contacts", {});
    expect({
      notARead: outcomeOf(notARead),
      notAllowed: outcomeOf(notAllowed),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      notARead: { failed: "permission.unavailable" },
      notAllowed: { failed: "permission.unavailable" },
      ran: [],
    });
  });

  it("refuse an answer with more than the tool promises", async () => {
    const app = await contactsApp();
    await app.crm.serve({ answers: crmAnswers({ contacts: [], total: 0 }) });
    expect(outcomeOf(await call(app, "crm.contacts", {}))).toStrictEqual({
      failed: "contract.invalid_permission_result",
    });
  });

  it("hold a tool the admin didn't mark as a read, whatever Composio says of it, and answer its text", async () => {
    const app = await contactsApp();
    const input = { email: "ada@acme.test" };
    const held = await call(app, "crm.create", input, "create-1");
    const ranWhileHeld = await app.crm.ran();
    await confirmAll(app);
    const answered = await call(app, "crm.create", input, "create-1");
    expect({
      held: outcomeOf(held),
      ranWhileHeld,
      answered: outcomeOf(answered),
    }).toStrictEqual({
      held: { failed: "permission.awaiting_confirmation" },
      ranWhileHeld: [],
      answered: "Created contact-1",
    });
  });

  it("keep a held write waiting while Composio can't be reached to confirm it, and run it once it can", async () => {
    const app = await contactsApp();
    const input = { email: "grace@acme.test" };
    await call(app, "crm.create", input, "create-2");
    const [held] = await app.builder.api.pendingActions.list();
    if (held === undefined) {
      throw new Error("Expected a held action");
    }
    await app.crm.unavailable();
    const whileDown = await failure(
      async () =>
        await app.builder.api.pendingActions.confirm(held.id, held.inputHash)
    );
    const stillWaiting = await app.builder.api.pendingActions.list();
    await app.builder.api.pendingActions.confirm(held.id, held.inputHash);
    const answered = await call(app, "crm.create", input, "create-2");
    expect({
      whileDown,
      stillWaiting: stillWaiting.map(({ id }) => id),
      answered: outcomeOf(answered),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      whileDown: "permission.unavailable",
      stillWaiting: [held.id],
      answered: "Created contact-1",
      ran: [{ tool: "CRM_CREATE_CONTACT", arguments: input }],
    });
  });

  it("bind no tool whose answer is open, and no contract while Composio can't be reached", async () => {
    const open = await contactsApp({
      bind: false,
      before: async (crm) => {
        await crm.serve({ list: crmTools({ listOutput: { type: "object" } }) });
      },
    });
    const app = await contactsApp();
    await app.crm.unavailable();
    const unreachable = await call(app, "crm.contacts", {});
    expect({
      open: await failure(open.approve),
      unreachable: outcomeOf(unreachable),
      ran: await app.crm.ran(),
    }).toStrictEqual({
      open: "permission.target_invalid",
      unreachable: { failed: "permission.unavailable" },
      ran: [],
    });
  });

  it("review the rest of an App's resources while one CRM's Composio server can't be reached, marking only that CRM unchecked", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const created = await builder.api.apps.create({ name: "Two CRMs" });
    await commitApp(builder.api.apps.files, created.id, twoCrmFiles(), "First");
    await builder.api.apps.versions.publish(created.id, 1);
    const down = await crmConnection();
    const up = await crmConnection();
    const granted = async (crm: CrmConnection, binding: string) => {
      const requested = await builder.api.permissions.request({
        subject: { type: "app", appId: created.id },
        object: { type: "connection", connectionId: crm.id },
        actions: ["CRM_LIST_CONTACTS"],
        binding,
      });
      await admin.api.permissions.grant(requested.id, { version: 1 });
      return requested.id;
    };
    const downPermission = await granted(down, "CRM");
    const upPermission = await granted(up, "BACKUP");
    const approve = async (alias: string, permissionId: string) =>
      await admin.api.resourceBindings.approve({
        app: created.id,
        alias,
        target: { kind: "connector", permissionId },
        reviewed: { version: 1 },
      });
    await approve("crm", downPermission);
    await approve("backup", upPermission);
    await down.unavailable();
    const review = await admin.api.resourceBindings.review(created.id);
    // Each CRM is offered the reachable permission; the unreachable one is
    // neither offered nor ruled out, so the choices say they are partial.
    const offered = {
      kind: "connector",
      permissions: [
        { permissionId: upPermission, connectionId: up.id, resource: null },
      ],
      truncated: true,
    };
    expect({
      resources: review.resources.map(({ alias, state, choices }) => ({
        alias,
        state,
        choices,
      })),
      truncated: review.truncated,
    }).toStrictEqual({
      resources: [
        { alias: "backup", state: "served", choices: offered },
        { alias: "crm", state: "unchecked", choices: offered },
      ],
      truncated: false,
    });
  });
});
