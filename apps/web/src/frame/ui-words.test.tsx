// @vitest-environment happy-dom

import { useI18n, useLocale } from "@grasp-os/ui/lib/i18n";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { messages as spanish } from "../locales/es/messages.po";
import { messages as dutch } from "../locales/nl/messages.po";
import { UiWords } from "./ui-words.tsx";

// What a Damsko component reads its own words and its language from
// (packages/ui's lib/i18n), under the app's words: the page's language,
// not Damsko's English.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A part of Damsko's, as any reads its words. */
const Part = () => {
  const { copyButton, menu } = useI18n();
  return (
    <p lang={useLocale()}>
      {copyButton.copyError}, {menu.loading}, {menu.error}
    </p>
  );
};

const drawn = async (): Promise<HTMLElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <I18nProvider i18n={i18n}>
        <UiWords>
          <Part />
        </UiWords>
      </I18nProvider>
    );
    await Promise.resolve();
  });
  const part = host.querySelector("p");
  if (!part) {
    throw new Error("Nothing was drawn.");
  }
  return part;
};

describe("Damsko's own words", () => {
  afterEach(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
    document.body.replaceChildren();
  });

  it("are English in English", async () => {
    const part = await drawn();
    expect(part.textContent).toBe("Not copied, Working, Failed");
    expect(part.lang).toBe("en");
  });

  it("are the page's language's", async () => {
    i18n.loadAndActivate({ locale: "nl", messages: dutch });
    const part = await drawn();
    expect(part.textContent).toBe("Niet gekopieerd, Bezig, Mislukt");
    expect(part.lang).toBe("nl");
  });

  it("are a menu item's, not a run's status, where a language words them otherwise", async () => {
    i18n.loadAndActivate({ locale: "es", messages: spanish });
    const part = await drawn();
    expect(part.textContent).toBe("No copiado, Trabajando, Error");
  });
});
