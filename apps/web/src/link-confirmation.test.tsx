// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { LinkConfirmDialog } from "./link-confirmation.tsx";
import type { PendingLink } from "./link-confirmation.tsx";

// Grasp's own link confirmation as the person reaches it: Open counts
// once its delay passed, also for assistive technology, which activates
// the button with a click alone, no pointer press or key before it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Longer than the dialog keeps Open disabled once it shows. */
const pastDelayMs = 1100;

let root: Root | undefined;

/** The dialog open on `pending`; returns the links confirmed. */
const opened = async (pending: PendingLink): Promise<PendingLink[]> => {
  const confirmed: PendingLink[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <LinkConfirmDialog
          onCancel={() => {
            // The test reads what Open confirmed.
          }}
          onConfirm={(link) => {
            confirmed.push(link);
          }}
          pending={pending}
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return confirmed;
};

/** Waits `ms`, letting renders settle. */
const waited = async (ms: number): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, ms);
    await promise;
  });
};

const openButton = (): HTMLButtonElement => {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Open"
  );
  if (button === undefined) {
    throw new Error("No Open button.");
  }
  return button;
};

/** A click with nothing before it: what a screen reader's activate sends. */
const assistiveClick = async (button: HTMLElement): Promise<void> => {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })
    );
    await Promise.resolve();
  });
};

describe("a link's confirmation", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("opens for a screen reader's activate once Open is enabled", async () => {
    const link = { origin: "https://help.example.com" };
    const confirmed = await opened(link);
    await waited(pastDelayMs);

    await assistiveClick(openButton());

    expect(confirmed).toStrictEqual([link]);
  });

  it("opens nothing for a pointer's click whose press began while Open was disabled", async () => {
    const confirmed = await opened({ origin: "https://help.example.com" });
    // Pressed while Open was disabled, released once it was enabled: the
    // click a screen could time its request for.
    await act(async () => {
      openButton().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
      await Promise.resolve();
    });
    await waited(pastDelayMs);

    await act(async () => {
      openButton().dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })
      );
      await Promise.resolve();
    });

    expect(confirmed).toStrictEqual([]);
  });
});
