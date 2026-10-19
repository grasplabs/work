import type { Identity } from "@grasp-os/shared/rpc";
import { describe, expect, it } from "vite-plus/test";

import { canConnect } from "./connect-dialog.tsx";
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
