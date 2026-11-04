import type { PreviewApplied, PreviewPart } from "@grasp-os/sdk/screen-runtime";
import type { PreviewRefresh, PreviewUpdate } from "@grasp-os/shared/chat";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { screenErrors } from "@grasp-os/shared/screens";

// The page's side of a chat's preview taking its draft's writes in the
// frame it has open (spec 19.2.1): each time the chat says the draft is
// at a newer revision, the page asks core for the previewed screen at
// that revision (`chats.previewUpdate`, which builds each revision once,
// for every preview that asks for it) and hands it to the frame over the
// frame's own bridge, in parts, which the frame checks, evaluates and
// swaps in with React Fast Refresh (@grasp-os/sdk's preview-updates.ts).
// The frame isn't started again, so what the screen holds stays.
//
// The page decides what the frame is handed, never the frame:
// - only an update core answered for the App the frame was opened for,
//   and only of a revision past the one the frame shows: one asked at a
//   time, then the newest the chat named while it was asked;
// - each update's size and SHA-256 as core answered them, which the
//   frame checks the module against before evaluating anything;
// - nothing the frame couldn't load as it is: an update that needs a kit
//   module the frame didn't load (its import map is fixed), or past the
//   revisions and bytes one frame takes (`previewResetRevisions`,
//   `previewResetBytes`, spec 18.1), starts the frame afresh instead.
//
// When an update doesn't build, doesn't evaluate or fails to render, or
// the screen reports a problem, the frame keeps showing the last version
// that worked and the page shows that the problem is being fixed: the
// agent hears of it from the preview's reports (core's
// preview-reports.ts), never the person as a stack trace.

/**
 * The most characters of a module one part carries: well within what the
 * frame's port holds unread (`screenLimits.portQueue`).
 */
export const previewPartChars = 128 * 1024;

/** What the preview shows besides the screen: whether a problem is being fixed. */
export type PreviewHealth = "working" | "fixing";

/** What the page does for a preview's updates. */
export interface PreviewUpdatesHost {
  /** Asks core for the previewed screen of the draft at `revision`. */
  fetch: (revision: number) => Promise<PreviewUpdate>;
  /** Says whether a problem of the preview is being fixed. */
  health: (health: PreviewHealth) => void;
  /** Starts the frame afresh: an update can't come in through Refresh. */
  reset: () => void;
  /** The frame shows `revision` now: what its calls name. */
  moved: (revision: number) => void;
}

/** What the frame's receiver answers each part with. */
type FrameReceiver = (part: PreviewPart) => Promise<PreviewApplied>;

/** `refresh` in parts of at most `previewPartChars` characters of its code. */
export const partsOf = (refresh: PreviewRefresh): PreviewPart[] => {
  const { revision, code, bytes, sha256, css } = refresh;
  const parts = Math.max(1, Math.ceil(code.length / previewPartChars));
  return Array.from({ length: parts }, (_, part) => ({
    revision,
    part,
    parts,
    code: code.slice(part * previewPartChars, (part + 1) * previewPartChars),
    bytes,
    sha256,
    // The CSS once, with the last part.
    css: part === parts - 1 ? css : "",
  }));
};

/** The bytes a frame holds once it evaluated `refresh`: its module and its CSS. */
const loadedBytes = (refresh: PreviewRefresh): number =>
  refresh.bytes + refresh.css.length;

/**
 * What handing the frame `update` may make it evaluate, at most: the
 * update itself, and, should it fail to render, a copy of `applied`, the
 * last that rendered, swapped back in (@grasp-os/sdk's preview-updates.ts).
 * A frame keeps every module it evaluated, so each counts, whether it
 * worked or not.
 */
const mostEvaluated = (
  update: PreviewRefresh,
  applied: PreviewRefresh
): { modules: number; bytes: number } => ({
  modules: 2,
  bytes: loadedBytes(update) + loadedBytes(applied),
});

/** Why core's answer can't come in through Refresh, if it can't. */
const resetNeeded = (
  update: PreviewRefresh,
  applied: PreviewRefresh,
  kit: ReadonlySet<string>,
  evaluated: { modules: number; bytes: number }
): boolean => {
  const most = mostEvaluated(update, applied);
  return (
    update.kit.some((name) => !kit.has(name)) ||
    evaluated.modules + most.modules > platformLimits.previewResetRevisions ||
    evaluated.bytes + most.bytes > platformLimits.previewResetBytes
  );
};

/**
 * Follows the draft's revisions for one open frame of a preview of
 * `app`, opened at `opened`.
 */
export class PreviewUpdates {
  readonly #app: string;
  readonly #opened: PreviewRefresh;
  readonly #host: PreviewUpdatesHost;
  /** The kit modules the frame loaded: all an update may import. */
  readonly #kit: ReadonlySet<string>;
  #toFrame: FrameReceiver | undefined;
  /** The revision the frame shows. */
  #shown: number;
  /** The newest revision the chat named. */
  #wanted: number;
  /** The newest revision asked for, whatever came of it. */
  #asked: number;
  #asking = false;
  #closed = false;
  /** The revision the frame is trying now, while it is handed one. */
  #trying: number | undefined;
  /** Whether the frame reported a problem while trying the update it is handed. */
  #troubled = false;
  #health: PreviewHealth = "working";
  /** The update the frame shows: the last that rendered. */
  #applied: PreviewRefresh;
  /**
   * What the frame evaluated since it started, which bounds it (spec 18.1,
   * `previewResetRevisions`, `previewResetBytes`): every update handed
   * over and every copy swapped back in, as modules and bytes.
   */
  readonly #evaluated = { modules: 0, bytes: 0 };

