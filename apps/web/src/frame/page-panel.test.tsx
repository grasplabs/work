// @vitest-environment happy-dom

import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PagePanel, PageWithPanel } from "./page-panel.tsx";

// A page's side panel, as the frame seats it: drawn beside the page on a
// wide window while the page has one, and gone with it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The page under test: its column, and its panel while `shown`. */
const Page = ({ shown }: { shown: boolean }) => (
  <p>
    The page
    {shown ? (
      <PagePanel label="Details">
        <span>The facts</span>
      </PagePanel>
    ) : null}
  </p>
);

const Harness = ({ shown }: { shown: boolean }) => (
  <I18nProvider i18n={i18n}>
    <SidebarProvider>
      <PageWithPanel>
        <Page shown={shown} />
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

describe("a page's side panel", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("stands beside the page while the page has one, and goes with it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<Harness shown />);
      await settled();
    });
    const panel = () => host.querySelector('[data-slot="app-shell-panel"]');
    const besideBefore = panel()?.textContent;
    await act(async () => {
      root.render(<Harness shown={false} />);
      await settled();
    });
    expect({ besideBefore, after: panel() }).toStrictEqual({
      besideBefore: "The facts",
      after: null,
    });
    // The page itself never moved into the panel.
    expect(host.querySelector("p")?.textContent).toBe("The page");
    act(() => {
      root.unmount();
    });
  });
});
