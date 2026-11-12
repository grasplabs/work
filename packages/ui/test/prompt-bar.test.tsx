// @vitest-environment happy-dom
import { Activity, act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PromptBar } from "../src/components/prompt-bar.tsx";

// The idle bar says once it has finished closing (`onOpenChangeComplete`),
// which is what Grasp's chat waits for before it opens: said even when
// React cleans up the bar's effects and runs them again in between, as it
// does for a tree hidden and shown again, with nothing about the bar
// changed. Once, it never said it then, and the chat never opened.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The bar, open or not, in a tree that is shown or hidden. */
const Page = ({
  open,
  hidden,
  said,
}: {
  open: boolean;
  hidden: boolean;
  said: boolean[];
}) => (
  <Activity mode={hidden ? "hidden" : "visible"}>
    <PromptBar
      onOpenChangeComplete={(isOpen) => {
        said.push(isOpen);
      }}
      open={open}
    />
  </Activity>
);

describe("the prompt bar", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
  });

  it("says it closed even when its effects were run again before it finished", async () => {
    const said: boolean[] = [];
    const element = document.createElement("div");
    document.body.append(element);
    const shown = createRoot(element);
    root = shown;
    act(() => {
      shown.render(<Page hidden={false} open said={said} />);
    });

    // Closed, then hidden and shown again before it could say so: its
    // effects are cleaned up and run again, with `open` as it was.
    act(() => {
      shown.render(<Page hidden={false} open={false} said={said} />);
    });
    act(() => {
      shown.render(<Page hidden open={false} said={said} />);
    });
    act(() => {
      shown.render(<Page hidden={false} open={false} said={said} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(said).toStrictEqual([false]);
  });
});
