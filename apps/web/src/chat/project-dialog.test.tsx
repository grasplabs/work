// @vitest-environment happy-dom
import type { ChatProject, ProjectDocument } from "@grasp-os/shared/chat";
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

import { ProjectDialog } from "./project-dialog.tsx";

// The project dialog against core's chats as the page reaches them over
// RPC (the boundary from the web app), faked: a Save that fails part-way
// is taken up again from where it stopped, keeping what the person
// changed meanwhile and what core already holds, and nothing in the form
// changes while a Save runs.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A document core holds, as it answers adding one named `name`. */
const documentNamed = (name: string): ProjectDocument => ({
  id: `doc-${name}`,
  name,
  bytes: 10,
  createdAt: "2026-10-20T08:00:00.000Z",
});

/** Core's project calls, failing the write numbered `failing` (from 1) once. */
const fakeChats = (failing?: number) => {
  const writes: string[] = [];
  let count = 0;
  /** Counts a write, failing it when it is the one to fail. */
  const wrote = async (call: string): Promise<void> => {
    count += 1;
    writes.push(call);
    if (count === failing) {
      throw new Error("Core couldn't take it just now.");
    }
    await Promise.resolve();
  };
  return {
    writes,
    chats: {
      createProject: async (name: string): Promise<ChatProject> => {
        await wrote(`create ${name}`);
        return {
          id: "project-1",
          name,
          goal: "",
          createdAt: "2026-10-20T08:00:00.000Z",
          documents: [],
        };
      },
      renameProject: async (id: string, name: string) => {
        await wrote(`rename ${id} ${name}`);
      },
      setProjectGoal: async (id: string, goal: string) => {
        await wrote(`goal ${id} ${goal}`);
      },
      addProjectDocument: async (id: string, added: { name: string }) => {
        await wrote(`add ${id} ${added.name}`);
        return documentNamed(added.name);
      },
      removeProjectDocument: async (id: string, documentId: string) => {
        await wrote(`remove ${id} ${documentId}`);
      },
    },
  };
};

let root: Root | undefined;

/** The dialog open on `project` (none: a new one), against `chats`. */
const opened = async (
  chats: ReturnType<typeof fakeChats>["chats"],
  project?: ChatProject
): Promise<{ saved: string[] }> => {
  const saved: string[] = [];
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ProjectDialog
        onOpenChange={() => {
          // The test reads what Save did, not the dialog closing.
        }}
        onSaved={(id) => {
          saved.push(id);
        }}
        open
        project={project}
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
  return { saved };
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

/** The input `selector` finds. */
const inputAt = (selector: string): HTMLInputElement => {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLInputElement)) {
    throw new TypeError(`No input ${selector}`);
  }
  return found;
};

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

const nameField = () =>
  inputAt('input[placeholder="What are you working on?"]');
const goalField = (): HTMLTextAreaElement => {
  const found = document.querySelector(
    'textarea[placeholder="What are you trying to achieve?"]'
  );
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new TypeError("No goal field");
  }
  return found;
};

/** Types `value` into `element`, as React hears a person type. */
const type = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
): Promise<void> => {
  await act(async () => {
    // React tracks the value it set: the element's own setter, as typing
    // goes through, is what it hears change.
    const prototype = Reflect.getPrototypeOf(element) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** Picks `names` as text files in the document picker. */
const pick = async (...names: string[]): Promise<void> => {
  const input = inputAt('input[type="file"]');
  const files = names.map((name) => new File(["# Notes"], name));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The documents the form lists. */
const listedDocuments = (): string[] =>
  [
    ...document.querySelectorAll(
      'ul[aria-label="Documents in this project"] li'
    ),
  ].map((item) => item.textContent?.trim() ?? "");

const project: ChatProject = {
  id: "project-1",
  name: "Board report",
  goal: "Out by Friday",
  createdAt: "2026-10-20T08:00:00.000Z",
  documents: [],
};

describe("saving a project", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("keeps a rename made after a Save that failed part-way, making the project once", async () => {
    const { writes, chats } = fakeChats(2);
    const { saved } = await opened(chats);
    await type(nameField(), "Board report");
    await type(goalField(), "Out by Friday");
    await click(button("Create project"));
    const afterFailure = [...writes];
    const failed = document.querySelector('[role="alert"]')?.textContent;

    await type(nameField(), "Board report Q3");
    await click(button("Create project"));

    expect({ afterFailure, failed, writes, saved }).toStrictEqual({
      afterFailure: ["create Board report", "goal project-1 Out by Friday"],
      failed: "Core couldn't take it just now.",
      writes: [
        "create Board report",
        "goal project-1 Out by Friday",
        "rename project-1 Board report Q3",
        "goal project-1 Out by Friday",
      ],
      saved: ["project-1"],
    });
  });

  it("lists a document core took before a later one failed, and removes it from there", async () => {
    const { writes, chats } = fakeChats(2);
    const { saved } = await opened(chats, project);
    await pick("brief.md", "figures.csv");
    await click(button("Save"));
    const listedAfterFailure = listedDocuments();

    await click(button("Remove brief.md"));
    await click(button("Save"));

    expect({ listedAfterFailure, writes, saved }).toStrictEqual({
      listedAfterFailure: ["brief.md", "figures.csv"],
      writes: [
        "add project-1 brief.md",
        "add project-1 figures.csv",
        "remove project-1 doc-brief.md",
        "add project-1 figures.csv",
      ],
      saved: ["project-1"],
    });
  });

  it("changes nothing in the form while a Save runs", async () => {
    let answer: (() => void) | undefined;
    const { chats } = fakeChats();
    const held = {
      ...chats,
      setProjectGoal: async () => {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        answer = () => {
          resolve(true);
        };
        await promise;
      },
    };
    await opened(held, project);
    await pick("brief.md");
    await type(goalField(), "Out by Monday");
    await click(button("Save"));
    const during = {
      name: nameField().disabled,
      goal: goalField().disabled,
      add: button("Add documents").disabled,
      remove: button("Remove brief.md").disabled,
      save: button("Save").disabled,
    };
    answer?.();
    await settled();

    expect(during).toStrictEqual({
      name: true,
      goal: true,
      add: true,
      remove: true,
      save: true,
    });
  });
});
