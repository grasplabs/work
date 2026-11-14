// @vitest-environment happy-dom
import type {
  InstructionFileRef,
  InstructionFileText,
} from "@grasp-os/shared/instruction-files";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { InstructionFileEditor } from "./instruction-file.tsx";

// An instruction file edited from a page, against core's instruction files
// as the page reaches them over RPC (the boundary from the web app), faked
// as core keeps them: one version per change, so a retried save is saved
// once. These start from the ways it can fail: a save whose answer is lost
// on its way back, then an edit taken for that same save and dropped; what
// the page shows after a save not being what core holds; an empty file
// saved.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const own: InstructionFileRef = { scope: "person", personId: "person-1" };

/**
 * Core's instruction files, keeping one file: one version per change, a
 * save refused once another was saved after the version it was edited
 * from, and the answer to the first save lost when `lostOnce`.
 */
const fakeInstructions = (lostOnce = false) => {
  const versions: string[] = [];
  const changes = new Map<string, number>();
  let lose = lostOnce;
  const instructions = {
    read: async (): Promise<InstructionFileText | null> => {
      await Promise.resolve();
      const text = versions.at(-1);
      return text === undefined ? null : { version: versions.length, text };
    },
    save: async (saved: {
      file: InstructionFileRef;
      change: string;
      text: string;
      after: number;
    }): Promise<{ version: number }> => {
      await Promise.resolve();
      const before = changes.get(saved.change);
      if (before === undefined && saved.after !== versions.length) {
        throw new Error(
          "Someone saved this instruction file since you opened it."
        );
      }
      const version = before ?? versions.push(saved.text);
      changes.set(saved.change, version);
      if (lose) {
        lose = false;
        throw new Error("The connection dropped.");
      }
      return { version };
    },
  };
  /** Someone else saves `text`, on another page. */
  const savedElsewhere = (text: string) => {
    versions.push(text);
  };
  return { session: { instructions }, versions, savedElsewhere };
};

let root: Root | undefined;

/** The editor of the person's own file on what `session` holds. */
const shown = async (
  session: ReturnType<typeof fakeInstructions>["session"]
): Promise<{ reread: () => Promise<void> }> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await session.instructions.read(),
    component: () => (
      <InstructionFileEditor
        description="Only yours."
        file={own}
        label="Your instructions"
        saved={rootRoute.useLoaderData()}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
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
  // The page read again, as a person's next visit to it reads it.
  const reread = async () => {
    await act(async () => {
      await router.invalidate({ sync: true });
    });
  };
  return { reread };
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const saveButton = (): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Save"
  );
  if (found === undefined) {
    throw new TypeError("No Save button");
  }
  return found;
};

const field = (): HTMLTextAreaElement => {
  const found = document.querySelector("textarea");
  if (found === null) {
    throw new TypeError("No field");
  }
  return found;
};

/** Types `text` into the field, as a person does. */
const type = async (text: string): Promise<void> => {
  await act(async () => {
    // React tracks the value it set: the element's own setter, as typing
    // goes through, is what it hears change.
    Reflect.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(field(), text);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const text = (): string => document.body.textContent ?? "";

/** Presses the button named `name`. */
const press = async (name: string): Promise<void> => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

const save = async (): Promise<void> => {
  await act(async () => {
    saveButton().click();
    await Promise.resolve();
  });
  await settled();
};

describe("Settings › Instructions", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("saves the whole file as its next version, and shows what core holds after", async () => {
    const { session, versions } = fakeInstructions();
    await shown(session);
    const before = { disabled: saveButton().disabled, text: field().value };

    await type("Short answers.");
    await save();
    await type("Short answers, in Dutch.");
    await save();

    expect({
      before,
      versions,
      shown: field().value,
      disabled: saveButton().disabled,
    }).toStrictEqual({
      before: { disabled: true, text: "" },
      versions: ["Short answers.", "Short answers, in Dutch."],
      shown: "Short answers, in Dutch.",
      disabled: true,
    });
  });

  it("shows a save whose answer was lost as core holds it, and saves the next edit as a version of its own", async () => {
    const { session, versions } = fakeInstructions(true);
    await shown(session);

    await type("Short answers.");
    await save();
    const failed = document.querySelector('[role="alert"]') !== null;
    const shownAfter = field().value;
    await type("Long answers.");
    await save();

    expect({ failed, shownAfter, versions }).toStrictEqual({
      failed: true,
      shownAfter: "Short answers.",
      versions: ["Short answers.", "Long answers."],
    });
  });

  it("saves a text it saved before, once someone saved another since, as a version of its own", async () => {
    const { session, versions, savedElsewhere } = fakeInstructions();
    const { reread } = await shown(session);

    await type("Short answers.");
    await save();
    savedElsewhere("Long answers.");
    await reread();
    await type("Short answers.");
    await save();

    expect({ versions, shown: field().value }).toStrictEqual({
      versions: ["Short answers.", "Long answers.", "Short answers."],
      shown: "Short answers.",
    });
  });

  it("never saves over a version saved since they started, and shows theirs once these changes are put aside", async () => {
    const { session, versions, savedElsewhere } = fakeInstructions();
    await shown(session);

    await type("Mine.");
    savedElsewhere("Theirs.");
    await save();
    const conflict = {
      said: text().includes("Someone saved this file since you started."),
      saveable: !saveButton().disabled,
    };
    await press("Put my changes aside");

    expect({ conflict, versions, shown: field().value }).toStrictEqual({
      conflict: { said: true, saveable: false },
      versions: ["Theirs."],
      shown: "Theirs.",
    });
  });

  it("empties a file that has text, and saves no empty file that never had any", async () => {
    const { session, versions } = fakeInstructions();
    await shown(session);
    await type("   ");
    const emptyNew = saveButton().disabled;

    await type("Short answers.");
    await save();
    await type("   ");
    await save();

    expect({ emptyNew, versions }).toStrictEqual({
      emptyNew: true,
      versions: ["Short answers.", ""],
    });
  });
});
