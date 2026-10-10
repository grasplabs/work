import {
  dashboardErrors,
  dashboardLayoutSchema,
} from "@grasp-os/shared/dashboard";
import type { DashboardApi, DashboardLayout } from "@grasp-os/shared/dashboard";
import { RpcTarget } from "capnweb";

import { personalWorkspaceId } from "./chats-rpc.ts";
import { workspace } from "./durable-objects.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A signed-in person's own dashboard, over `/rpc`: which of the board's
// widgets are on it, in what order. Kept in their own Workspace object,
// next to their chats, reached only with the signed-in person as the
// session check hands them over, so nobody reads or saves another's.
// Not audited: it changes what one person sees of what they may already
// see, as marking notifications read does.

/** The signed-in person's dashboard. */
export class DashboardRpc extends RpcTarget implements DashboardApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async layout(): Promise<DashboardLayout | null> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await workspace(this.#env, personalWorkspaceId(userId)).dashboardLayout(
          userId
        )
    );
  }

  async saveLayout(layout: DashboardLayout): Promise<void> {
    await withPerson(this.#check, async ({ userId }) => {
      const { widgets } = dashboardErrors.parse(
        "dashboard.invalid_layout",
        dashboardLayoutSchema,
        layout
      );
      await workspace(
        this.#env,
        personalWorkspaceId(userId)
      ).saveDashboardLayout(userId, widgets);
    });
  }
}
