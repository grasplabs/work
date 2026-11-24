// @vitest-environment happy-dom
import type { ModelMonthSpend, ModelSettings } from "@grasp-os/shared/models";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { Loaded } from "../load-from-core.tsx";
import { SpendCard } from "./ai-spend.tsx";

// Settings › AI and spend › Spend, on what core's `models.spend()` and
// `models.settings()` answered: the month's total, and where it went,
// with the Apps' part from the settings.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Nothing spent this month: the total alone, no breakdown to draw. */
const quietMonth: ModelMonthSpend = {
  month: "2026-11",
  total: 0,
  days: [{ date: "2026-11-01", amount: 0 }],
  chat: 0,
  workflows: [],
  more: false,
};

/** The card's words, on `spend` and `settings`. */
const shown = (
  spend: Loaded<ModelMonthSpend>,
  settings: Loaded<ModelSettings>
): string => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <SpendCard settings={settings} spend={spend} />
      </I18nProvider>
    );
  });
  return host.textContent ?? "";
};

describe("Settings › AI and spend › Spend", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("says the Apps' spend couldn't be read, and why, rather than leaving it out unsaid", () => {
    const text = shown(
      { state: "ready", data: quietMonth },
      { state: "refused", message: "Core refused the read." }
    );

    expect({
      total: text.includes("$0.00"),
      said: text.includes(
        "What the Apps spent couldn't be read, so it is left out here. Core refused the read."
      ),
    }).toStrictEqual({ total: true, said: true });
  });

  it("says nothing of it once the Apps' spend was read", () => {
    const text = shown(
      { state: "ready", data: quietMonth },
      {
        state: "ready",
        data: {
          models: [],
          month: "2026-11",
          bindings: { listed: [], more: false },
        },
      }
    );

    expect(text).not.toContain("couldn't be read");
  });
});
