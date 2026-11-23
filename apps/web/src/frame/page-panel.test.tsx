// @vitest-environment happy-dom

import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PagePanel, PageWithPanel } from "./page-panel.tsx";

// A page's side panel, as the frame seats it: beside the page on a card
// wide enough for both, in a sheet on a narrower one, and gone with the
// page.

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

/** Draws the harness as `asked`, again on the same root once made. */
const drawn = async (root: Root, asked: Asked): Promise<void> => {
  await act(async () => {
    root.render(<Harness {...asked} />);
    await settled();
  });
};

/** Where the panel stands: beside the page, in a sheet, or nowhere in sight. */
const placed = () => {
  if (document.querySelector('[data-slot="app-shell-panel"]') !== null) {
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

  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
    });
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("stands beside the page while the page has one, and goes with it", async () => {
    cardOf(1200);
    const { host, root } = mounted();
    await drawn(root, {});
    const panel = () => host.querySelector('[data-slot="app-shell-panel"]');
    const besideBefore = panel()?.textContent;
    await drawn(root, { shown: false });
    expect({ besideBefore, after: panel() }).toStrictEqual({
      besideBefore: "The facts",
      after: null,
    });
    // The page itself never moved into the panel.
    expect(host.querySelector("p")?.textContent).toBe("The page");
  });

  it("is a sheet on a card under a phone's width, closed until the page opens it, and tells the page as it closes", async () => {
    cardOf(600);
    const { root } = mounted();
    await drawn(root, {});
    const unset = placed();
    const heard: boolean[] = [];
    const onOpenChange = (open: boolean) => {
      heard.push(open);
    };
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
    cardOf(600);
    const { root } = mounted();
    // The sheet open on one page, and closed by the person.
    await drawn(root, { open: true });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await settled();
    });
    // The next page, on a card wide enough, leaves it to the frame.
    cardOf(1200);
    await drawn(root, { shown: false });
    await drawn(root, {});
    expect(placed()).toBe("none");
  });
});
