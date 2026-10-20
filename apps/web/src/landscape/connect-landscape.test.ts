import type { ListedConnection } from "@grasp-os/shared/connect";
import type { LandscapeSyncStatus } from "@grasp-os/shared/landscape";
import { describe, expect, it } from "vite-plus/test";

import { canReconnect } from "../connections/connect-dialog.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import { landscapeOffer } from "./connect-landscape.tsx";
import { landscapeAppsOf } from "./landscape-data.ts";

// Connecting the landscape's own connection, and connecting it again once
// its access ran out: from the Landscape, and from Integrations, by an
// admin only. The connection itself is never one of the landscape's apps.

const status = (
  connection: LandscapeSyncStatus["connection"]
): LandscapeSyncStatus => ({
  connectionId: "connection-entra",
  connection,
  state: "failed",
  reason: "landscape.inactive",
  startedAt: null,
  finishedAt: null,
  wholeAt: null,
});

const landscapeConnection: ListedConnection = {
  id: "connection-entra",
  source: "native",
  provider: "microsoft-landscape",
  scope: "shared",
  status: "needs_reauth",
  ownerUserId: null,
  connectedBy: "user-admin",
  connectedByName: "Ada",
  accountName: "ada@acme.test",
  createdAt: "2026-10-20T10:00:00.000Z",
};

/** Who asks, by role, Grasp staff or not. */
const person = (role: "admin" | "user", staff = false) => ({ role, staff });

describe("the landscape's connection", () => {
  it("is offered to an admin to connect while there is none, and to connect again while it needs it", () => {
    expect({
      unread: landscapeOffer(null),
      none: landscapeOffer({ state: "ready", data: [] }),
      lapsed: landscapeOffer({
        state: "ready",
        data: [status("needs_reauth")],
      }),
      active: landscapeOffer({ state: "ready", data: [status("active")] }),
    }).toStrictEqual({
      unread: null,
      none: "connect",
      lapsed: "reconnect",
      active: null,
    });
  });

  it("is an admin's to connect again from Integrations, though no catalog offers it, and is no app of the landscape", () => {
    const [integration] = integrationsOf([], [landscapeConnection]);
    expect({
      admin: canReconnect(landscapeConnection, false, person("admin")),
      member: canReconnect(landscapeConnection, false, person("user")),
      staff: canReconnect(landscapeConnection, false, person("admin", true)),
      name: integration?.name,
      apps: landscapeAppsOf(integrationsOf([], [landscapeConnection])),
    }).toStrictEqual({
      admin: true,
      member: false,
      staff: false,
      name: "Microsoft Entra (application landscape)",
      apps: [],
    });
  });
});
