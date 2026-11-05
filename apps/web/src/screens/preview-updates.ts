import type { PreviewApplied, PreviewLoad } from "@grasp-os/sdk/screen-runtime";
import type { PreviewRefresh, PreviewUpdate } from "@grasp-os/shared/chat";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { screenErrors } from "@grasp-os/shared/screens";

// The page's side of a chat's preview taking its draft's writes in the
// frame it has open (spec 19.2.1): each time the chat says the draft is
// at a newer revision, the page asks core for the previewed screen at
// that revision (`chats.previewUpdate`, which builds each revision once,
// for every preview that asks for it, and stages its modules) and hands
// the frame the address of the screen's module over the frame's own
// bridge; the frame imports it, loading from core only the modules the
// write changed, and swaps it in with React Fast Refresh (@grasp-os/sdk's
// preview-updates.ts). The frame isn't started again, so what the screen
// holds stays.
//
// The page decides what the frame is handed, never the frame:
// - only an update core answered for the App the frame was opened for,
//   and only of a revision past the one the frame shows: one asked at a
//   time, then the newest the chat named while it was asked;
// - when an update would import a module the frame evaluated before but
//   no longer runs (an update back to an earlier write, or the version
//   swapped back after one failed to render), a new visit, under which
//   the frame evaluates every module afresh: a browser evaluates one
//   address once, and Refresh takes only code evaluated anew;
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

/** What the frame's receiver answers each version with. */
type FrameReceiver = (load: PreviewLoad) => Promise<PreviewApplied>;

/**
 * What the frame holds of its modules: the visit it imports in, the
 * modules it evaluated in it, and those of the version it runs.
 */
interface Evaluated {
  visit: number;
  seen: Set<string>;
  running: ReadonlySet<string>;
}

/**
 * The bytes the frame evaluates loading `version` with `seen` evaluated
 * already: the modules it hasn't, and the CSS.
 */
const newBytes = (
  version: PreviewRefresh,
  seen: ReadonlySet<string> = new Set()
): number => {
  let bytes = version.css.length;
  for (const [address, size] of Object.entries(version.modules)) {
    if (!seen.has(address)) {
      bytes += size;
    }
  }
  return bytes;
};

/**
 * Follows the draft's revisions for one open frame of a preview of
 * `app`, opened at `opened`.
 */
export class PreviewUpdates {
  readonly #app: string;
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
  #evaluated: Evaluated;
  /**
   * What the frame took since it started, which bounds it (spec 18.1,
   * `previewResetRevisions`, `previewResetBytes`): every version handed
   * over, and the bytes of every module it evaluated and every CSS.
   */
  readonly #taken = { revisions: 0, bytes: 0 };

  constructor(app: string, opened: PreviewRefresh, host: PreviewUpdatesHost) {
    this.#app = app;
    this.#applied = opened;
    this.#host = host;
    this.#kit = new Set(opened.kit);
    this.#shown = opened.revision;
    this.#wanted = opened.revision;
    this.#asked = opened.revision;
    const modules = Object.keys(opened.modules);
    this.#evaluated = {
      visit: 0,
      seen: new Set(modules),
      running: new Set(modules),
    };
    this.#taken.bytes = newBytes(opened);
  }

  /** The frame's receiver, once it handed it over: then whatever the chat named since. */
  follow(toFrame: FrameReceiver): void {
    if (this.#toFrame !== undefined || this.#closed) {
      return;
    }
    this.#toFrame = toFrame;
    void this.#run();
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
   * answers and the page swaps back), or else the one it shows. What the
   * frame calls and reports names it, and core files a problem, or a
   * screen seen, only under the draft's own revision: an update that
   * failed fails that revision's check, and an earlier screen's never
   * does.
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
   * Asks for and hands the frame the newest revision the chat named until
   * none is newer than the last asked for: one at a time.
   */
  async #run(): Promise<void> {
    if (this.#asking || this.#toFrame === undefined) {
      return;
    }
    this.#asking = true;
    try {
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

  /**
   * Hands the frame `update`, and the last version that rendered back
   * should it fail to render: false once the frame is started afresh.
   */
  async #hand(update: PreviewRefresh): Promise<boolean> {
    if (!this.#fits(update)) {
      this.#reset();
      return false;
    }
    this.#trying = update.revision;
    this.#troubled = false;
    let answer = await this.#load(update);
    this.#trying = undefined;
    if (answer === "broken") {
      // What rendered last, back, keeping what the screen holds.
      answer =
        this.#fits(this.#applied) &&
        (await this.#load(this.#applied)) === "applied"
          ? "failed"
          : "reset";
    }
    if (answer === "reset") {
      this.#reset();
      return false;
    }
    if (answer !== "applied") {
      // Not taken: the frame shows the last version that worked.
      this.#say("fixing");
      return !this.#closed;
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
   * Whether the frame can take `version` as it is: every kit module it
   * imports loaded, and within what one frame takes.
   */
  #fits(version: PreviewRefresh): boolean {
    const { revisions, bytes } = this.#taken;
    return (
      !this.#closed &&
      version.kit.every((name) => this.#kit.has(name)) &&
      revisions + 1 <= platformLimits.previewResetRevisions &&
      bytes + newBytes(version, this.#visitFor(version).seen) <=
        platformLimits.previewResetBytes
    );
  }

  /** The evaluation the frame imports `version` in: a new one when it would run code it left. */
  #visitFor(version: PreviewRefresh): Evaluated {
    const { seen, running, visit } = this.#evaluated;
    const left = Object.keys(version.modules).some(
      (address) => seen.has(address) && !running.has(address)
    );
    return left
      ? { visit: visit + 1, seen: new Set(), running: new Set() }
      : this.#evaluated;
  }

  /** Hands the frame `version`, counting what it evaluates. */
  async #load(version: PreviewRefresh): Promise<PreviewApplied> {
    const toFrame = this.#toFrame;
    if (toFrame === undefined || this.#closed) {
      return "reset";
    }
    const into = this.#visitFor(version);
    const modules = Object.keys(version.modules);
    this.#taken.revisions += 1;
    this.#taken.bytes += newBytes(version, into.seen);
    // Whatever it answers, its modules are in the frame's module map now:
    // those that evaluated, and those that failed to.
    const seen = new Set([...into.seen, ...modules]);
    let answer: PreviewApplied;
    try {
      answer = await toFrame({
        entry: version.entry,
        visit: into.visit,
        css: version.css,
      });
    } catch {
      // The frame's bridge is gone: the frame is stopped as it is.
      this.#closed = true;
      return "reset";
    }
    // What it registered with Refresh: an update that evaluated, whether
    // it rendered or not; one that didn't registers nothing.
    const registered = answer === "applied" || answer === "broken";
    this.#evaluated = {
      visit: into.visit,
      seen,
      running: registered ? new Set(modules) : into.running,
    };
    return answer;
  }

  #reset(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#host.reset();
    }
  }
}
