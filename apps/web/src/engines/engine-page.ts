import type { App, AppContents } from "@grasp-os/shared/apps";
import type { DependencyApprovals } from "@grasp-os/shared/dependencies";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

/** An engine as its members read it: the App and what it holds. */
export interface EnginePage {
  app: App;
  contents: AppContents;
}

const readEngine = async (
  session: Session,
  engine: string
): Promise<EnginePage> => {
  const [found, contents] = await Promise.all([
    session.apps.get(engine),
    session.apps.contents(engine),
  ]);
  return { app: found, contents };
};

/** What the engine's page reads of the engine itself, and of its packages. */
export interface EngineReads {
  page: Loaded<EnginePage>;
  /**
   * Not awaited: the early read that says whether someone who doesn't
   * build may see the engine's packages (their tab). None for a builder,
   * whose tab is there from the start.
   */
  packages: Promise<Loaded<DependencyApprovals>> | undefined;
  /**
   * Not awaited: the packages alone, for someone core doesn't let read the
   * engine (not a member); none when the engine itself was read.
   */
  packagesOnly: Promise<Loaded<DependencyApprovals>> | undefined;
}

/** What the engine's page reads from core, each as core answers it. */
export interface EngineReaders {
  /** The engine itself, for its members. */
  engine: () => Promise<Loaded<EnginePage>>;
  /** Its approved packages, for whoever core lets list them. */
  approvals: () => Promise<Loaded<DependencyApprovals>>;
}

/** The readers of engine `engine` over `core`, on the signed-in person's session. */
export const engineReaders = (
  core: CoreConnection,
  engine: string
): EngineReaders => ({
  engine: async () =>
    await loadFromCore(
      core,
      async (session) => await readEngine(session, engine)
    ),
  approvals: async () =>
    await loadFromCore(
      core,
      async (session) => await session.dependencies.approvals({ app: engine })
    ),
});

/**
 * Reads an engine for its page with `read`. Someone core doesn't let read
 * it (not a member) may still list its approved packages: whoever holds
 * `dependencies.approve`, whatever their organization role, a builder of
 * other engines too. So their approvals are read for anyone not let in,
 * and core alone decides whether they are listed.
 */
export const loadEnginePage = async (
  read: EngineReaders,
  builds: boolean
): Promise<EngineReads> => {
  const packages = builds ? undefined : read.approvals();
  const page = await read.engine();
  return {
    page,
    packages,
    packagesOnly:
      page.state === "missing" ? (packages ?? read.approvals()) : undefined,
  };
};
