// @vitest-environment happy-dom
import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { FindApp } from "./find-app.tsx";
import { integrationsOf } from "./integrations.ts";

// Finding an app and asking for one in the same search: the apps here
// first, what was typed offered as a request last.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Entry = OfferedCatalog["entries"][number];

const entry = (id: string, name: string): Entry => ({
  source: "native",
  id,
  name,
  categories: [],
  toolCount: 3,
  logo: null,
  description: `${name}, in a sentence.`,
  group: "Chat",
  auth: "managed",
  offered: true,
});

const mine: ListedConnection = {
  id: "c1",
  source: "native",
  provider: "microsoft",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Sanne",
  accountName: null,
  createdAt: "2026-10-01T08:00:00.000Z",
};

const integrations = integrationsOf(
  [entry("microsoft", "Microsoft 365"), entry("acme-crm", "Acme CRM")],
  [mine]
);

let root: Root | undefined;

/** The palette, open, and what it handed on. */
const opened = async () => {
  const chosen: { app?: string; request?: string } = {};
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <FindApp
          integrations={integrations}
          onApp={(key) => {
            chosen.app = key;
          }}
          onOpenChange={() => {
            // Held open.
          }}
          onRequest={(name) => {
            chosen.request = name;
          }}
          open
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return chosen;
};

const field = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="text"], input:not([type])'
  );
  if (input === null) {
    throw new Error("No search field");
  }
  return input;
};

/** Types `words` into the search, as a person does. */
const type = async (words: string): Promise<void> => {
  const input = field();
  await act(async () => {
    // The prototype's setter, so React sees a change as from typing.
    Reflect.set(HTMLInputElement.prototype, "value", words, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** The rows the palette shows now, by their words. */
const rows = (): string[] =>
  [...document.querySelectorAll('[role="option"]')].map(
    (row) => row.textContent ?? ""
  );

const press = async (words: string): Promise<void> => {
  const row = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((each) => (each.textContent ?? "").includes(words));
  await act(async () => {
    row?.click();
    await Promise.resolve();
  });
};

describe("finding an app", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows the app that matches and opens it", async () => {
    const chosen = await opened();
    await type("micro");
    expect(rows().some((row) => row.includes("Microsoft 365"))).toBeTruthy();
    await press("Microsoft 365");
    expect(chosen.app).toBe("native:microsoft");
  });

  it("offers to request an app that isn't here, with its name", async () => {
    const chosen = await opened();
    await type("Personio");
    expect(rows()).toStrictEqual([
      "Request PersonioGrasp checks what it takes to connect it.",
    ]);
    await press("Request Personio");
    expect(chosen.request).toBe("Personio");
  });
});