  constructor(app: string, opened: PreviewRefresh, host: PreviewUpdatesHost) {
    this.#app = app;
    this.#opened = opened;
    this.#applied = opened;
    this.#host = host;
    this.#kit = new Set(opened.kit);
    this.#shown = opened.revision;
    this.#wanted = opened.revision;
    this.#asked = opened.revision;
  }

  /**
   * The frame's receiver, once it handed it over: first given the screen
   * as the frame opened it, the version it swaps back to should the next
   * fail to render; then whatever the chat named since.
   */
  follow(toFrame: FrameReceiver): void {
    if (this.#toFrame !== undefined || this.#closed) {
      return;
    }
    this.#toFrame = toFrame;
    void this.#run(this.#opened);
  }

  /** The chat says the draft is at `revision` now. */
  revise(revision: number): void {
    if (revision > this.#wanted) {
      this.#wanted = revision;
      void this.#run();
    }
  }

  /** The frame reported a problem: it is being fixed. */
  problem(): void {
    // Raised while the frame tries an update: that update has it, even
    // once it is applied (it rendered nothing, or logged an error).
    if (this.#trying !== undefined) {
      this.#troubled = true;
    }
    this.#say("fixing");
  }

  /**
   * The revision of the screen code the frame runs now: the one it is
   * trying while it is handed an update (its first render and mount
   * effects run then, and its failure is reported before the frame
   * answers and rolls back), or else the one it shows. What the frame
   * calls and reports names it, and core files a problem, or a screen
   * seen, only under the draft's own revision: an update that failed
   * fails that revision's check, and an earlier screen's never does.
   */
  runningAt(): number {
    return this.#trying ?? this.#shown;
  }

  /** Stops following: the frame is gone. */
  close(): void {
    this.#closed = true;
  }

  #say(health: PreviewHealth): void {
    if (!this.#closed && health !== this.#health) {
      this.#health = health;
      this.#host.health(health);
    }
  }

  /**
   * Hands the frame `first`, if given, then asks for and hands it the
   * newest revision the chat named until none is newer than the last
   * asked for: one at a time.
   */
  async #run(first?: PreviewRefresh): Promise<void> {
    if (this.#asking || this.#toFrame === undefined) {
      return;
    }
    this.#asking = true;
    try {
      if (first !== undefined && !(await this.#hand(first))) {
        return;
      }
      while (!this.#closed && this.#wanted > this.#asked) {
        this.#asked = this.#wanted;
        // oxlint-disable-next-line no-await-in-loop -- one update at a time
        const update = await this.#ask(this.#asked);
        if (update === undefined) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- one update at a time
        if (!(await this.#hand(update))) {
          return;
        }
      }
    } finally {
      this.#asking = false;
    }
  }

  /**
   * Core's answer for the draft at `revision`, the newest the chat named,
   * or undefined when there is none to hand. Core builds each revision
   * once, for every preview that asks for it.
   */
  async #ask(revision: number): Promise<PreviewRefresh | undefined> {
    let answered: PreviewUpdate;
    try {
      answered = await this.#host.fetch(revision);
    } catch (error) {
      // Its code doesn't build: the frame keeps what it shows.
      if (screenErrors.codeOf(error) === "screen.build_failed") {
        this.#say("fixing");
      }
      // Anything else (the draft moved past it, core out of reach) is
      // asked for at the chat's next revision, which it says.
      return undefined;
    }
    // Only the App the frame was opened for, and only a revision past
    // the one it shows.
    if (
      answered.app !== this.#app ||
      answered.refresh.revision <= this.#shown
    ) {
      return undefined;
    }
    // What core had when it built: one the chat named since is asked for.
    this.#asked = answered.refresh.revision;
    return answered.refresh;
  }

  /** Hands the frame `update`, in parts: false once it is started afresh. */
  async #hand(update: PreviewRefresh): Promise<boolean> {
    const toFrame = this.#toFrame;
    if (toFrame === undefined || this.#closed) {
      return false;
    }
    if (resetNeeded(update, this.#applied, this.#kit, this.#evaluated)) {
      this.#reset();
      return false;
    }
    let answer: PreviewApplied = "refused";
    this.#trying = update.revision;
    this.#troubled = false;
    try {
      for (const part of partsOf(update)) {
        // oxlint-disable-next-line no-await-in-loop -- parts in order
        answer = await toFrame(part);
        if (answer !== "more") {
          break;
        }
      }
    } catch {
      // The frame's bridge is gone: the frame is stopped as it is.
      return false;
    } finally {
      this.#trying = undefined;
    }
    this.#count(update, answer);
    if (answer === "reset") {
      this.#reset();
      return false;
    }
    if (answer !== "applied") {
      // Not taken: the frame shows the last version that worked.
      this.#say("fixing");
      return true;
    }
    this.#applied = update;
    if (update.revision !== this.#shown) {
      this.#shown = update.revision;
      this.#host.moved(update.revision);
    }
    // Working once an update shows without a problem of its own: one it
    // reported as it came in keeps the problem being fixed.
    if (!this.#troubled) {
      this.#say("working");
    }
    return true;
  }

  /**
   * Counts what the frame evaluated handing it `update`, answered
   * `answer`: nothing for an update it refused unread; the update for one
   * it took; for one that failed, the update and a copy of the last that
   * rendered, as one that rendered with an error is swapped back (the
   * frame doesn't say which way it failed, so the most it may have).
   */
  #count(update: PreviewRefresh, answer: PreviewApplied): void {
    if (answer === "refused" || answer === "more") {
      return;
    }
    const most = mostEvaluated(update, this.#applied);
    if (answer === "failed") {
      this.#evaluated.modules += most.modules;
      this.#evaluated.bytes += most.bytes;
      return;
    }
    this.#evaluated.modules += 1;
    this.#evaluated.bytes += loadedBytes(update);
  }

  #reset(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#host.reset();
    }
  }
}
