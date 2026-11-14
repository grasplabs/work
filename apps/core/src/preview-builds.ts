import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewBundle, PreviewUpdate } from "@grasp-os/shared/chat";

/** What a preview's build answers: its frame's bundle, or an update. */
export type PreviewBuilt = PreviewBundle | PreviewUpdate;

// The builds of one App's previews (app-preview-rpc.ts): one build per
// viewer and revision of the App's draft, shared by every ask of theirs
// for it (each viewer's frame is staged as theirs, page-frame.ts).
// Several previews of one draft (two tabs, the dock and the
// App's workspace) all ask for the revision they know of; the first ask
// starts its build and every other ask for that revision awaits the same
// one. An ask for a revision the draft moved past is refused
// (`app.preview_outdated`) before anything builds: the asker hears of the
// newer revision from its preview's watch and asks for that. A newer revision's
// build takes the older one's place, which no ask awaits any more and
// which stops on its own. So nothing waits in line, and no frame's ask
// pushes out another's: there is nothing to wait for but the build of
// the draft as it is.
//
// A build runs as the asker's callback, which this object awaits, and
// its answer goes to every ask that shares it. Kept only while it runs:
// once it settled, however it settled, the next ask builds anew (core's
// build cache answers the same files at once, a failed build too), so a
// failed build never stands in for the next. An ask that only shared a
// build that failed asks again once (`build`): the asker that started it
// may have gone mid-build, taking its callback with it.

/** The build running for one preview, and the revision it builds. */
interface Building {
  revision: number;
  built: Promise<PreviewBuilt>;
}

/** The builds of one App's previews, by viewer and ask. */
export class PreviewBuilds {
  readonly #building = new Map<string, Building>();

  /**
   * The answer of the build `key` names (a viewer and what is built)
   * at `revision`, the draft's revision `now`: shared with every ask for
   * it while it runs, started by `build` when none does.
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
    const joined = this.#building.get(key)?.revision === revision;
    try {
      return await this.#shared(key, revision, build);
    } catch (error) {
      // A build this ask only joined runs as another asker's callback,
      // which goes when that asker does (a tab closed mid-build): its
      // failure may be nothing of this ask's. So, once, it asks again: the
      // first ask to do so builds anew, and the others share that build.
      // One that started the build hears how it failed.
      if (!joined) {
        throw error;
      }
      return await this.#shared(key, revision, build);
    }
  }

  /**
   * The build running for `key` at `revision`, or one `build` starts now,
   * kept until it settles, however it settles.
   */
  async #shared(
    key: string,
    revision: number,
    build: () => Promise<PreviewBuilt>
  ): Promise<PreviewBuilt> {
    const running = this.#building.get(key);
    if (running?.revision === revision) {
      return await running.built;
    }
    const building: { current?: Building } = {};
    const run = async (): Promise<PreviewBuilt> => {
      try {
        return await build();
      } finally {
        if (this.#building.get(key) === building.current) {
          this.#building.delete(key);
        }
      }
    };
    building.current = { revision, built: run() };
    this.#building.set(key, building.current);
    return await building.current.built;
  }
}
