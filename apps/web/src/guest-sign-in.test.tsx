// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GuestCodeSignIn } from "./guest-sign-in.tsx";

// A guest's sign-in with an emailed code, against core faked at the
// network: core sends the code at once and answers the code itself when
// the test says. Accepted, it takes the guest into the app, also when
// they went Back meanwhile: signed in, the ways in are no longer theirs.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Core's answers: the code sent at once; the code itself accepted at `accept`. */
const coreAnswersTheCodeLater = () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", async (url: string) =>
    url.endsWith("/sign-in/email-otp")
      ? await promise
      : Response.json({ success: true })
  );
  return {
    accept: () => {
      resolve(Response.json({ token: "session" }));
    },
  };
};

/** Lets every answer that has arrived be acted on. */
const settled = async (): Promise<void> => {
  await act(async () => {
    await sleep(0);
  });
};

/** Types `value` into the field labelled `label`, as a person does. */
const type = async (label: string, value: string): Promise<void> => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent.trim() === label
  );
  const field = document.querySelector<HTMLInputElement>(
    `#${CSS.escape(labelled?.htmlFor ?? "")}`
  );
  await act(async () => {
    if (field !== null) {
      Reflect.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await Promise.resolve();
  });
};

/** Presses the button that says `words`. */
const press = async (words: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === words
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
};

/** The code page, a code asked for and typed in, and sent; where the page went, and its taking down. */
const codeSent = async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider i18n={i18n}>
        <GuestCodeSignIn
          onBack={() => {
            // The way back is the page's.
          }}
        />
      </I18nProvider>
    );
  });
  const went = vi.spyOn(window.location, "assign").mockImplementation(() => {
    // Never leaves the test's page.
  });
  await type("Your email address", "guest@outside.test");
  await press("Email me a code");
  await settled();
  await type("Code", "123 456");
  await press("Sign in");
  return { root, went };
};

describe("a guest's sign-in with a code", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("takes the guest into the app once core accepts the code", async () => {
    const core = coreAnswersTheCodeLater();
    const { root, went } = await codeSent();
    core.accept();
    await settled();
    expect(went).toHaveBeenCalledWith("/");
    act(() => {
      root.unmount();
    });
  });

  it("takes the guest into the app when core accepts the code after they went Back", async () => {
    const core = coreAnswersTheCodeLater();
    const { root, went } = await codeSent();
    act(() => {
      root.unmount();
    });
    core.accept();
    await settled();
    expect(went).toHaveBeenCalledWith("/");
  });
});
