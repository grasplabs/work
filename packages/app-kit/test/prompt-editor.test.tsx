// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PromptEditor } from "../src/components/prompt-editor.tsx";
import type {
  PromptContent,
  PromptMention,
  PromptSuggestion,
} from "../src/components/prompt-editor.tsx";
import { typeInPrompt } from "./prompt-typing.ts";

// The box to ask in, with mentions: typing a trigger lists what matches
// what follows it, picking one puts it in the text as a chip where it was
// typed, and the page hears the text and what it mentions; Enter sends
// unless the list is open, and a page that empties its value empties the
// box.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mentionables: PromptSuggestion[] = [
  { kind: "app", id: "invoice-desk", label: "Invoices" },
  { kind: "workflow", id: "month-end", label: "Month end" },
  { kind: "person", id: "user-1", label: "Ines", description: "Builder" },
];

const kinds = {
  app: { label: "Apps", icon: null, tone: "app" as const },
  workflow: { label: "Workflows", icon: null, tone: "workflow" as const },
  person: { label: "People", icon: null, tone: "person" as const },
};

const triggers = [
  {
    char: "@",
    suggest: (query: string) =>
      mentionables.filter(({ label }) =>
        label.toLowerCase().includes(query.toLowerCase())
      ),
    empty: "Nothing found",
  },
];

let root: Root | undefined;

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/** Lets the editor's updates and the list's render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The box, held by a page that empties it with a button, as after a send. */
const placed = async () => {
  const heard: PromptContent[] = [];
  let sent = 0;
  const Page = () => {
    const [value, setValue] = useState("");
    return (
      <>
        <PromptEditor
          kinds={kinds}
          label="Ask"
          onChange={(content) => {
            heard.push(content);
            setValue(content.text);
          }}
          onSubmit={() => {
            sent += 1;
          }}
          triggers={triggers}
          value={value}
        />
        <button
          onClick={() => {
            setValue("");
          }}
          type="button"
        >
          Empty
        </button>
      </>
    );
  };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<Page />);
    await Promise.resolve();
  });
  await settled();
  return {
    heard,
    sent: () => sent,
  };
};

/**
 * Two boxes holding one text and its mentions, as the chat's bar and its
 * box do: what is typed in either is the other's too.
 */
const placedTwice = async () => {
  const Page = () => {
    const [content, setContent] = useState<{
      text: string;
      mentions: readonly PromptMention[];
    }>({ text: "", mentions: [] });
    return ["First", "Second"].map((label) => (
      <PromptEditor
        key={label}
        kinds={kinds}
        label={label}
        mentions={content.mentions}
        onChange={setContent}
        onSubmit={() => {
          // Nothing is sent here.
        }}
        triggers={triggers}
        value={content.text}
      />
    ));
  };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<Page />);
    await Promise.resolve();
  });
  await settled();
};

const boxNamed = (label: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[role="textbox"][aria-label="${label}"]`
  );
  if (found === null) {
    throw new Error(`No box ${label}`);
  }
  return found;
};

const box = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[role="textbox"]');
  if (found === null) {
    throw new Error("No box");
  }
  return found;
};

const type = async (text: string): Promise<void> => {
  await act(async () => {
    typeInPrompt(box(), text);
    await Promise.resolve();
  });
  await settled();
};

const press = async (key: string): Promise<void> => {
  await act(async () => {
    box().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
    await Promise.resolve();
  });
  await settled();
};

/** What the open list offers, by label. */
const offered = (): string[] =>
  [...document.querySelectorAll('[data-slot="command-item"]')].map(
    (item) => item.textContent
  );

describe("the box to ask in, with mentions", () => {
  afterEach(unmount);

  it("lists what matches what follows the trigger, and puts what is picked in the text as a chip", async () => {
    const { heard } = await placed();
    await type("Ask @in");
    const listed = offered();
    await press("Enter");

    expect({
      listed,
      chips: [...box().querySelectorAll('[data-kind="app"]')].map(
        (chip) => chip.textContent
      ),
      heard: heard.at(-1),
      closed: offered(),
    }).toStrictEqual({
      // "in" is in Invoices and in Ines.
      listed: ["Invoices", "InesBuilder"],
      chips: ["Invoices"],
      heard: {
        text: "Ask @Invoices ",
        mentions: [
          { kind: "app", id: "invoice-desk", label: "Invoices", trigger: "@" },
        ],
      },
      closed: [],
    });
  });

  it("picks with the arrow keys, and sends with Enter only while nothing is listed", async () => {
    const { heard, sent } = await placed();
    await type("Tell @");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Enter");
    const sentWhilePicking = sent();
    await press("Enter");

    expect({
      mentions: heard.at(-1)?.mentions.map(({ id }) => id),
      sentWhilePicking,
      sent: sent(),
    }).toStrictEqual({
      mentions: ["user-1"],
      sentWhilePicking: 0,
      sent: 1,
    });
  });

  it("shows what another box holding the same text mentions as chips, with no list of its own while the person types in the other", async () => {
    await placedTwice();
    await act(async () => {
      typeInPrompt(boxNamed("First"), "Ask @in");
      await Promise.resolve();
    });
    await settled();
    const listed = offered();
    await act(async () => {
      boxNamed("First").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
      await Promise.resolve();
    });
    await settled();

    expect({
      listed,
      second: boxNamed("Second").textContent,
      chips: [...boxNamed("Second").querySelectorAll('[data-kind="app"]')].map(
        (chip) => chip.textContent
      ),
    }).toStrictEqual({
      // The first box's list alone.
      listed: ["Invoices", "InesBuilder"],
      second: "Ask Invoices ",
      chips: ["Invoices"],
    });
  });

  it("empties when the page empties its value", async () => {
    await placed();
    await type("Ask @mon");
    await press("Enter");
    await act(async () => {
      document.querySelector("button")?.click();
      await Promise.resolve();
    });
    await settled();

    expect({
      text: box().textContent,
      chips: box().querySelectorAll("[data-kind]").length,
    }).toStrictEqual({ text: "", chips: 0 });
  });
});
