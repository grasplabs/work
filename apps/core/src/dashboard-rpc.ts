import {
  dashboardErrors,
  dashboardLayoutSchema,
} from "@grasp-os/shared/dashboard";
import type {
  BoardReport,
  DashboardApi,
  DashboardLayout,
} from "@grasp-os/shared/dashboard";
import { errorFields, log } from "@grasp-os/shared/log";
import type {
  CustomWidget,
  WidgetMade,
  WidgetProgress,
} from "@grasp-os/shared/widgets";

import { boardReportOf } from "./board-report.ts";
import type { BoardReportSources } from "./board-report.ts";
import {
  customWidgetsOf,
  dashboardWork,
  makeWidget,
  removeWidget,
} from "./dashboard-widgets.ts";
import { workspace } from "./durable-objects.ts";
import { isStub } from "./page-callbacks.ts";
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
// removing a widget is, with each model call. Its weekly report is read
// through the session's other namespaces (board-report.ts). While Grasp
// makes or changes a widget, the page that asked is told how it goes
// (`progressTo`), as a chat streams its answer.

/**
 * The page's `onProgress`, as a function the widget's making can call for
 * as long as the call lasts, and let go of once it ends: it passes on
 * progress only, never waits for the page, and stops telling once the
 * page didn't take it. Anything but a function of the page's is none.
 */
const progressTo = (
  onProgress: unknown
):
  | {
      tell: (progress: WidgetProgress) => void;
      [Symbol.dispose]: () => void;
    }
  | undefined => {
  if (!isStub(onProgress)) {
    return undefined;
  }
  const toPage = onProgress.dup();
  let live = true;
  return {
    tell: (progress) => {
      if (!live) {
        return;
      }
      // In order, as Cap'n Web sends calls; nothing waits for the page.
      void (async () => {
        try {
          await toPage(progress);
        } catch (error) {
          live = false;
          log.info("dashboard.progress_dropped", errorFields(error));
        }
      })();
    },
    [Symbol.dispose]: () => {
      live = false;
      toPage[Symbol.dispose]();
    },
  };
};

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

  async widgets(): Promise<CustomWidget[]> {
    return await withPerson(
      this.#check,
      async (person) => await customWidgetsOf(this.#env, person)
    );
  }

  async makeWidget(
    request: string,
    onProgress?: (progress: WidgetProgress) => void
  ): Promise<WidgetMade> {
    return await withPerson(this.#check, async (person) => {
      using progress = progressTo(onProgress);
      return await makeWidget(
        this.#env,
        {
          member: person,
          trigger: { type: "person", userId: person.userId },
          work: dashboardWork,
          requestId: crypto.randomUUID(),
        },
        request,
        undefined,
        progress?.tell
      );
    });
  }

  async changeWidget(
    id: string,
    request: string,
    onProgress?: (progress: WidgetProgress) => void
  ): Promise<WidgetMade> {
    return await withPerson(this.#check, async (person) => {
      using progress = progressTo(onProgress);
      return await makeWidget(
        this.#env,
        {
          member: person,
          trigger: { type: "person", userId: person.userId },
          work: dashboardWork,
          requestId: crypto.randomUUID(),
        },
        request,
        id,
        progress?.tell
      );
    });
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
