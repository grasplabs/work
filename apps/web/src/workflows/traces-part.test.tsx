// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useTracesPart } from "./traces.tsx";

// Which of Runs and Activity shows on a workflow's Runs view: a run the
// address names anew (Run's "Open the run") shows Runs, where it opens,
// even while Activity shows; otherwise the person's choice stays.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let container: HTMLElement | undefined;

/** Says the part that shows; its button chooses Activity. */
const Probe = ({ openRun }: { openRun: string | undefined }) => {
  const [part, setPart] = useTracesPart(openRun);
  return (
    <button
      onClick={() => {
        setPart("activity");
      }}
      type="button"
    >
      {part}
    </button>
  );
};

const show = (openRun?: string): void => {
  container ??= document.createElement("div");
  root ??= createRoot(container);
  act(() => {
    root?.render(<Probe openRun={openRun} />);
  });
};

const chooseActivity = (): void => {
  act(() => {
    container?.querySelector("button")?.click();
  });
};

const shownPart = (): string | null | undefined => container?.textContent;

describe("Runs or Activity", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    container = undefined;
  });

  it("shows Runs when a run is opened while Activity shows", () => {
    show();
    chooseActivity();
    expect(shownPart()).toBe("activity");
    show("run-new");
    expect(shownPart()).toBe("runs");
  });

  it("shows Runs when another run is opened", () => {
    show("run-1");
    chooseActivity();
    show("run-2");
    expect(shownPart()).toBe("runs");
  });

  it("keeps Activity while the same run stays named, or none is", () => {
    show("run-1");
    chooseActivity();
    show("run-1");
    expect(shownPart()).toBe("activity");
    show();
    expect(shownPart()).toBe("activity");
  });
});
