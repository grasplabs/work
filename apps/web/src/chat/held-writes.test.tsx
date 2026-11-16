// @vitest-environment happy-dom
import { heldAppCallsPage } from "@grasp-os/shared/chat";
import type { HeldAppCall } from "@grasp-os/shared/chat";
import type { PendingAction } from "@grasp-os/shared/connect";
import {
  agentIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
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

import { HeldWrites } from "./held-writes.tsx";

// A write to an App held because the chat used something only the person
// can read (held-app-calls.ts in core), against core's chats and pending
// actions as the page reaches them over RPC, faked: the card says why it
// waits and shows exactly the request that would run, before anything is
// pressed; confirming names that request's hash, and rejecting runs
// nothing. A decision that fails is said above the list, as its card
// may be gone, until the next decision, and in its own chat alone.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const request = JSON.stringify({
  reference: { name: "notes.create", kind: "mutation" },
  args: { title: "My salary is 4,200 a month" },
});

const held: HeldAppCall = {
  id: "held-1",
  appId: "app-1",
  appName: "Notes",
  function: "notes.create",
  kind: "mutation",
  request,
  requestHash: "b".repeat(64),
  heldAt: "2026-11-15T10:00:00.000Z",
  expiresAt: "2026-11-16T10:00:00.000Z",
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** A mail connect holds for the person in chat `chat-1`, as its card shows it. */
const mail: PendingAction = {
  id: "pending-1",
  subject: { type: "agent", agentId: agentIdSchema.parse("agent-1") },
  appVersion: null,
  mode: "interactive",
  context: {
    type: "chat",
    workspaceId: workspaceIdSchema.parse("person:someone"),
    chatId: chatIdSchema.parse("chat-1"),
  },
  restricted: false,
  permissionId: "permission-1",
  binding: null,
  connectionId: "connection-1",
  connectionName: "Outlook",
  resource: null,
  action: "mail.send",
  idempotencyKey: "key-1",
  input: JSON.stringify({ to: "ben@acme.test", subject: "Invoice" }),
  inputHash: "c".repeat(64),
  requestedAt: "2026-11-15T10:00:00.000Z",
};

/** What a core holds, and how it answers decisions. */
interface Held {
  /** The App writes held in each chat, by its ID. */
  calls?: Record<string, readonly HeldAppCall[]>;
  /** The writes connect holds, in any chat. */
  actions?: readonly PendingAction[];
  /** Each decision of these holds or actions fails with its error. */
  refusing?: Record<string, Error>;
  /**
   * Each decision of these fails with its error before it is taken: the
   * write still waits, as connect leaves an action it refused to take.
   */
  refusingBefore?: Record<string, Error>;
  /** Each decision of these waits for its promise before it is taken. */
  waiting?: Record<string, Promise<unknown>>;
}

/** A chat's held writes, with a way to open another chat in the same place. */
const Switching = () => {
  const [chatId, setChatId] = useState("chat-1");
  return (
    <>
      <button
        aria-label="Open chat-2"
        onClick={() => {
          setChatId("chat-2");
        }}
        type="button"
      />
      <HeldWrites chatId={chatId} version={0} />
    </>
  );
};

/**
 * The chat's held writes against a core holding `held` (one App write in
 * `chat-1` by default) until each is decided, App writes a page of
 * `heldAppCallsPage` at a time. A decision ends its hold however it went,
 * as core's and connect's do once they take it; one in `refusing` fails.
 */
const shown = async ({
  calls = { "chat-1": [held] },
  actions = [],
  refusing = {},
  refusingBefore = {},
  waiting: slow = {},
}: Held = {}) => {
  const confirmed: { chatId: string; id: string; requestHash: string }[] = [];
  const declined: { chatId: string; id: string }[] = [];
  const decided = new Set<string>();
  /** Decides `id`: ended either way, refused when `refusing` says so. */
  const decide = async (id: string): Promise<void> => {
    await slow[id];
    const before = refusingBefore[id];
    if (before !== undefined) {
      throw before;
    }
    decided.add(id);
    const refusal = refusing[id];
    if (refusal !== undefined) {
      throw refusal;
    }
  };
  const session = {
    chats: {
      heldCalls: async (
        chatId: string,
        after?: string
      ): Promise<HeldAppCall[]> => {
        const waiting = (calls[chatId] ?? []).filter(
          ({ id }) => !decided.has(id)
        );
        const from =
          after === undefined
            ? 0
            : waiting.findIndex(({ id }) => id === after) + 1;
        return await Promise.resolve(
          waiting.slice(from, from + heldAppCallsPage)
        );
      },
      confirmHeldCall: async (
        chatId: string,
        id: string,
        requestHash: string
      ): Promise<void> => {
        await Promise.resolve();
        confirmed.push({ chatId, id, requestHash });
        await decide(id);
      },
      declineHeldCall: async (chatId: string, id: string): Promise<void> => {
        await Promise.resolve();
        declined.push({ chatId, id });
        await decide(id);
      },
    },
    pendingActions: {
      list: async (): Promise<PendingAction[]> =>
        await Promise.resolve(actions.filter(({ id }) => !decided.has(id))),
      confirm: async (id: string): Promise<void> => {
        await decide(id);
      },
      decline: async (id: string): Promise<void> => {
        await decide(id);
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: Switching }),
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
  await settled();
  return { confirmed, declined };
};

/** What the list says went wrong, if anything, as a screen reader hears it. */
const alerted = (): string | null =>
  document.querySelector('[role="alert"]')?.textContent ?? null;

/** The cards shown, by their names. */
const cards = (): string[] =>
  [...document.querySelectorAll("article")].map(
    (card) => card.getAttribute("aria-label") ?? ""
  );

const press = async (label: string): Promise<void> => {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

describe("a write to an App held for the person", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says why it waits and shows exactly what would run, then confirms exactly that request", async () => {
    const { confirmed, declined } = await shown();
    const text = document.body.textContent ?? "";
    const exact: unknown = JSON.parse(
      document.querySelector("pre code")?.textContent ?? ""
    );
    const sent: unknown = JSON.parse(request);
    const seen = {
      why: text.includes("This uses something only you can read"),
      what: text.includes("Waiting for you: notes.create in Notes"),
      exact,
    };
    await press("Confirm notes.create in Notes");

    expect({
      seen,
      confirmed,
      declined,
      after: document.body.textContent,
    }).toStrictEqual({
      seen: { why: true, what: true, exact: sent },
      confirmed: [
        { chatId: "chat-1", id: "held-1", requestHash: held.requestHash },
      ],
      declined: [],
      after: "",
    });
  });

  it("shows every character nobody sees in the exact request as an escape", async () => {
    // Tag characters, a bidi override and a zero-width joiner: drawn as
    // nothing on the page.
    const hidden = JSON.stringify({
      reference: { name: "notes.create", kind: "mutation" },
      args: { title: "Agenda\u{E0041}\u{E0042}\u202Eevil\u200D!" },
    });
    await shown({ calls: { "chat-1": [{ ...held, request: hidden }] } });
    const exact = document.querySelector("pre code")?.textContent ?? "";

    expect({
      escapes: ["\\u{E0041}", "\\u{E0042}", "\\u{202E}", "\\u{200D}"].map(
        (escape) => exact.includes(escape)
      ),
      unseen: /[\p{Cf}\p{Co}\p{Cn}]/u.test(exact),
    }).toStrictEqual({ escapes: [true, true, true, true], unseen: false });
  });

  it("runs nothing once it is rejected", async () => {
    const { confirmed, declined } = await shown();
    await press("Reject notes.create in Notes");

    expect({ confirmed, declined }).toStrictEqual({
      confirmed: [],
      declined: [{ chatId: "chat-1", id: "held-1" }],
    });
  });

  it("shows every hold of the chat, however many pages they take", async () => {
    const holds = Array.from({ length: heldAppCallsPage + 1 }, (_, at) => ({
      ...held,
      id: `held-${at}`,
      function: `notes.create${at}`,
    }));
    await shown({ calls: { "chat-1": holds } });

    expect(
      document.querySelectorAll('article[aria-label^="notes.create"]')
    ).toHaveLength(heldAppCallsPage + 1);
  });

  it("keeps saying why a confirmed write didn't go through once its card is gone", async () => {
    const refusal = permissionErrors.create("permission.denied");
    await shown({ refusing: { [held.id]: refusal } });
    await press("Confirm notes.create in Notes");

    expect({ cards: cards(), said: alerted() }).toStrictEqual({
      cards: [],
      said: `notes.create in Notes didn't go through.${refusal.message}`,
    });
  });

  it("says why a rejection didn't go through, and clears it at the next decision that does", async () => {
    const refusal = permissionErrors.create("permission.denied");
    const second: HeldAppCall = {
      ...held,
      id: "held-2",
      function: "notes.archive",
    };
    await shown({
      calls: { "chat-1": [held, second] },
      refusing: { [held.id]: refusal },
    });
    await press("Reject notes.create in Notes");
    const afterFailed = alerted();
    await press("Confirm notes.archive in Notes");

    expect({ afterFailed, afterNext: alerted() }).toStrictEqual({
      afterFailed: `notes.create in Notes didn't go through.${refusal.message}`,
      afterNext: null,
    });
  });

  it("keeps a failure to its own chat: the next chat opened shows only its own holds", async () => {
    const refusal = permissionErrors.create("permission.denied");
    const theirs: HeldAppCall = {
      ...held,
      id: "held-in-chat-2",
      appName: "Tasks",
      function: "tasks.add",
    };
    await shown({
      calls: { "chat-1": [held], "chat-2": [theirs] },
      refusing: { [held.id]: refusal },
    });
    await press("Confirm notes.create in Notes");
    const inFirst = alerted();
    await press("Open chat-2");

    expect({ inFirst, alert: alerted(), cards: cards() }).toStrictEqual({
      inFirst: `notes.create in Notes didn't go through.${refusal.message}`,
      alert: null,
      cards: ["tasks.add in Tasks"],
    });
  });

  it("keeps saying why a write connect held didn't go through once connect took it and its card is gone", async () => {
    const failure = new Error("The mail server refused the message.");
    await shown({
      calls: {},
      actions: [mail],
      refusing: { [mail.id]: failure },
    });
    await press("Confirm mail.send on Outlook");

    expect({ cards: cards(), said: alerted() }).toStrictEqual({
      cards: [],
      said: `mail.send on Outlook didn't go through.${failure.message}`,
    });
  });

  it("reads the list again for each of two writes decided at once, so neither stays", async () => {
    const second: HeldAppCall = {
      ...held,
      id: "held-2",
      function: "notes.archive",
    };
    const first = Promise.withResolvers<boolean>();
    const later = Promise.withResolvers<boolean>();
    await shown({
      calls: { "chat-1": [held, second] },
      waiting: { [held.id]: first.promise, [second.id]: later.promise },
    });
    // Both pressed before either is decided; the first ends, the list is
    // read again, then the second ends.
    const buttons = [
      "Confirm notes.create in Notes",
      "Confirm notes.archive in Notes",
    ].map((label) => document.querySelector(`button[aria-label="${label}"]`));
    await act(async () => {
      for (const button of buttons) {
        if (button instanceof HTMLButtonElement) {
          button.click();
        }
      }
      await Promise.resolve();
    });
    first.resolve(true);
    await settled();
    later.resolve(true);
    await settled();

    expect(cards()).toStrictEqual([]);
  });

  it("says why one of the writes Reject all declined didn't go through, though Reject all is gone", async () => {
    const refusal = permissionErrors.create("permission.denied");
    const second: HeldAppCall = {
      ...held,
      id: "held-2",
      function: "notes.archive",
    };
    const third: HeldAppCall = {
      ...held,
      id: "held-3",
      function: "notes.restore",
    };
    await shown({
      calls: { "chat-1": [held, second, third] },
      refusingBefore: { [third.id]: refusal },
    });
    const all = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Reject all"
    );
    await act(async () => {
      all?.click();
      await Promise.resolve();
    });
    await settled();

    expect({ cards: cards(), said: alerted() }).toStrictEqual({
      cards: ["notes.restore in Notes"],
      said: `notes.restore in Notes didn't go through.${refusal.message}`,
    });
  });
});
