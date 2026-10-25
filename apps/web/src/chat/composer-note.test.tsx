// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ComposerNote } from "./composer-note.tsx";

// The line under an open chat's composer: answers come from what the
// organization shared, by its name, and by "your organization" when core
// has none to give.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** What the line says for an organization named `name`. */
const said = async (name?: string): Promise<string> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <ComposerNote organizationName={name} />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return host.textContent ?? "";
};

describe("the line under an open chat's composer", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says answers come only from what the organization shared, by its name", async () => {
    await expect(said("Noordkade Finance")).resolves.toBe(
      "Answers come only from what Noordkade Finance shared, with sources."
    );
  });

  it("says your organization when core has no name for it", async () => {
    await expect(said()).resolves.toBe(
      "Answers come only from what your organization shared, with sources."
    );
  });
});
