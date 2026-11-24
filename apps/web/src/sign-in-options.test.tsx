// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SignInOptions } from "./sign-in-options.tsx";

// The sign-in buttons on a page that asks someone to sign in first (an
// interview's, a decision's), against core's answer faked at the network:
// a press leaves for the identity provider core names, and not at all
// when the person has moved on before core answered.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const idp = "https://login.example.test/authorize";

/** Core's answer to the sign-in's start, given when `answer` is called. */
const coreAnswersLater = () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", async () => await promise);
  return () => {
    resolve(Response.json({ url: idp }));
  };
};

/** Lets every answer that has arrived be acted on. */
const settled = async (): Promise<void> => {
  await act(async () => {
    await sleep(0);
  });
};

/** The buttons, Google's pressed; where the page went, and its taking down. */
const pressed = () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider i18n={i18n}>
        <SignInOptions
          error={undefined}
          options={[{ providerId: "google", label: "Google", staff: false }]}
          returnTo="/interview"
        />
      </I18nProvider>
    );
  });
  const went = vi.spyOn(window.location, "assign").mockImplementation(() => {
    // Never leaves the test's page.
  });
  act(() => {
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Sign in with Google"))
      ?.click();
  });
  return { root, went };
};

describe("the sign-in buttons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("leave for the address core gives", async () => {
    const answer = coreAnswersLater();
    const { root, went } = pressed();
    answer();
    await settled();
    expect(went).toHaveBeenCalledWith(idp);
    act(() => {
      root.unmount();
    });
  });

  it("stay put when the person has moved on before core answered", async () => {
    const answer = coreAnswersLater();
    const { root, went } = pressed();
    act(() => {
      root.unmount();
    });
    answer();
    await settled();
    expect(went).not.toHaveBeenCalled();
  });
});
