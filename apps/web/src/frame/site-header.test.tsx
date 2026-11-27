// @vitest-environment happy-dom
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SiteHeader } from "./site-header.tsx";

// A page's own name in its bar, renamed in a small popup under it (a
// chat's, on its page): its menu's Rename opens it as F2 does; Save sends
// the new name and the popup waits while it goes, then closes on the new
// name; where it can't go the popup stays with the words typed and says
// the page's own words; no longer than the page allows.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const failed = "The chat couldn't be renamed. Try again.";

/** A page whose bar's name renames through `rename`, opened from outside as a menu's Rename. */
const Page = ({ rename }: { rename: (name: string) => Promise<void> }) => {
  const [name, setName] = useState("Leave");
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          setRenaming(true);
        }}
        type="button"
      >
        Rename from the menu
      </button>
      <SiteHeader
        crumbs={[
          {
            label: name,
            onRename: async (next: string) => {
              await rename(next);
              setName(next);
            },
            renameMaxLength: 200,
            renameErrorText: failed,
            renaming,
            onRenamingChange: setRenaming,
          },
        ]}
      />
    </>
  );
};

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const shown = async (rename: (name: string) => Promise<void>) => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <Page rename={rename} />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory(),
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button "${name}"`);
  }
  return found;
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('[role="dialog"] input');

/** Types `text` over what the field holds, as typing does. */
const typeOver = async (text: string): Promise<void> => {
  const input = field();
  if (input === null) {
    throw new Error("No rename field");
  }
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** The page's name as its bar shows it. */
const barName = (): string =>
  document.querySelector('[data-slot="app-shell-header"] [aria-current="page"]')
    ?.textContent ?? "";

describe("a page's own name in its bar", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("renames in a popup the menu opens, waiting while the name goes, then shows the new name", async () => {
    const sent: string[] = [];
    const answer = Promise.withResolvers<boolean>();
    await shown(async (name) => {
      sent.push(name);
      await answer.promise;
    });
    await press(button("Rename from the menu"));
    const opened = {
      title: (
        document.querySelector('[role="dialog"]')?.textContent ?? ""
      ).includes("Rename"),
      value: field()?.value,
      most: field()?.maxLength,
    };
    await typeOver("Annual leave");
    await press(button("Save"));
    const whileSaving = field()?.readOnly;
    await act(async () => {
      answer.resolve(true);
      await answer.promise;
    });
    await settled();

    expect({
      opened,
      whileSaving,
      sent,
      closed: field(),
      name: barName().includes("Annual leave"),
    }).toStrictEqual({
      opened: {
        title: true,
        value: "Leave",
        most: 200,
      },
      whileSaving: true,
      sent: ["Annual leave"],
      closed: null,
      name: true,
    });
  });

  it("stays open with the words typed when the rename fails, and says the page's own words", async () => {
    await shown(async () => {
      await Promise.reject(new Error("Core refused"));
    });
    await press(button("Rename from the menu"));
    await typeOver("Annual leave");
    await press(button("Save"));

    expect({
      value: field()?.value,
      said: (
        document.querySelector('[role="dialog"]')?.textContent ?? ""
      ).includes(failed),
      // Its own name still: its button's words, then the hint said after them.
      name: barName().startsWith("Leave"),
    }).toStrictEqual({
      value: "Annual leave",
      said: true,
      name: true,
    });
  });
});
