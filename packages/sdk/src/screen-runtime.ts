import {
  screenFrameMounted,
  screenLimits,
} from "@grasp-os/shared/screen-limits";
/**
 * What runs an App's screen inside its sandboxed frame: it connects to the
 * page around the frame over the `MessagePort` the page hands it, renders
 * the screen, follows the page's theme and reports the screen's errors.
 * The frame's own document (served by core) loads this module first; App
 * code uses `@grasp-os/sdk/screen`, never this.
 *
 * The frame is a sandbox with an opaque origin and no network, so the port
 * is the screen's only way out: to its App's server, through the page,
 * which binds it to that one App.
 */
import { portTransport } from "@grasp-os/shared/screen-port";
import type { ScreenMounted, ScreenProblem } from "@grasp-os/shared/screens";
import { RpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import { createElement, Fragment, useEffect } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

export type Theme = "light" | "dark";

/**
 * What the page gives the frame over its port, and nothing else. Answers
 * and failures come back as they are; a screen reads them as its own data.
 */
export interface ScreenBridge {
  /**
   * Calls `method` of the App's server with `args`, for the person using
   * the screen. Functions among `args` reach the server as callbacks it
   * can keep and call later.
   */
  call: (method: string, args: unknown[]) => Promise<unknown>;
  /** Adds a problem to the App's error log. */
  report: (problem: ScreenProblem) => void;
  /** Calls `onTheme` with the page's theme now and whenever it changes. */
  theme: (onTheme: (theme: Theme) => void) => void;
  /** Starts a run of the App's workflow, for the person. */
  startRun: (workflow: string, input: unknown) => Promise<unknown>;
  /** The App's runs of `workflow`, newest first. */
  runs: (workflow: string) => Promise<unknown>;
  /** One of the App's runs as it is now. */
  run: (run: string) => Promise<unknown>;
  /** Answers the decision `decision` of one of the App's runs. */
  decide: (run: string, decision: string, answer: unknown) => Promise<unknown>;
  /**
   * Calls `onChange` each time one of the App's runs of `workflow`
   * changes, until the subscription it answers is released (`release()`)
   * or core lets go of `onChange`.
   */
  watchRuns: (
    workflow: string,
    onChange: (change: unknown) => void
  ) => Promise<unknown>;
}

let connected: RpcStub<ScreenBridge> | undefined;

/** The page's bridge, once the frame has connected. */
export const bridge = (): RpcStub<ScreenBridge> => {
  if (!connected) {
    throw new Error("The screen isn't connected to its page yet.");
  }
  return connected;
};

/**
 * Connects the frame to the page's bridge over `port`, each message as
 * text, which the page holds to a size (@grasp-os/shared/screen-port).
 */
export const connectBridge = (port: MessagePort): RpcStub<ScreenBridge> => {
  connected = new RpcSession<ScreenBridge>(portTransport(port)).getRemoteMain();
  return connected;
};

/**
 * Which start of the frame this is, as the page handed it over with the
 * screen: the frame's load, the hash of the code and the page's name for
 * this start. The runtime only says them back (`screenFrameMounted`).
 */
export type ScreenStart = Omit<ScreenMounted, "type">;

/**
 * Renders nothing; tells the page the screen has rendered for the first
 * time. An effect runs once React has put the first render on the page,
 * so a screen that fails or never finishes its first render says nothing,
 * and the page gives up on it.
 *
 * This only tells the page a start that worked from one that didn't. The
 * screen's own code runs in this same frame and could post the same
 * message; the page gives a mounted screen nothing it wouldn't otherwise.
 */
const Mounted = ({ start }: { start: ScreenStart }) => {
  useEffect(() => {
    parent.postMessage({ type: screenFrameMounted, ...start }, "*");
  }, [start]);
  return null;
};

/** An error's message and stack, as far as it has them, never throwing. */
const read = (value: unknown): Pick<ScreenProblem, "message" | "stack"> => {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  try {
    return { message: typeof value === "string" ? value : String(value) };
  } catch {
    return { message: "(an error that can't be shown)" };
  }
};

/**
 * An error's message and stack, cut to what a report keeps. The page
 * takes no message over its port beyond a size and ends the session over
 * one that is; a stack names each module by its whole address, which in
 * this frame is the module's code, so it is far longer than what is kept.
 */
const describe = (value: unknown): Pick<ScreenProblem, "message" | "stack"> => {
  const { message, stack } = read(value);
  return {
    message: message.slice(0, screenLimits.report.message),
    stack: stack?.slice(0, screenLimits.report.stack),
  };
};

const send = async (problem: ScreenProblem): Promise<void> => {
  try {
    await bridge().report(problem);
  } catch {
    // Reporting must never fail the screen, or report itself.
  }
};

const report = (problem: ScreenProblem): void => {
  void send(problem);
};

/** Sends the screen's uncaught errors and `console.error` calls to the page. */
const reportProblems = (): void => {
  addEventListener("error", (event) => {
    report({ kind: "error", ...describe(event.error ?? event.message) });
  });
  addEventListener("unhandledrejection", (event) => {
    report({ kind: "rejection", ...describe(event.reason) });
  });
  const logError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logError(...args);
    const [first] = args;
    const described = describe(first);
    report({
      kind: "console",
      ...described,
      message: args
        .map((arg) => describe(arg).message)
        .join(" ")
        .slice(0, screenLimits.report.message),
    });
  };
};

const isScreenModule = (value: unknown): value is { default: ComponentType } =>
  typeof value === "object" &&
  value !== null &&
  "default" in value &&
  typeof value.default === "function";

/**
 * Runs the screen whose module is `screen` (a name in the frame's import
 * map), connected to the page through `port`, and tells the page once it
 * has rendered for the first time, as the `start` the page named.
 */
export const runScreen = async (
  port: MessagePort,
  screen: string,
  start: ScreenStart
): Promise<void> => {
  const page = connectBridge(port);
  reportProblems();
  const root = document.createElement("div");
  document.body.append(root);
  try {
    await page.theme((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });
    const loaded: unknown = await import(screen);
    if (!isScreenModule(loaded)) {
      throw new Error(`${screen} has no default export to render.`);
    }
    createRoot(root, {
      onUncaughtError: (error) => {
        report({ kind: "error", ...describe(error) });
      },
    }).render(
      createElement(
        Fragment,
        null,
        createElement(loaded.default),
        createElement(Mounted, { start })
      )
    );
  } catch (error) {
    report({ kind: "error", ...describe(error) });
  }
};
