// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppShellPanelHead } from "../grasp/app-shell/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { messages as dutch } from "../locales/nl/messages.po";
import { PartWords } from "./part-words.tsx";

// What Grasp UI's parts say themselves, in the page's language: on a
// Dutch page, Dutch, from the catalog translators wrote; on an English
// page, the library's own English.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** A panel's head and a tag, as a page in `locale` draws them. */
const shown = (): void => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <PartWords>
          <AppShellPanelHead
            onExpandedChange={() => {
              // Only its name is read.
            }}
            title="Chat"
          />
          <Tag
            onRemove={() => {
              // Only its name is read.
            }}
          >
            Finance
          </Tag>
        </PartWords>
      </I18nProvider>
    );
  });
};

/** The buttons' names. */
const names = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? ""
  );

describe(PartWords, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  it("gives the parts' own words in the page's language", () => {
    i18n.loadAndActivate({ locale: "nl", messages: dutch });
    shown();

    expect(names()).toStrictEqual(["Volledig scherm", "Finance verwijderen"]);
  });

  it("leaves the parts their own English on an English page", () => {
    shown();

    expect(names()).toStrictEqual(["Full screen", "Remove Finance"]);
  });
});
