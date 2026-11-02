import {
  agentIdSchema,
  appIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import { objectOf } from "./pending.tsx";

const app = "11111111-1111-4111-8111-111111111111";

/** An agent's request to call `app`'s functions with `actions`. */
const onApp = (actions: string[]): Permission => ({
  id: permissionIdSchema.parse(crypto.randomUUID()),
  subject: { type: "agent", agentId: agentIdSchema.parse("agent") },
  object: { type: "app", appId: appIdSchema.parse(app) },
  actions,
  binding: "APP",
  status: "requested",
  requestedBy: "person",
  requestedAt: "2026-10-22T00:00:00.000Z",
  grantedBy: null,
  grantedAt: null,
  revokedBy: null,
  revokedAt: null,
  requestedVia: null,
  chat: null,
});

const directory = { people: new Map(), apps: new Map() };

describe("a pending request on an App", () => {
  it("says which of the App's functions each action calls, and no more", () => {
    expect(
      [["read"], ["write"], ["read", "write"]].map((actions) =>
        objectOf(onApp(actions), directory)
      )
    ).toStrictEqual([
      expect.stringMatching(/^Queries of /u),
      expect.stringMatching(/^Mutations and actions of /u),
      expect.stringMatching(/^Queries, mutations and actions of /u),
    ]);
  });
});
