import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewBundle, PreviewUpdate } from "@grasp-os/shared/chat";

/** What a preview's build answers: its frame's bundle, or an update. */
export type PreviewBuilt = PreviewBundle | PreviewUpdate;

// The builds of one Workspace object's chats' previews (chats-rpc.ts): one
// build per revision of a chat's draft of an App, shared by everyone who
// asks for it. Several previews of one draft (two tabs, the dock and the
// App's workspace) all ask for the revision they know of; the first ask
// starts its build and every other ask for that revision awaits the same
// one. An ask for a revision the draft moved past is refused
// (`app.preview_outdated`) before anything builds: the asker hears of the
// newer revision from the chat and asks for that. A newer revision's
// build takes the older one's place, which no ask awaits any more and
// which stops on its own. So nothing waits in line, and no frame's ask
// pushes out another's: there is nothing to wait for but the build of
// the draft as it is.
//
// A build runs as the asker's callback, which this object awaits, and
// its answer goes to every ask that shares it. Kept only while it runs:
// once it settled, however it settled, the next ask builds anew (core's
// build cache answers the same files at once), so a failed build never
// stands in for the next.

/** The build running for one preview, and the revision it builds. */
interface Building {
  revision: number;
  built: Promise<PreviewBuilt>;
}

/** The builds of one Workspace object's chats' previews, by preview and ask. */
export class PreviewBuilds {
  readonly #building = new Map<string, Building>();

  /**
   * The answer of the build `key` names (a chat, an App and what is
   * built) at `revision`, the draft's revision `now`: shared with every
   * ask for it while it runs, started by `build` when none does.
   * `app.preview_outdated` for any other revision.
   */
  async build(
    key: string,
    revision: number,
    now: number,
    build: () => Promise<PreviewBuilt>
  ): Promise<PreviewBuilt> {
    if (revision !== now) {
      throw appErrors.create("app.preview_outdated");
    }
    const running = this.#building.get(key);
    if (running?.revision === revision) {
      return await running.built;
    }
    const building: Building = { revision, built: build() };
    this.#building.set(key, building);
    try {
      return await building.built;
    } finally {
      if (this.#building.get(key) === building) {
        this.#building.delete(key);
      }
    }
  }
}
