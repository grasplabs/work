import {
  dashboardErrors,
  dashboardLayoutSchema,
} from "@grasp-os/shared/dashboard";
import type {
  BoardReport,
  DashboardApi,
  DashboardLayout,
} from "@grasp-os/shared/dashboard";

import { boardReportOf } from "./board-report.ts";
import type { BoardReportSources } from "./board-report.ts";
import { personalWorkspaceId } from "./chats-rpc.ts";
import { workspace } from "./durable-objects.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A signed-in person's own dashboard, over `/rpc`: which of the board's
// widgets are on it, in what order. Kept in their own Workspace object,
// next to their chats, reached only with the signed-in person as the
// session check hands them over, so nobody reads or saves another's.
// Not audited: it changes what one person sees of what they may already
// see, as marking notifications read does. Its weekly report is read
// through the session's other namespaces (board-report.ts).

/** The signed-in person's dashboard. */
export class DashboardRpc extends CoreRpcTarget implements DashboardApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #sources: BoardReportSources;

  constructor(env: Env, check: SessionCheck, sources: BoardReportSources) {
    super();
    this.#env = env;
    this.#check = check;
    this.#sources = sources;
  }

  async report(): Promise<BoardReport> {
    return await withPerson(
      this.#check,
      async (person) => await boardReportOf(this.#sources, person)
    );
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
