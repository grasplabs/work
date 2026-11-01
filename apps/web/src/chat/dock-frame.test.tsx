// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OpenChat, useDockWidth, useUnfoldOnPointer } from "./dock-frame.tsx";
import {
  dockDrawer,
  dockDrawerWidth,
  setDockDrawerWidth,
  setDockMode,
  useDockMode,
} from "./dock-mode.ts";

// The chat dock's frame as a person meets it: the folded box with a
// conversation behind it opens on a click into it, or on its own button
// from the keyboard, but not by tabbing into it; and the drawer is taken
// in when the window narrows, never past 45% of it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** How many times the dock was opened, by whichever way in. */
let opened = 0;

/** What a drag of the drawer's edge shows the drawer as, while it is dragged. */
const previews = new Map<"dock", (width: number) => void>();

/** The one way the dock opens, as the dock's own (`moveTo`) is for both ways in. */
const open = (): void => {
  opened += 1;
  setDockMode("frame");
};

/** The dock: its box, and the way in beside it while it is folded. */
const Folded = () => {
  const dock = useRef<HTMLElement>(null);
  const mode = useDockMode();
  useUnfoldOnPointer(dock, mode === "bar", open);
  const preview = useDockWidth(dock, mode === "drawer");
  useEffect(() => {
    previews.set("dock", preview);
  });
  return (
    <section data-mode={mode} id="dock" ref={dock}>
      <textarea aria-describedby="hint" aria-label="Ask" />
      {mode === "bar" ? (
        <OpenChat controls="dock" hint="hint" onOpen={open} />
      ) : null}
    </section>
  );
};

const show = async (drawer = false): Promise<void> => {
  if (drawer) {
    setDockMode("drawer");
  }
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <Folded />
      </I18nProvider>
    );
    await Promise.resolve();
  });
};

const dock = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>("#dock");
  if (!found) {
    throw new TypeError("No dock");
  }
  return found;
};

const box = (): HTMLTextAreaElement => {
  const found = document.querySelector("textarea");
  if (!found) {
    throw new TypeError("No box");
  }
  return found;
};

const resize = async (width: number): Promise<void> => {
  await act(async () => {
    Reflect.set(window, "innerWidth", width);
    window.dispatchEvent(new Event("resize"));
    await Promise.resolve();
  });
};

/** Takes the dock away, and puts the dock's store back as it starts. */
const cleanUp = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  setDockMode("bar");
  setDockDrawerWidth(dockDrawer.normal);
  opened = 0;
  previews.clear();
};

describe("the folded chat", () => {
  afterEach(cleanUp);

  it("opens on a click into its box", async () => {
    await show();
    await act(async () => {
      box().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    expect({ mode: dock().dataset.mode, opened }).toStrictEqual({
      mode: "frame",
      opened: 1,
    });
  });

  it("stays folded when the box takes the focus from the keyboard", async () => {
    await show();
    await act(async () => {
      box().focus();
      await Promise.resolve();
    });
    expect(dock().dataset.mode).toBe("bar");
  });

  it("opens from the keyboard on its own button, which says what it opens", async () => {
    await show();
    const button = document.querySelector("button");
    const described = document.querySelector(
      `#${box().getAttribute("aria-describedby") ?? ""}`
    );
    expect({
      name: button?.getAttribute("aria-label"),
      expanded: button?.getAttribute("aria-expanded"),
      controls: button?.getAttribute("aria-controls"),
      described: described?.textContent,
    }).toStrictEqual({
      name: "Open the chat",
      expanded: "false",
      controls: "dock",
      described: "There is a conversation here. Open the chat to see it.",
    });
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(dock().dataset.mode).toBe("frame");
  });
});

describe("the chat drawer's width", () => {
  afterEach(cleanUp);

  it("is taken in to 45% of a window made narrower, and doesn't grow back on its own", async () => {
    Reflect.set(window, "innerWidth", 1400);
    setDockDrawerWidth(600);
    await show(true);
    await resize(1000);
    const narrowed = dockDrawerWidth();
    await resize(1400);
    expect({
      narrowed,
      after: dockDrawerWidth(),
      shown: dock().style.getPropertyValue("--dock-width"),
    }).toStrictEqual({ narrowed: 450, after: 450, shown: "450px" });
  });

  it("is never less than the least it reads at", async () => {
    Reflect.set(window, "innerWidth", 1400);
    await show(true);
    await resize(500);
    expect(dockDrawerWidth()).toBe(dockDrawer.least);
  });

  it("is the frame's own again when a drag leaves the drawer", async () => {
    Reflect.set(window, "innerWidth", 1400);
    await show(true);
    await act(async () => {
      previews.get("dock")?.(320);
      setDockMode("frame");
      await Promise.resolve();
    });
    expect(dock().style.getPropertyValue("--dock-width")).toBe(
      `${dockDrawer.normal}px`
    );
  });
});
