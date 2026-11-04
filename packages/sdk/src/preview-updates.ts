/**
 * How a chat's preview's frame takes its draft's updates (spec 19.2.1):
 * the page hands it each write's screen as one module, in parts over the
 * frame's own bridge (`PreviewPart`); the frame checks the whole against
 * what core said of it, evaluates it, and React Fast Refresh swaps its
 * components in, keeping what the screen holds (preview-refresh.ts). The
 * way Vite's HMR client takes an update, with the module handed over
 * rather than fetched: the frame has no network, and its import map
 * can't change once modules loaded.
 *
 * What can go wrong, and what this does about it:
 * - Bytes other than core's: the module is evaluated only once its size
 *   and SHA-256 are the ones the page passed on from core.
 * - An update that is stale, replayed or out of order: each names its
 *   revision, and only one past the last the frame applied is taken;
 *   parts of another update, or out of turn, drop what was gathered.
 * - An update that doesn't evaluate: what it registered is discarded, so
 *   the screen runs on as it was; the error goes to the page, which tells
 *   the chat's agent.
 * - An update that evaluates but fails to render: the last version that
 *   rendered is evaluated again and swapped back in (Refresh finds a type
 *   it registered once no second time, so it comes back as new code of
 *   the same families), and its error boundary, which Refresh remounts,
 *   shows it again. That restores what renders, not every effect the
 *   failing code had.
 * - Refresh can't go on (an error it can't recover from): the page is
 *   told to start the frame afresh.
 *
 * Draft code in this frame could evaluate a `data:` module of its own:
 * the frame's policy allows it for previews only, as core's
 * screen-frame.ts says why. This receiver is the preview kit's, never a
 * production screen's.
 */
import type {
  PreviewApplied,
  PreviewPart,
  ScreenComponent,
} from "./screen-runtime.ts";

/** What the receiver works with: Refresh, the frame, and the page. */
export interface PreviewFrame {
  /** Evaluates a module at `url` (a `data:` module), registering its components. */
  evaluate: (url: string) => Promise<unknown>;
  /** Registers what the last evaluation staged (preview-refresh.ts). */
  commit: () => void;
  /** Forgets what the last evaluation staged. */
  discard: () => void;
  /** Swaps the registered components in: false once Refresh can't go on. */
  refresh: () => boolean;
  /**
   * Shows `screen`, the evaluated module's default export, as the screen,
   * rendering it at once: what Refresh can't swap in, a screen renamed in
   * an update (screen-runtime.ts `ShownScreen`).
   */
  show: (screen: ScreenComponent) => void;
  /** How many render errors React met so far. */
  renderFailures: () => number;
  /** Waits for what the swap rendered to settle (effects, a boundary). */
  settle: () => Promise<void>;
  /** Puts `css` in place of the frame's CSS. */
  setCss: (css: string) => void;
  /** Tells the page what went wrong. */
  report: (value: unknown) => void;
  /** The SHA-256 of `bytes`, in hex. */
  sha256: (bytes: Uint8Array) => Promise<string>;
}

/**
 * Whether `value` is a component React can render as the screen: a
 * function, as the compiler makes every screen's default export one.
 */
const isScreen = (value: unknown): value is ScreenComponent =>
  typeof value === "function";

/** A module's default export, whatever it is: the screen, in a screen's module. */
const defaultOf = (evaluated: unknown): unknown =>
  typeof evaluated === "object" && evaluated !== null
    ? Reflect.get(evaluated, "default")
    : undefined;

/** An update the frame applied, kept to swap back to. */
interface Version {
  revision: number;
  code: string;
  css: string;
}

/** An update being gathered, part by part. */
interface Gathering {
  first: PreviewPart;
  codes: string[];
}

const encoder = new TextEncoder();

/** Whether `value` is a part as the page sends one. */
const isPart = (value: unknown): value is PreviewPart => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const field = (name: keyof PreviewPart): unknown => Reflect.get(value, name);
  const part = field("part");
  const parts = field("parts");
  return (
    Number.isSafeInteger(field("revision")) &&
    Number.isSafeInteger(field("bytes")) &&
    typeof part === "number" &&
    typeof parts === "number" &&
    Number.isSafeInteger(part) &&
    part >= 0 &&
    part < parts &&
    typeof field("code") === "string" &&
    typeof field("sha256") === "string" &&
    typeof field("css") === "string"
  );
};

