// @vitest-environment happy-dom
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatComposer } from "./chat-composer.tsx";
import type { ChatComposerProps } from "./chat-composer.tsx";
import type { Mentionable } from "./mentions.tsx";

// The running chat's box: what is typed goes with Send, Stop stops the
// answer while Grasp writes it, the files a question carries show with a
// way to take each off, a pick after `@` goes with the question for as
// long as its `@name` stays in the text, and with no AI provider to call
// it takes nothing and says how to connect one.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The mentions the box holds, as the page last heard them. */
let held: readonly Mentionable[] = [];

/** What the page heard from the box. */
const heard: string[] = [];

/** Where the box says Grasp is. */
const activity = (): string | null =>
  document.querySelector<HTMLElement>("[data-activity]")?.dataset.activity ??
  null;

/**
 * The box, its text and mentions kept as a page keeps them; `props` over a
 * ready box. Answering, beside it, is the page saying Grasp started or
 * finished an answer.
 */
const Box = ({ props }: { props: Partial<ChatComposerProps> }) => {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(props.running ?? false);
  const [mentions, setMentions] = useState<readonly Mentionable[]>([]);
  return (
    <>
      <button
        aria-label="Answering"
        onClick={() => {
          setRunning((now) => !now);
        }}
        type="button"
      >
        Answering
      </button>
      <ChatComposer
        busy={false}
        mentions={mentions}
        model="openai/gpt-5"
        models={["openai/gpt-5"]}
        onMentions={(next) => {
          held = next;
          setMentions(next);
        }}
        onSend={() => {
          heard.push(`send ${text}`);
        }}
        onStop={() => {
          heard.push("stop");
        }}
        onText={setText}
        text={text}
        {...props}
        running={running}
      />
    </>
  );
};

const core = {
  withSession: async <T,>(
    read: (session: {
      apps: { list: () => Promise<{ id: string; name: string }[]> };
      workflowResources: { list: () => Promise<[]> };
      chats: { people: () => Promise<[]> };
    }) => Promise<T>
  ): Promise<T> =>
    await read({
      apps: {
        list: async () =>
          await Promise.resolve([{ id: "app-1", name: "Expenses" }]),
      },
      workflowResources: { list: async () => await Promise.resolve([]) },
      chats: { people: async () => await Promise.resolve([]) },
    }),
};

const identity: Identity = {
  userId: "ada",
  email: "ada@acme.test",
  name: "Ada",
  role: "admin",
  teams: [],
  staff: false,
  expiresAt: "2026-10-23T00:00:00.000Z",
};

/** The box on a page of the app's frame, as `props` set it. */
const shown = async (props: Partial<ChatComposerProps> = {}): Promise<void> => {
  const rootRoute = createRootRoute();
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity }),
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/",
    component: () => <Box props={props} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page])]),
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
};

/** The box's text field. */
const field = (): HTMLTextAreaElement => {
  const found = document.querySelector("textarea");
  if (found === null) {
    throw new Error("No box");
  }
  return found;
};

/** Writes `text` into the box, as typing would, the caret at its end. */
const type = (text: string): void => {
  const area = field();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(area, text);
    area.setSelectionRange(text.length, text.length);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** The button a person knows by the name `name`. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

/** The model and effort control's name, as a screen reader hears it. */
const control = (): string =>
  [...document.querySelectorAll("button")]
    .map((each) => each.getAttribute("aria-label") ?? "")
    .find((name) => name.startsWith("Model and effort")) ?? "none";

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};

