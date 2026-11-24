// @vitest-environment happy-dom

import type {
  DocumentPlace,
  PlaceItem,
} from "@grasp-os/shared/document-places";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PlacePicker } from "./place-picker.tsx";
import type { PickedFile } from "./place-picker.tsx";

// Where the admin picks documents in the place they live: the places, a
// folder in one, a box by each file that can be read, and the files picked
// handed over once added. Core's answers are given here; the e2e stack
// reaches no SharePoint.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const places: DocumentPlace[] = [
  { id: "site-1", name: "Finance", kind: "site" },
];

const items: PlaceItem[] = [
  {
    id: "folder-1",
    name: "Policies",
    kind: "folder",
    size: null,
    modifiedAt: null,
  },
  {
    id: "file-1",
    name: "Expense policy.pdf",
    kind: "file",
    size: 2048,
    modifiedAt: null,
  },
  {
    id: "file-2",
    name: "Team photo.png",
    kind: "file",
    size: 512,
    modifiedAt: null,
  },
];

/** Core's answers to the picker, with the folders it was asked for. */
const coreFor = (asked: (string | null)[]) => ({
  withSession: async <T,>(
    run: (session: {
      onboarding: {
        listDocumentPlaces: () => Promise<DocumentPlace[]>;
        placeItems: (input: {
          folder: string | null;
        }) => Promise<{ items: PlaceItem[]; next: string | null }>;
      };
    }) => Promise<T>
  ): Promise<T> =>
    await run({
      onboarding: {
        listDocumentPlaces: async () => await Promise.resolve(places),
        placeItems: async ({ folder }) => {
          asked.push(folder);
          return await Promise.resolve({ items, next: null });
        },
      },
    }),
});

/** Lets every pending promise and render settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settle();
};

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === name
  );

describe("the place picker", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens a place, picks the file that can be read, and hands it over once added", async () => {
    const asked: (string | null)[] = [];
    const added: PickedFile[][] = [];
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => (
          <PlacePicker
            onAdd={(files) => {
              added.push(files);
            }}
            onOpenChange={() => {
              // Open while the test runs.
            }}
            onReconnect={() => {
              // Never asked here.
            }}
            open
            suite="microsoft"
          />
        ),
      }),
      history: createMemoryHistory(),
      context: { core: coreFor(asked) },
    });
    await router.load();
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      createRoot(host).render(
        <I18nProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nProvider>
      );
      await Promise.resolve();
    });
    await settle();

    await press(buttonNamed("Finance"));
    expect(asked).toStrictEqual([null]);
    const boxes = [...document.querySelectorAll("[role='checkbox']")];
    expect(boxes.map((box) => box.getAttribute("aria-disabled"))).toStrictEqual(
      [null, "true"]
    );
    expect(document.body.textContent).toContain("Can’t be read");
    expect(buttonNamed("Add 0 documents")?.disabled).toBeTruthy();

    await press(boxes[0]);
    await press(buttonNamed("Add 1 document"));
    expect(added).toStrictEqual([
      [
        {
          place: "site-1",
          item: "file-1",
          name: "Expense policy.pdf",
          size: 2048,
        },
      ],
    ]);
  });
});
