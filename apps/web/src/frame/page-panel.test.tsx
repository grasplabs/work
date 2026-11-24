// @vitest-environment happy-dom

import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { PagePanel, PageWithPanel } from "./page-panel.tsx";

// A page's side panel, as the frame seats it: beside the page where the
// page keeps its least beside it, in a sheet where it would not, and gone
// with the page.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** What the page under test asks of its panel. */
interface Asked {
  shown?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  pageMinWidth?: number;
}

/** The page under test: its column, and its panel while `shown`. */
const Page = ({ shown = true, open, onOpenChange, pageMinWidth }: Asked) => (
  <p>
    The page
    {shown ? (
      <PagePanel
        label="Details"
        onOpenChange={onOpenChange}
        open={open}
        pageMinWidth={pageMinWidth}
      >
        <span>The facts</span>
      </PagePanel>
    ) : null}
  </p>
);

const Harness = (asked: Asked) => (
  <I18nProvider i18n={i18n}>
    <SidebarProvider>
      <PageWithPanel>
        <Page {...asked} />
      </PageWithPanel>
    </SidebarProvider>
  </I18nProvider>
);

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/** The card as wide as `width`: what the frame reads to seat the panel. */
const cardOf = (width: number) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width, height: 800 })
  );
};

/**
 * The card on a window `width` across, as the frame lays it: the whole
 * window under 1024px, where the sidebar is a sheet; from there, beside the
 * sidebar's 240px and two 6px gutters.
 */
const windowOf = (width: number) => {
  cardOf(width < 1024 ? width : width - 252);
};

/** What watches the card's size: told when the window changes under a drawn frame. */
const watchers = new Set<() => void>();

/** A ResizeObserver this test tells, as the browser's would be told. */
class Watching {
  readonly #told: () => void;
  constructor(told: () => void) {
    this.#told = told;
  }
  observe() {
    watchers.add(this.#told);
  }
  disconnect() {
    watchers.delete(this.#told);
  }
}

/** The window made `width` across under the drawn frame. */
const resizedTo = async (width: number): Promise<void> => {
  windowOf(width);
  await act(async () => {
    for (const told of watchers) {
      told();
    }
    await settled();
  });
};

/** Draws the harness as `asked`, again on the same root once made. */
const drawn = async (root: Root, asked: Asked): Promise<void> => {
  await act(async () => {
    root.render(<Harness {...asked} />);
    await settled();
  });
};

/** Where the panel stands: beside the page, in a sheet, or nowhere in sight. */
const placed = () => {
  if (document.querySelector('[data-slot="app-shell-page-panel"]') !== null) {
    return "beside";
  }
  const sheet = document.querySelector('[role="dialog"]');
  return sheet?.textContent?.includes("The facts") === true ? "sheet" : "none";
};

describe("a page's side panel", () => {
  const roots: Root[] = [];
  const mounted = () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    return { host, root };
  };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", Watching);
  });

  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    watchers.clear();
    document.body.replaceChildren();
  });

  it("stands beside the page while the page has one, and goes with it", async () => {
    cardOf(1200);
    const { host, root } = mounted();
    await drawn(root, {});
    const panel = () =>
      host.querySelector('[data-slot="app-shell-page-panel"]');
    const besideBefore = panel()?.textContent;
    await drawn(root, { shown: false });
    expect({ besideBefore, after: panel() }).toStrictEqual({
      besideBefore: "The facts",
      after: null,
    });
    // The page itself never moved into the panel.
    expect(host.querySelector("p")?.textContent).toBe("The page");
  });

  // Where the page asks it open (its button), at windows either side of
  // the reference's switch (892px) and of the sidebar's (1024px).
  it.each([
    [640, "sheet"],
    [891, "sheet"],
    [892, "beside"],
    [1024, "sheet"],
    [1280, "beside"],
  ])("on a window %ipx across, stands %s", async (width, where) => {
    windowOf(width);
    const { root } = mounted();
    await drawn(root, { open: false });
    await drawn(root, { open: true });
    expect(placed()).toBe(where);
  });

  it("is a sheet sooner for a page that needs more beside it", async () => {
    // The audit trail's table, 952px whole: at 1440 the card leaves it 768.
    windowOf(1440);
    const { root } = mounted();
    await drawn(root, { open: false, pageMinWidth: 952 });
    await drawn(root, { open: true, pageMinWidth: 952 });
    const at1440 = placed();
    await resizedTo(1920);
    await drawn(root, { open: false, pageMinWidth: 952 });
    await drawn(root, { open: true, pageMinWidth: 952 });
    expect({ at1440, at1920: placed() }).toStrictEqual({
      at1440: "sheet",
      at1920: "beside",
    });
  });

  it("does not cover the page on a phone's first look, though the page opens with it open", async () => {
    windowOf(390);
    const { root } = mounted();
    await drawn(root, { open: true });
    const first = placed();
    await drawn(root, { open: false });
    await drawn(root, { open: true });
    expect({ first, asked: placed() }).toStrictEqual({
      first: "none",
      asked: "sheet",
    });
  });

  it("does not become a sheet over the page as the card narrows under it", async () => {
    windowOf(1280);
    const { root } = mounted();
    await drawn(root, { open: true });
    const wide = placed();
    await resizedTo(640);
    expect({ wide, narrowed: placed() }).toStrictEqual({
      wide: "beside",
      narrowed: "none",
    });
  });

  it("is closed on a narrow card until the page opens it, and tells the page as it closes", async () => {
    windowOf(600);
    const { root } = mounted();
    await drawn(root, {});
    const unset = placed();
    const heard: boolean[] = [];
    const onOpenChange = (open: boolean) => {
      heard.push(open);
    };
    await drawn(root, { open: false, onOpenChange });
    await drawn(root, { open: true, onOpenChange });
    const opened = placed();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await settled();
    });
    expect({ unset, opened, heard }).toStrictEqual({
      unset: "none",
      opened: "sheet",
      heard: [false],
    });
  });

  it("is a sheet where the page's content would have less than it needs beside it", async () => {
    // 1000 across: 580 left beside the panel's 420.
    cardOf(1000);
    const { root } = mounted();
    await drawn(root, { pageMinWidth: 600 });
    const crowded = placed();
    await drawn(root, { pageMinWidth: 560 });
    expect({ crowded, room: placed() }).toStrictEqual({
      crowded: "none",
      room: "beside",
    });
  });

  it("stays as the page says, open or closed, beside the page", async () => {
    cardOf(1200);
    const { root } = mounted();
    await drawn(root, { open: false });
    const closed = placed();
    await drawn(root, { open: true });
    expect({ closed, open: placed() }).toStrictEqual({
      closed: "none",
      open: "beside",
    });
  });

  it("keeps the person's choice for the next page that leaves it to the frame", async () => {
    windowOf(600);
    const { root } = mounted();
    // The sheet open on one page, and closed by the person.
    await drawn(root, { open: false });
    await drawn(root, { open: true });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await settled();
    });
    // The next page, on a window wide enough, leaves it to the frame.
    await resizedTo(1440);
    await drawn(root, { shown: false });
    await drawn(root, {});
    expect(placed()).toBe("none");
  });
});
