// @vitest-environment happy-dom
import type { LinkToSend } from "@grasp-os/shared/onboarding";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { FailedMailNotice } from "./failed-mail.tsx";

// What the company's admin is told among the interviews when Grasp's mail
// with someone's link failed: who, by name, and nothing of the address.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const rendered = async (page: ReactNode): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<I18nProvider i18n={i18n}>{page}</I18nProvider>);
    await Promise.resolve();
  });
};

const text = (): string => document.body.textContent ?? "";

const link = (person: string, mailFailed: boolean): LinkToSend => ({
  person,
  name: person === "oli" ? "Oli" : "Ona",
  team: "Ops",
  email: `${person}@acme.test`,
  path: `/interview#${person}`,
  fresh: false,
  mailFailed,
});

describe("Failed mail notice", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("tells the company's admin whose mail failed, by name only", async () => {
    await rendered(
      <FailedMailNotice links={[link("oli", true), link("ona", false)]} />
    );

    expect({
      named: text().includes("Our email didn’t reach Oli."),
      others: text().includes("Ona"),
      address: text().includes("@"),
    }).toStrictEqual({
      named: true,
      others: false,
      address: false,
    });
  });

  it("says nothing while every mail reached its person", async () => {
    await rendered(
      <FailedMailNotice links={[link("oli", false), link("ona", false)]} />
    );

    expect(text()).toBe("");
  });
});
