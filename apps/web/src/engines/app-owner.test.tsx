// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AppOwner } from "./app-owner.tsx";

// An App's owner on its settings page: named from those core says may
// answer for it. A list that couldn't be read is never shown as nobody
// else to pick: the picker can't be changed, and says how to try again.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const owner = { id: "ada", name: "Ada" };

/** The owner control, with `answerers`; what retrying it calls. */
const shown = (answerers: readonly { id: string; name: string }[] | null) => {
  const onRetry = vi.fn<() => void>();
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AppOwner
          answerers={answerers}
          disabled={false}
          onPick={() => {
            // Nothing is picked here.
          }}
          onRetry={onRetry}
          owner={owner}
        />
      </I18nProvider>
    );
  });
  return onRetry;
};

/** Each button, the owner's by their name, and whether it can be pressed. */
const buttons = () =>
  [...document.querySelectorAll("button")].map((each) => {
    const text = each.textContent?.trim() ?? "";
    // The owner's button shows their initial before their name.
    return {
      text: text.endsWith(owner.name) ? owner.name : text,
      disabled: each.disabled,
    };
  });

describe("an App's owner in its settings", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("can be changed once who may answer for it was read", () => {
    shown([{ id: "grace", name: "Grace" }]);

    expect({
      buttons: buttons(),
      alert: document.querySelector("[role=alert]")?.textContent ?? null,
    }).toStrictEqual({
      buttons: [{ text: "Ada", disabled: false }],
      alert: null,
    });
  });

  it("can't be changed while that couldn't be read, and says so, with a way to try again", () => {
    const onRetry = shown(null);
    const retry = [...document.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === "Try again"
    );
    act(() => {
      retry?.click();
    });

    expect({
      buttons: buttons(),
      alert: document.querySelector("[role=alert]")?.textContent ?? null,
      retried: onRetry.mock.calls.length,
    }).toStrictEqual({
      buttons: [
        { text: "Ada", disabled: true },
        { text: "Try again", disabled: false },
      ],
      alert: "Couldn't load who may answer for it.",
      retried: 1,
    });
  });
});
