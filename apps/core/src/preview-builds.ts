import { appErrors } from "@grasp-os/shared/apps";
import { platformLimits } from "@grasp-os/shared/platform-limits";

// The builds of one Workspace object's chats' previews (chats-rpc.ts):
// spec 18.1 holds each chat's preview of an App to
// `previewBuildsRunning` builds at once and `previewBuildsWaiting`
// waiting, so no tab or caller starts a compile and a seal of its own
// for every ask. A newer ask takes the place of the oldest one waiting,
// which is refused (`app.preview_superseded`): the newest draft is what
// gets built.
//
// A build runs as the caller's callback, which this object awaits, so
// its place lasts exactly as long as the build: a caller that goes away
// ends the call it is in, and with it the callback, and its place is
// free. No lease, and no clock.

/** One chat's preview of one App: the builds running, and those waiting their turn. */
interface Line {
  running: number;
  waiting: ((go: boolean) => void)[];
}

/** The lines of one Workspace object's chats' previews, by chat and App. */
export class PreviewBuilds {
  readonly #lines = new Map<string, Line>();

  /**
   * Runs `build` for the preview `key` names once a place is free;
   * `app.preview_superseded` when a newer ask took its place first.
   */
  async run(key: string, build: () => Promise<void>): Promise<void> {
    const line = this.#lines.get(key) ?? { running: 0, waiting: [] };
    this.#lines.set(key, line);
    if (line.running >= platformLimits.previewBuildsRunning) {
      if (line.waiting.length >= platformLimits.previewBuildsWaiting) {
        line.waiting.shift()?.(false);
      }
      const turn = Promise.withResolvers<boolean>();
      line.waiting.push(turn.resolve);
      if (!(await turn.promise)) {
        throw appErrors.create("app.preview_superseded");
      }
    } else {
      line.running += 1;
    }
    try {
      await build();
    } finally {
      this.#pass(key, line);
    }
  }

  /** Gives the place a build held to the next waiting, or frees it. */
  #pass(key: string, line: Line): void {
    const next = line.waiting.shift();
    if (next !== undefined) {
      next(true);
      return;
    }
    line.running -= 1;
    if (line.running === 0) {
      this.#lines.delete(key);
    }
  }
}
