import { pageLimits } from "@grasp-os/shared/page-limits";
import type { PageProblem } from "@grasp-os/shared/pages";
import { Component, createElement } from "react";
import type { ReactNode } from "react";

import { GraspError } from "./client-error.ts";
import { calledByApp } from "./console-origin.ts";
import { bridge } from "./page-bridge.ts";

// What goes wrong in the pages: reported to the page for the App's error
// log, and shown in place of what failed to render.

/** An error's message and stack, as far as it has them, never throwing. */
const read = (value: unknown): Pick<PageProblem, "message" | "stack"> => {
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
export const describe = (
  value: unknown
): Pick<PageProblem, "message" | "stack"> => {
  const { message, stack } = read(value);
  return {
    message: message.slice(0, pageLimits.report.message),
    stack: stack?.slice(0, pageLimits.report.stack),
  };
};

const send = async (problem: PageProblem): Promise<void> => {
  try {
    await bridge().report(problem);
  } catch {
    // Reporting must never fail the page, or report itself.
  }
};

export const report = (problem: PageProblem): void => {
  void send(problem);
};

/**
 * Sends `value`, what went wrong, to the page as a problem of `kind`, as
 * the runtime's own reports are: for a preview's runtime, whose updates
 * fail outside what the runtime sees (preview-runtime.ts).
 */
export const reportProblem = (
  kind: "error" | "rejection",
  value: unknown
): void => {
  report({ kind, ...describe(value) });
};

/**
 * Sends the pages' uncaught errors and `console.error` calls to the
 * page: `entry` is the address of the route tree's module, beside which
 * every App module of the frame is (core's page-frame.ts).
 */
export const reportProblems = (entry: string): void => {
  addEventListener("error", (event) => {
    report({ kind: "error", ...describe(event.error ?? event.message) });
  });
  addEventListener("unhandledrejection", (event) => {
    report({ kind: "rejection", ...describe(event.reason) });
  });
  const logError = console.error.bind(console);
  const appDirectory = new URL("./", entry).href;
  console.error = (...args: unknown[]) => {
    logError(...args);
    const [first] = args;
    const described = describe(first);
    // The App's own call is a problem; React's development warnings in a
    // preview, or a library's, only a warning (console-origin.ts).
    const fromApp = calledByApp(
      new Error("console.error called").stack ?? "",
      import.meta.url,
      appDirectory
    );
    report({
      kind: fromApp ? "console" : "warning",
      ...described,
      message: args
        .map((arg) => describe(arg).message)
        .join(" ")
        .slice(0, pageLimits.report.message),
    });
  };
};

/**
 * What a page shows in place of what failed to render: the failure's
 * own message when it is a structured SDK error (worded for people, and
 * never with a cause or stack, though App code can make one with any
 * message: this box is the App's, not the platform's), a plain sentence
 * otherwise, and a way to try again.
 */
export const fallbackOf = (error: unknown, tryAgain: () => void): ReactNode =>
  createElement(
    "div",
    { role: "alert", className: "flex flex-col items-start gap-3 p-6" },
    createElement(
      "p",
      { className: "text-sm" },
      error instanceof GraspError
        ? error.message
        : "Something went wrong showing this page."
    ),
    // A plain button, not @grasp-os/ui's Button: the UI kit depends on
    // the SDK, so the SDK can't depend on it back. Styled with theme
    // utilities only, nothing arbitrary.
    createElement(
      "button",
      {
        type: "button",
        className:
          "rounded-md border px-3 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        onClick: tryAgain,
      },
      "Try again"
    )
  );

interface BoundaryProps {
  /** Reads the queries that failed again, before the page renders again. */
  retry: () => void;
  children?: ReactNode;
}

/** What failed to render, if anything did (whatever was thrown, even `undefined`). */
interface BoundaryState {
  failure: { error: unknown } | null;
}

/**
 * The platform's error boundary around the App, for what
 * fails outside a route's own (`defaultErrorComponent`): a query that
 * fails throws while rendering, and lands here instead of blanking the
 * frame. React offers no hook for this, so it is the runtime's one class
 * component; the React Compiler leaves classes as they are.
 */
export class PageBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failure: null };
  }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: { error } };
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (failure === null) {
      return this.props.children;
    }
    return fallbackOf(failure.error, () => {
      this.props.retry();
      this.setState({ failure: null });
    });
  }
}
