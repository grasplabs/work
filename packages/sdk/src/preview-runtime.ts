import type { AnyRouter } from "@tanstack/react-router";
import type { RpcStub } from "capnweb";

import type {
  PreviewLoad,
  PageBridge,
  PageHooks,
  PageStart,
} from "./page-runtime.ts";
/**
 * What runs a chat's preview of a draft in its frame: the
 * page runtime (page-runtime.ts) with React Fast Refresh. The preview
 * frame's document loads this in place of the page runtime; published
 * Apps never do, and only the preview kit has it.
 *
 * Refresh must hook into React before React DOM first loads. A bundler
 * may order a module's static imports as it likes, so this imports only
 * the Refresh runtime (preview-refresh.ts), which imports nothing of
 * React, statically, and the page runtime, which imports React DOM,
 * once this has run: by its flat name, which the frame's import map
 * resolves (the compiler puts it in every preview's closure).
 *
 * Once the pages have rendered, it hands the page its receiver of the
 * draft's updates (preview-updates.ts), and tells the page when they
 * rendered nothing at all: a problem the agent hears of, as of an error.
 */
import { commit, discard, refresh } from "./preview-refresh.ts";
import {
  ModuleNotLoadedError,
  notLoaded,
  previewReceiver,
} from "./preview-updates.ts";

/** The page runtime's module, by its flat name in the kit. */
const pageRuntimeModule = "@grasp-os~sdk~page-runtime.js";

/** What the page runtime's module exports, as this calls it. */
interface PageRuntime {
  runPage: (
    port: MessagePort,
    entry: string,
    start: PageStart,
    filePort: MessagePort,
    linkPort: MessagePort,
    hooks?: PageHooks
  ) => Promise<void>;
  reportProblem: (kind: "error" | "rejection", value: unknown) => void;
  routeBy: (router: AnyRouter, module: unknown) => boolean;
}

const isPageRuntime = (module: unknown): module is PageRuntime =>
  typeof module === "object" &&
  module !== null &&
  "runPage" in module &&
  typeof module.runPage === "function" &&
  "reportProblem" in module &&
  typeof module.reportProblem === "function" &&
  "routeBy" in module &&
  typeof module.routeBy === "function";

/** Waits for the next task: what a swap rendered has run its effects. */
const nextTask = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, 0);
  await promise;
};

/**
 * Where `load`'s module is, beside `first`, the address the frame first
 * loaded the route tree's module at: in the same directory, the
 * preview's own (core's page-frame.ts), under its visit from 1 on, with
 * the same query, which carries the directory's token.
 */
const addressOf = (first: string, { entry, visit }: PreviewLoad): string => {
  const file = visit === 0 ? `${entry}.js` : `${visit}/${entry}.js`;
  return new URL(`${file}${new URL(first).search}`, first).href;
};

/**
 * The style element the frame's document put the pages' CSS in, which
 * an update's CSS replaces: the document's only one.
 */
const pageStyle = (): HTMLStyleElement => {
  const found = document.head.querySelector("style");
  if (found !== null) {
    return found;
  }
  const made = document.createElement("style");
  document.head.append(made);
  return made;
};

/**
 * Runs the preview's pages as `runPage` runs an App's, registering
 * their components with Refresh once their modules have evaluated, before
 * they first render, and taking the draft's updates once they have
 * rendered.
 */
export const runPage = async (
  port: MessagePort,
  entry: string,
  start: PageStart,
  filePort: MessagePort,
  linkPort: MessagePort
): Promise<void> => {
  const pages: unknown = await import(pageRuntimeModule);
  if (!isPageRuntime(pages)) {
    throw new Error("The preview kit has no page runtime.");
  }
  let failures = 0;
  let following = false;
  const rendersNothing = (root: HTMLElement): void => {
    if (root.childNodes.length === 0) {
      pages.reportProblem(
        "error",
        new Error("The page rendered nothing: it returned no content.")
      );
    }
  };
  const follow = (
    page: RpcStub<PageBridge>,
    root: HTMLElement,
    router: AnyRouter
  ): void => {
    rendersNothing(root);
    // Its boundary remounts what it shows after an error (as Refresh
    // does): the page has the receiver already.
    if (following) {
      return;
    }
    following = true;
    const receive = previewReceiver({
      evaluate: async (load) => {
        try {
          const evaluated: unknown = await import(addressOf(entry, load));
          return evaluated;
        } catch (error) {
          throw notLoaded(error, new URL("./", entry).href)
            ? new ModuleNotLoadedError("The route tree's module didn't load.", {
                cause: error,
              })
            : error;
        }
      },
      commit,
      discard,
      refresh,
      route: (module) => pages.routeBy(router, module),
      renderFailures: () => failures,
      settle: nextTask,
      css: () => pageStyle().textContent,
      setCss: (css) => {
        pageStyle().textContent = css;
      },
      report: (value) => {
        pages.reportProblem("error", value);
      },
    });
    void page.refresh(async (load) => {
      const answer = await receive(load);
      if (answer === "applied") {
        rendersNothing(root);
      }
      return answer;
    });
  };
  await pages.runPage(port, entry, start, filePort, linkPort, {
    loaded: commit,
    renderFailed: () => {
      failures += 1;
    },
    mounted: follow,
  });
};
