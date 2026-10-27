import {
  dashboardErrors,
  dashboardLayoutSchema,
} from "@grasp-os/shared/dashboard";
import type { DashboardApi, DashboardLayout } from "@grasp-os/shared/dashboard";
import type { CustomWidget, WidgetMade } from "@grasp-os/shared/widgets";

import {
  customWidgetsOf,
  dashboardWork,
  makeWidget,
  removeWidget,
} from "./dashboard-widgets.ts";
import { workspace } from "./durable-objects.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A signed-in person's own dashboard, over `/rpc`: which of the board's
// widgets are on it, in what order, and the widgets Grasp made for them
// (dashboard-widgets.ts). Kept in their own Workspace object, next to
// their chats, reached only with the signed-in person as the session
// check hands them over, so nobody reads or saves another's. Their
// layout isn't audited: it changes what one person sees of what they may
// already see, as marking notifications read does. Making, changing and
// removing a widget is, with each model call.

/** The signed-in person's dashboard. */
export class DashboardRpc extends CoreRpcTarget implements DashboardApi {
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

  async widgets(): Promise<CustomWidget[]> {
    return await withPerson(
      this.#check,
      async (person) => await customWidgetsOf(this.#env, person)
    );
  }

  async makeWidget(request: string): Promise<WidgetMade> {
    return await withPerson(
      this.#check,
      async (person) =>
        await makeWidget(
          this.#env,
          {
            member: person,
            trigger: { type: "person", userId: person.userId },
            work: dashboardWork,
            requestId: crypto.randomUUID(),
          },
          request
        )
    );
  }

  async changeWidget(id: string, request: string): Promise<WidgetMade> {
    return await withPerson(
      this.#check,
      async (person) =>
        await makeWidget(
          this.#env,
          {
            member: person,
            trigger: { type: "person", userId: person.userId },
            work: dashboardWork,
            requestId: crypto.randomUUID(),
          },
          request,
          id
        )
    );
  }

  async removeWidget(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await removeWidget(this.#env, person, id, {
        type: "person",
        userId: person.userId,
      });
    });
  }
}
