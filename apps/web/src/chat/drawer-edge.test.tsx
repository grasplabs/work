// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  dockDrawer,
  dockDrawerWidth,
  setDockDrawerWidth,
  useDockDrawerWidth,
} from "./dock-mode.ts";
import { DrawerEdge } from "./drawer-edge.tsx";

// The chat drawer's edge, as a person drags it or moves it with the arrow
// keys, in a window 1024 pixels wide: the drawer may take 45% of it (461
// pixels), never less than 340; pulled 70 past that, it closes. While it
// is dragged only the drawer follows; the width is kept when it is let go.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const windowWidth = 1024;
const widest = 461;
/** How far the drawer's right edge is in from the window's. */
const margin = 8;

let root: Root | undefined;
/** How wide the drawer shows now, as the edge last showed it. */
let shown: number | undefined;
let closed = 0;

const Drawer = () => {
  const width = useDockDrawerWidth();
  const [dragging, setDragging] = useState(false);
  return (
    <DrawerEdge
      dragging={dragging}
      onClose={() => {
        closed += 1;
      }}
      onDragging={setDragging}
      onPreview={(next) => {
        shown = next;
      }}
      width={width}
    />
  );
};

const edge = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[role="separator"]');
  if (!found) {
    throw new TypeError("No edge");
  }
  return found;
};

const press = async (key: string): Promise<void> => {
  await act(async () => {
    edge().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await Promise.resolve();
  });
};

const pointer = async (type: string, wanted?: number): Promise<void> => {
  await act(async () => {
    edge().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        clientX: windowWidth - margin - (wanted ?? 0),
      })
    );
    await Promise.resolve();
  });
};

/** Drags the edge to where the drawer would be `wanted` pixels wide, and lets go. */
const drag = async (wanted: number, letGo = true): Promise<void> => {
  await pointer("pointerdown", dockDrawerWidth());
  await pointer("pointermove", wanted);
  if (letGo) {
    await pointer("pointerup", wanted);
  }
};

describe(DrawerEdge, () => {
  beforeEach(async () => {
    setDockDrawerWidth(dockDrawer.normal);
    shown = undefined;
    closed = 0;
    Reflect.set(window, "innerWidth", windowWidth);
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      root = createRoot(host);
      root.render(
        <I18nProvider i18n={i18n}>
          <Drawer />
        </I18nProvider>
      );
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("is a separator that says how wide the drawer is, and how wide it may be", () => {
    expect({
      name: edge().getAttribute("aria-label"),
      now: edge().getAttribute("aria-valuenow"),
      least: edge().getAttribute("aria-valuemin"),
      most: edge().getAttribute("aria-valuemax"),
      focusable: edge().tabIndex,
    }).toStrictEqual({
      name: "Chat width",
      now: "442",
      least: "340",
      most: String(widest),
      focusable: 0,
    });
  });

  it("moves a step with the arrow keys, no wider than 45% of the window", async () => {
    await press("ArrowRight");
    const narrower = dockDrawerWidth();
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect([narrower, dockDrawerWidth()]).toStrictEqual([418, widest]);
    expect(edge().getAttribute("aria-valuenow")).toBe(String(widest));
  });

  it("follows the pointer while dragged, and keeps the width when let go", async () => {
    await drag(400, false);
    const whileDragged = dockDrawerWidth();
    await pointer("pointerup", 400);
    expect({ whileDragged, shown, kept: dockDrawerWidth() }).toStrictEqual({
      whileDragged: dockDrawer.normal,
      shown: 400,
      kept: 400,
    });
  });

  it("is never dragged wider than 45% of the window", async () => {
    await drag(900);
    expect(dockDrawerWidth()).toBe(widest);
  });

  it("gives a little under its least width, and goes back to it when let go", async () => {
    await drag(300, false);
    const givingWay = shown;
    await pointer("pointerup", 300);
    expect({ givingWay, shown, kept: dockDrawerWidth(), closed }).toStrictEqual(
      { givingWay: 328, shown: 340, kept: dockDrawer.least, closed: 0 }
    );
  });

  it("says how wide the drawer may be again when the window is resized", async () => {
    await act(async () => {
      Reflect.set(window, "innerWidth", 800);
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    expect(edge().getAttribute("aria-valuemax")).toBe("360");
  });

  it("closes when pulled well past its least width", async () => {
    await pointer("pointerdown", dockDrawerWidth());
    await pointer("pointermove", 400);
    await pointer("pointermove", 260);
    expect({ closed, width: dockDrawerWidth() }).toStrictEqual({
      closed: 1,
      width: dockDrawer.normal,
    });
  });

  it("comes back no wider than the window allows after it was pulled closed", async () => {
    await act(async () => {
      Reflect.set(window, "innerWidth", 800);
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
    });
    await pointer("pointerdown", dockDrawerWidth());
    await pointer("pointermove", 200);
    expect({ closed, width: dockDrawerWidth() }).toStrictEqual({
      closed: 1,
      width: 360,
    });
  });
});