describe(ChatComposer, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    held = [];
    heard.length = 0;
    document.body.replaceChildren();
  });

  it("sends what is typed, and stops the answer while Grasp writes it", async () => {
    await shown();
    type("What is 2 + 2?");
    await press(button("Send"));
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown({ running: true });
    await press(button("Stop"));

    expect(heard).toStrictEqual(["send What is 2 + 2?", "stop"]);
  });

  it("says a question didn't go and why, keeps it in the box, and Send sends it again", async () => {
    let tries = 0;
    await shown({
      failure: "Grasp can't be reached right now.",
      onSend: async () => {
        tries += 1;
        await Promise.resolve();
        if (tries === 1) {
          throw new Error("not sent");
        }
      },
    });
    type("What is 2 + 2?");
    await press(button("Send"));
    const said = await vi.waitFor(() => {
      const alert = document.querySelector('[role="alert"]')?.textContent;
      if (alert === undefined) {
        throw new Error("Nothing said");
      }
      return `${alert} ${document.body.textContent}`;
    });
    const kept = field().value;
    await press(button("Send"));

    expect({
      failed: said.includes("Could not send"),
      why: said.includes("Grasp can't be reached right now."),
      kept,
      tries,
    }).toStrictEqual({
      failed: true,
      why: true,
      kept: "What is 2 + 2?",
      tries: 2,
    });
  });

  it("says an answer is done once Grasp finishes it, and works again with the next", async () => {
    await shown({ running: true });
    const working = activity();
    await press(button("Answering"));
    const done = activity();
    await press(button("Answering"));

    expect({ working, done, again: activity() }).toStrictEqual({
      working: "working",
      done: "success",
      again: "working",
    });
  });

  it("shows the files a question carries by name and size, none said uploaded before it is sent, each to take off", async () => {
    const removed: string[] = [];
    await shown({
      files: [
        { id: "f1", name: "notes.pdf", bytes: 2048 },
        { id: "f2", name: "plan.docx", bytes: 1024 },
      ],
      onRemoveFile: (id) => {
        removed.push(id);
      },
    });
    const files = document.querySelector(
      '[aria-label="Files to send"]'
    )?.textContent;
    await press(button("Remove notes.pdf"));

    expect({
      names: ["notes.pdf", "plan.docx"].map((name) => files?.includes(name)),
      // As work's formatBytes writes a size in the page's language.
      sizes: ["2 kB", "1 kB"].map((size) => files?.includes(size)),
      uploaded: /upload/iu.test(files ?? ""),
      removed,
    }).toStrictEqual({
      names: [true, true],
      sizes: [true, true],
      uploaded: false,
      removed: ["f1"],
    });
  });

  it("offers the model and how hard it thinks as one control, and an agent's own model as the only one", async () => {
    await shown({
      efforts: ["low", "medium", "high"],
      effort: "medium",
      models: ["openai/gpt-5", "anthropic/claude"],
    });
    const offered = control();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown({ agentModel: "anthropic/claude" });

    const agents = control();

    expect({
      offered: /gpt-5.*Medium/u.test(offered),
      agents: agents.includes("claude") && !agents.includes("gpt-5"),
    }).toStrictEqual({ offered: true, agents: true });
  });

  it("takes nothing with no AI provider to call, and says how to connect one", async () => {
    await shown({ model: "", models: [] });

    expect({
      typing: field().disabled || field().readOnly,
      way: document.querySelector('a[href="/settings/ai-providers"]') !== null,
    }).toStrictEqual({ typing: true, way: true });
  });

  it("mentions what is picked after @, until its name is gone from the text", async () => {
    await shown();
    type("Check @");
    type("Check @Exp");
    const pick = await vi.waitFor(() => {
      const option = [...document.querySelectorAll('[role="option"]')].find(
        (each) => each.textContent?.includes("Expenses")
      );
      if (!(option instanceof HTMLElement)) {
        throw new Error("Expenses is not offered");
      }
      return option;
    });
    act(() => {
      pick.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    const picked = held.map(({ kind, id }) => `${kind}:${id}`);
    const text = field().value;
    type("Check @Expensesheet");
    const longer = held.length;
    type("Check the receipts");

    expect({ picked, text, longer, after: held }).toStrictEqual({
      picked: ["app:app-1"],
      text: "Check @Expenses ",
      longer: 0,
      after: [],
    });
  });
});
