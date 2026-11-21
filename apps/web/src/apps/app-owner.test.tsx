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

/** The owner control: whom it shows, and whether it can be changed. */
const picker = () => {
  const box = document.querySelector<HTMLInputElement>("[role=combobox]");
  return { owner: box?.value ?? null, disabled: box?.disabled ?? null };
};

/** What a button says, without the words it keeps hidden while working or failed. */
const words = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent?.trim() ?? "";
};

/** Opens the list of people, and says each as it reads: their name, then what tells them apart. */
const offered = async (): Promise<string[]> => {
  const trigger = [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === "Show the people"
  );
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  return [...document.querySelectorAll("[role=option]")].map(words);
};

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
      picker: picker(),
      alert: document.querySelector("[role=alert]")?.textContent ?? null,
    }).toStrictEqual({
      picker: { owner: "Ada", disabled: false },
      alert: null,
    });
  });

  it("names its owner apart from someone of the same name who may answer for it", async () => {
    shown([{ id: "user-ada-222222", name: "Ada" }]);

    await expect(offered()).resolves.toStrictEqual([
      "AdaID …222222",
      "AdaID …ada",
    ]);
  });

  it("can't be changed while that couldn't be read, and says so, with a way to try again", () => {
    const onRetry = shown(null);
    const retry = [...document.querySelectorAll("button")].find(
      (each) => words(each) === "Try again"
    );
    act(() => {
      retry?.click();
    });

    expect({
      picker: picker(),
      alert: document.querySelector("[role=alert]")?.textContent ?? null,
      retried: onRetry.mock.calls.length,
    }).toStrictEqual({
      picker: { owner: "Ada", disabled: true },
      alert: "Couldn't load who may answer for it.",
      retried: 1,
    });
  });
});
