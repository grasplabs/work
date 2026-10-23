import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { describe, expect, it } from "vite-plus/test";

import { canConnect, signInAgainTarget } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";

// Who is offered Connect: the page shows the button only where core and
// connect would start a flow, so nobody consents to a toolkit that is then
// refused.

const integration = (
  source: Integration["source"],
  id: string,
  auth?: Integration["auth"]
): Integration => ({
  key: `${source}:${id}`,
  source,
  id,
  name: id,
  categories: [],
  group: "Other",
  description: null,
  auth,
  logo: null,
  toolCount: 1,
  offered: true,
  listed: true,
  connections: [],
});

const someone = (role: Identity["role"], staff = false): Identity => ({
  userId: "me",
  email: "me@acme.test",
  name: "Me",
  role,
  teams: [],
  staff,
  expiresAt: "2026-10-18T00:00:00.000Z",
});

describe("connecting from the Integrations page", () => {
  it("is offered for a toolkit an admin connects with Composio's app, and a native provider for anyone", () => {
    expect([
      canConnect(
        integration("composio", "hubspot", "managed"),
        someone("admin")
      ),
      canConnect(
        integration("composio", "hubspot", "managed"),
        someone("user")
      ),
      canConnect(
        integration("native", "microsoft", "managed"),
        someone("user")
      ),
    ]).toStrictEqual([true, false, true]);
  });

  it("isn't offered to anyone for a toolkit that needs the organization's own sign-in app", () => {
    expect([
      canConnect(integration("composio", "acme_erp", "own"), someone("admin")),
      canConnect(integration("composio", "acme_erp", "own"), someone("user")),
    ]).toStrictEqual([false, false]);
  });

  it("is offered as before while connect doesn't say whose app it takes", () => {
    expect(
      canConnect(integration("composio", "hubspot"), someone("admin"))
    ).toBeTruthy();
  });

  it("is never offered to Grasp staff", () => {
    expect(
      canConnect(
        integration("native", "microsoft", "managed"),
        someone("admin", true)
      )
    ).toBeFalsy();
  });
});

const connection = (
  id: string,
  scope: ListedConnection["scope"],
  status: ListedConnection["status"]
): ListedConnection => ({
  id,
  source: "native",
  provider: "microsoft",
  scope,
  status,
  ownerUserId: scope === "personal" ? "me" : null,
  connectedBy: "me",
  connectedByName: "Me",
  accountName: `${id}@acme.test`,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const withConnections = (...connections: ListedConnection[]): Integration => ({
  ...integration("native", "microsoft", "managed"),
  connections,
});

describe("signing in again from an integration's page", () => {
  it("skips an expired shared connection a member can't sign in to again, for their own expired one", () => {
    const page = withConnections(
      connection("shared", "shared", "needs_reauth"),
      connection("mine", "personal", "needs_reauth")
    );
    expect(signInAgainTarget(page, someone("user"))?.id).toBe("mine");
    expect(signInAgainTarget(page, someone("admin"))?.id).toBe("shared");
  });

  it("offers nothing while every connection is active", () => {
    expect(
      signInAgainTarget(
        withConnections(
          connection("shared", "shared", "active"),
          connection("mine", "personal", "active")
        ),
        someone("admin")
      )
    ).toBeUndefined();
  });
});