/** Whether `part` belongs to the update `first` started, as its next part. */
const continues = (gathering: Gathering, part: PreviewPart): boolean => {
  const { first, codes } = gathering;
  return (
    part.part === codes.length &&
    part.revision === first.revision &&
    part.parts === first.parts &&
    part.bytes === first.bytes &&
    part.sha256 === first.sha256
  );
};

/**
 * `code`, evaluation number `evaluation` in this frame, as a module
 * address: a `data:` module. A browser evaluates one address once, and
 * hands the module it made for each import after: code that came before
 * (an update back to an earlier write, A then B then A, or a rollback)
 * would register nothing, and the screen stay as it is while the update
 * counts as applied. So every evaluation gets an address of its own:
 * the code checked byte for byte, then one comment line naming the
 * evaluation, which the module runs nothing of. The frame's policy
 * allows `data:` modules as such, whatever comes after the comma.
 */
const moduleAddress = (code: string, evaluation: number): string =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(
    `${code}\n//# grasp-evaluation=${evaluation}`
  )}`;

/**
 * The frame's receiver of its draft's updates: what the page calls with
 * each part (`ScreenBridge.refresh`). One at a time: the page sends the
 * next part once this answered the last.
 */
export const previewReceiver = (
  frame: PreviewFrame
): ((part: unknown) => Promise<PreviewApplied>) => {
  let applied: Version | undefined;
  let gathering: Gathering | undefined;
  let evaluations = 0;

  /**
   * Evaluates `code` and swaps it in: `rendered`; `unevaluated`, when it
   * threw before anything was swapped (what it staged is discarded);
   * `broken`, when it rendered with an error; `reset`, when Refresh can't
   * go on.
   */
  const swap = async (
    code: string
  ): Promise<"rendered" | "unevaluated" | "broken" | "reset"> => {
    const failuresBefore = frame.renderFailures();
    evaluations += 1;
    let screen: ScreenComponent;
    try {
      const evaluated = await frame.evaluate(moduleAddress(code, evaluations));
      const found = defaultOf(evaluated);
      if (!isScreen(found)) {
        throw new TypeError(
          "The screen's module has no default export to render."
        );
      }
      screen = found;
    } catch (error) {
      frame.discard();
      frame.report(error);
      return "unevaluated";
    }
    frame.commit();
    if (!frame.refresh()) {
      return "reset";
    }
    // What Refresh swapped is shown; a screen of another name only so.
    frame.show(screen);
    await frame.settle();
    return frame.renderFailures() === failuresBefore ? "rendered" : "broken";
  };

  /** Applies `version`, or swaps the last applied one back in. */
  const take = async (version: Version): Promise<PreviewApplied> => {
    const css = applied?.css;
    frame.setCss(version.css);
    const swapped = await swap(version.code);
    if (swapped === "rendered") {
      applied = version;
      return "applied";
    }
    if (css !== undefined) {
      frame.setCss(css);
    }
    if (swapped !== "broken") {
      return swapped === "reset" ? "reset" : "failed";
    }
    const last = applied;
    if (last === undefined) {
      return "reset";
    }
    // What rendered last, back: evaluated anew, so Refresh takes it.
    return (await swap(last.code)) === "rendered" ? "failed" : "reset";
  };

  return async (part) => {
    if (!isPart(part) || part.revision <= (applied?.revision ?? -1)) {
      gathering = undefined;
      return "refused";
    }
    if (part.part === 0) {
      gathering = { first: part, codes: [] };
    }
    if (gathering === undefined || !continues(gathering, part)) {
      gathering = undefined;
      return "refused";
    }
    gathering.codes.push(part.code);
    if (part.part < part.parts - 1) {
      return "more";
    }
    const { first, codes } = gathering;
    gathering = undefined;
    const code = codes.join("");
    const bytes = encoder.encode(code);
    // Nothing is evaluated that isn't, byte for byte, what core built.
    if (
      bytes.byteLength !== first.bytes ||
      (await frame.sha256(bytes)) !== first.sha256
    ) {
      return "refused";
    }
    return await take({ revision: first.revision, code, css: part.css });
  };
};
