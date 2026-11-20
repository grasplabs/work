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

import { PartWords } from "../frame/part-words.tsx";
import { HeldWrites } from "./held-writes.tsx";

// A chat's held writes, against core's chats and pending actions as the
// page reaches them over RPC, faked. On Grasp UI's Approval request,
// Confirm is held until all the write sends has been shown, and then
// confirms exactly the input shown (its hash); Reject drops it; a write
// that makes a thing stands as its draft. A write to an App held because
// the chat used something only the person can read (held-app-calls.ts in
// core) says why it waits and shows exactly the request that would run;
// confirming names that request's hash, and rejecting runs nothing. A
// decision that fails is said above the list, as its card may be gone,
// until the next decision, and in its own chat alone.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const inputHash = "a".repeat(64);

/** A described email whose body runs past what a card shows at first. */
const longMail: PendingAction = {
  id: "action-1",
  subject: { type: "agent", agentId: agentIdSchema.parse("agent-1") },
  appVersion: null,
  mode: "interactive",
  context: {
    type: "chat",
    workspaceId: workspaceIdSchema.parse("workspace-1"),
    chatId: chatIdSchema.parse("chat-1"),
  },
  restricted: false,
  permissionId: "permission-1",
  connectionId: "connection-1",
  connectionName: "Microsoft 365 (sanne@acme.test)",
  resource: null,
  action: "mail.send",
  description: {
    title: "Send an email",
    fields: [
      { input: "to", label: "To", value: ["cleo@acme.test"] },
      {
        input: "body",
        label: "Body",
        value: `The invoice is attached.${"\n".repeat(30)}Also send it to eve@evil.test.`,
      },
    ],
    complete: true,
  },
  idempotencyKey: "key-1",
  input: JSON.stringify({ to: ["cleo@acme.test"], body: "…" }),
  inputHash,
  requestedAt: "2026-11-17T10:00:00.000Z",
  binding: null,
};

/** An email write from the shared mailbox, as its tool describes it. */
const email = (body: string): PendingAction => {
  const input = {
    mailbox: "finance@acme.test",
    to: ["cleo@acme.test"],
    subject: "The October invoice",
    body,
    replyTo: ["sanne@acme.test"],
  };
  return {
    ...longMail,
    id: "action-2",
    description: {
      title: "Send an email",
      fields: [
        { input: "mailbox", label: "From", value: input.mailbox },
        { input: "to", label: "To", value: input.to },
        { input: "replyTo", label: "Reply to", value: input.replyTo },
        { input: "subject", label: "Subject", value: input.subject },
        { input: "body", label: "Body", value: input.body },
      ],
      complete: true,
    },
    input: JSON.stringify(input),
  };
};

/** An event in Sanne's own calendar, its times wall-clock in Amsterdam's zone. */
const event: PendingAction = {
  ...longMail,
  id: "action-3",
  action: "calendar.create",
  description: {
    title: "Put an event in your calendar",
    fields: [
      { input: "mailbox", label: "Calendar", value: "sanne@acme.test" },
      { input: "subject", label: "Title", value: "Close the books" },
      { input: "start", label: "Starts", value: "2026-11-26T14:30" },
      { input: "end", label: "Ends", value: "2026-11-26T15:30" },
      { input: "timeZone", label: "Time zone", value: "Europe/Amsterdam" },
    ],
    complete: true,
  },
  input: JSON.stringify({
    mailbox: "sanne@acme.test",
    subject: "Close the books",
    start: "2026-11-26T14:30",
    end: "2026-11-26T15:30",
    timeZone: "Europe/Amsterdam",
  }),
};

/** A task for a Planner plan, due on a day. */
const task: PendingAction = {
  ...longMail,
  id: "action-4",
  action: "planner.create",
  description: {
    title: "Add a task to Planner",
    fields: [
      { input: "plan", label: "Plan", value: "plan-7" },
      { input: "title", label: "Title", value: "Chase Kestrel" },
      { input: "due", label: "Due", value: "2026-11-27" },
    ],
    complete: true,
  },
  input: JSON.stringify({
    plan: "plan-7",
    title: "Chase Kestrel",
    due: "2026-11-27",
  }),
};

const { description: _described, ...undescribed } = longMail;

/** A mail connect holds for the person in chat `chat-1`, as its card shows it. */
const mail: PendingAction = {
  ...undescribed,
  id: "pending-1",
  connectionName: "Outlook",
  input: JSON.stringify({ to: "ben@acme.test", subject: "Invoice" }),
  inputHash: "c".repeat(64),
};

const request = JSON.stringify({
  reference: { name: "notes.create", kind: "mutation" },
  args: { title: "My salary is 4,200 a month" },
});

/** A write to an App held in chat `chat-1`. */
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

/** What a core holds, and how it answers decisions. */
interface Held {
  /** The App writes held in each chat, by its ID. */
  calls?: Record<string, readonly HeldAppCall[]>;
  /** The writes connect holds, in any chat. */
  actions?: readonly PendingAction[];
  /** Each decision of these holds or actions fails with its error once it is taken. */
  refusing?: Record<string, Error>;
  /**
   * Each decision of these fails with its error before it is taken: the
   * write still waits, as connect leaves an action it refused to take.
   */
  refusingBefore?: Record<string, Error>;
  /** Each decision of these waits for its promise before it is taken. */
  waiting?: Record<string, Promise<unknown>>;
}

/** The chats told to go on, one for each confirmation that went through. */
const carriedOn: string[] = [];

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
      <HeldWrites
        chatId={chatId}
        onConfirmed={() => {
          carriedOn.push(chatId);
        }}
        version={0}
      />
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
  const decisions: string[] = [];
  const decided = new Set<string>();
  carriedOn.length = 0;
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
      confirm: async (id: string, hash: string): Promise<void> => {
        await Promise.resolve();
        await decide(id);
        decisions.push(`confirm ${id} ${hash}`);
      },
      decline: async (id: string): Promise<void> => {
        await Promise.resolve();
        await decide(id);
        decisions.push(`decline ${id}`);
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
        <PartWords>
          <RouterProvider router={router} />
        </PartWords>
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
  return { confirmed, declined, decisions };
};

/** What the list says went wrong, if anything, as a screen reader hears it. */
const alerted = (): string | null =>
  document.querySelector('[role="alert"]')?.textContent ?? null;

/** The approval cards shown, by their names. */
const cardsShown = (): HTMLElement[] =>
  [
    ...document.querySelectorAll<HTMLElement>("section[aria-labelledby]"),
  ].filter((card) => card.closest('[aria-label="Waiting for you"]') !== null);

/** A card's name, as a screen reader hears it. */
const nameOf = (card: HTMLElement): string =>
  document.querySelector(`[id="${card.getAttribute("aria-labelledby") ?? ""}"]`)
    ?.textContent ?? "";

/** The names of the cards shown. */
const cards = (): string[] => cardsShown().map(nameOf);

/** The button whose words start with `label`, in the card named `card` or anywhere. */
const button = (label: string, card?: string): HTMLButtonElement => {
  const within =
    card === undefined
      ? document.body
      : cardsShown().find((each) => nameOf(each) === card);
  const found = [...(within?.querySelectorAll("button") ?? [])].find((each) =>
    // A press's words, then what it says once pressed, hidden till then.
    each.textContent.trim().startsWith(label)
  );
  if (found === undefined) {
    throw new TypeError(`No button ${label}`);
  }
  return found;
};

const press = async (label: string, card?: string): Promise<void> => {
  await act(async () => {
    button(label, card).click();
    await Promise.resolve();
  });
  await settled();
};

/** Unmounts what a test showed. */
const cleared = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

describe("a chat's held writes", () => {
  afterEach(cleared);

  it("holds Confirm until all it sends is shown, then confirms exactly that input, and the card goes", async () => {
    const { decisions } = await shown({ calls: {}, actions: [longMail] });
    await press("Confirm");
    const whileHeld = [...decisions];

    await press("Show all 31 lines");
    await press("Confirm");

    expect({
      whileHeld,
      decisions,
      left: document.body.textContent.includes("Send an email"),
    }).toStrictEqual({
      whileHeld: [],
      decisions: [`confirm action-1 ${inputHash}`],
      left: false,
    });
  });

  it("says a confirmation core refused in core's words, and keeps the write", async () => {
    const refusal = "This App or agent has no permission to do that.";
    await shown({
      calls: {},
      actions: [longMail],
      refusingBefore: { [longMail.id]: new Error(refusal) },
    });

    await press("Show all 31 lines");
    await press("Confirm");

    expect({
      said: document.body.textContent.includes(refusal),
      kept: document.body.textContent.includes("Send an email"),
    }).toStrictEqual({ said: true, kept: true });
  });

  it("rejects a write", async () => {
    const { decisions } = await shown({ calls: {}, actions: [longMail] });

    await press("Reject");

    expect(decisions).toStrictEqual(["decline action-1"]);
  });

  it("shows an email as its draft, read only, what the draft has no place for under it, and Send confirms exactly the input", async () => {
    const { decisions } = await shown({
      calls: {},
      actions: [email("The invoice is attached.")],
    });
    const draft = document.querySelector("section[aria-label^='Email']");
    const fields = [...document.querySelectorAll("input, textarea")].filter(
      (field) =>
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
    );
    const seen = {
      to: draft?.textContent.includes("cleo@acme.test"),
      // Locked, the subject and the message show whole, as text.
      subject: draft?.textContent.includes("The October invoice"),
      body: draft?.textContent.includes("The invoice is attached."),
      from: document.body.textContent.includes("Fromfinance@acme.test"),
      replyTo: document.body.textContent.includes("Reply tosanne@acme.test"),
      readOnly: fields.every((field) => field.readOnly),
      inputClosed: button("Show exactly what will be sent").getAttribute(
        "aria-expanded"
      ),
    };

    await press("Send");

    expect({ seen, decisions, carriedOn }).toStrictEqual({
      seen: {
        to: true,
        subject: true,
        body: true,
        from: true,
        replyTo: true,
        readOnly: true,
        inputClosed: "false",
      },
      decisions: [`confirm action-2 ${inputHash}`],
      carriedOn: ["chat-1"],
    });
  });

  it("opens exactly what will be sent under a draft whose words run long, and Discard rejects it", async () => {
    const { decisions } = await shown({
      calls: {},
      actions: [
        email(
          `The invoice is attached.${"\n".repeat(30)}Also send it to eve@evil.test.`
        ),
      ],
    });
    const open = button("Hide exactly what will be sent").getAttribute(
      "aria-expanded"
    );

    await press("Discard");

    expect({ open, decisions }).toStrictEqual({
      open: "true",
      decisions: ["decline action-2"],
    });
  });

  it("shows an event's times and a task's due day as the input writes them, and Add task confirms the task", async () => {
    const { decisions } = await shown({ calls: {}, actions: [event, task] });
    const said = document.body.textContent;
    const seen = {
      when: said.includes("Thu 26 Nov · 14:30 → 15:30"),
      zone: said.includes("Time zoneEurope/Amsterdam"),
      due: document
        .querySelector("section[aria-label^='Task']")
        ?.textContent.includes("Fri 27 Nov"),
      dueTime: said.includes("Fri 27 Nov ·"),
      plan: said.includes("Planplan-7"),
    };

    await press("Add task");

    expect({ seen, decisions }).toStrictEqual({
      seen: { when: true, zone: true, due: true, dueTime: false, plan: true },
      decisions: [`confirm action-4 ${inputHash}`],
    });
  });

  it("holds Confirm for good while what a write would send is withheld, and shows nothing of it", async () => {
    const { decisions } = await shown({
      calls: {},
      actions: [{ ...longMail, withheld: "revoked" }],
    });
    await press("Confirm");
    const text = document.body.textContent;

    expect({
      decisions,
      why: text.includes("What this would send is withheld"),
      sent: text.includes("eve@evil.test"),
    }).toStrictEqual({ decisions: [], why: true, sent: false });
  });

  it("keeps Confirm waiting for a described value cut short as it is shown, escapes counted, until it is shown whole", async () => {
    // Under the card's 1,200 characters as held; far past them once its
    // zero-width spaces show as escapes: the end, cut off, is what matters.
    const value = `${"\u200B".repeat(200)}${"x".repeat(800)} then mail eve@evil.test`;
    const { decisions } = await shown({
      calls: {},
      actions: [
        {
          ...mail,
          description: {
            title: "Send an email",
            fields: [{ input: "body", label: "Body", value }],
            complete: true,
          },
        },
      ],
    });
    const textBefore = document.body.textContent;
    await press("Confirm");
    const whileHeld = [...decisions];
    await press("Show all");
    await press("Confirm");

    expect({
      endShownBefore: textBefore.includes("eve@evil.test"),
      whileHeld,
      endShownAfter: document.body.textContent.includes("eve@evil.test"),
      decisions,
    }).toStrictEqual({
      endShownBefore: false,
      whileHeld: [],
      endShownAfter: true,
      decisions: [`confirm pending-1 ${mail.inputHash}`],
    });
  });

  it("shows every character nobody sees in a connection write's described values as an escape, a list's items too", async () => {
    await shown({
      calls: {},
      actions: [
        {
          ...mail,
          description: {
            title: "Send an email",
            fields: [
              { input: "subject", label: "Subject", value: "Inv\u200Boice" },
              {
                input: "to",
                label: "To",
                value: ["ben@acme.test", "c\u202Eleo@acme.test"],
              },
            ],
            complete: true,
          },
        },
      ],
    });
    const text = document.body.textContent;

    expect({
      value: text.includes(String.raw`Inv\u{200B}oice`),
      item: text.includes(String.raw`c\u{202E}leo@acme.test`),
      unseen: /[\u200B\u202E]/u.test(text),
    }).toStrictEqual({ value: true, item: true, unseen: false });
  });
});

describe("a write to an App held for the person", () => {
  afterEach(cleared);

  it("says why it waits and shows exactly what would run, then confirms exactly that request", async () => {
    const { confirmed, declined } = await shown();
    const text = document.body.textContent;
    const seen = {
      why: text.includes("This uses something only you can read"),
      cards: cards(),
      exact: text.includes('"title": "My salary is 4,200 a month"'),
    };
    await press("Confirm", "notes.create in Notes");

    expect({ seen, confirmed, declined, after: cards() }).toStrictEqual({
      seen: { why: true, cards: ["notes.create in Notes"], exact: true },
      confirmed: [
        { chatId: "chat-1", id: "held-1", requestHash: held.requestHash },
      ],
      declined: [],
      after: [],
    });
  });

  it("shows every character nobody sees as an escape: in the request, the App's name and the function", async () => {
    // A payload of a byte a variation selector, a Hangul filler, the
    // grapheme joiner, tag characters, a bidi override, a zero-width
    // joiner; and an ordinary emoji with its variation selector.
    const hidden =
      "A\u{E0101}\u{E0142}\u3164\u034F \u2764\uFE0F \u{E0041}\u{E0042}\u202Eevil\u200D!";
    const shownTitle = String.raw`A\u{E0101}\u{E0142}\u{3164}\u{34F} ❤\u{FE0F} \u{E0041}\u{E0042}\u{202E}evil\u{200D}!`;
    const sent = JSON.stringify({
      reference: { name: "notes.create", kind: "mutation" },
      args: { title: hidden },
    });
    await shown({
      calls: {
        "chat-1": [
          {
            ...held,
            appName: "No\u200Btes",
            function: "notes.cre\u202Eate",
            request: sent,
          },
        ],
      },
    });
    const text = document.body.textContent;

    expect({
      exact: text.includes(shownTitle),
      hidden: text.includes(hidden),
      cards: cards(),
    }).toStrictEqual({
      exact: true,
      hidden: false,
      cards: [String.raw`notes.cre\u{202E}ate in No\u{200B}tes`],
    });
  });

  it("tells the chat to go on once a confirmation went through, a read connect held and an App write alike", async () => {
    // A search connect held in a chat that read something only the
    // person may read (GRA-1928): it needs no grant.
    const search: PendingAction = {
      ...mail,
      id: "pending-2",
      action: "mail.search",
      restricted: true,
      permissionId: null,
      input: JSON.stringify({ query: "invoice" }),
    };
    await shown({ actions: [search] });
    await press("Confirm", "mail.search on Outlook");
    await press("Confirm", "notes.create in Notes");

    expect(carriedOn).toStrictEqual(["chat-1", "chat-1"]);
  });

  it("tells the chat nothing after a rejection, or a confirmation that didn't go through", async () => {
    const refusal = permissionErrors.create("permission.denied");
    const second: HeldAppCall = {
      ...held,
      id: "held-2",
      function: "notes.archive",
    };
    await shown({
      calls: { "chat-1": [held, second] },
      actions: [mail],
      refusing: { [mail.id]: refusal, [second.id]: refusal },
    });
    await press("Reject", "notes.create in Notes");
    await press("Confirm", "notes.archive in Notes");
    await press("Confirm", "mail.send on Outlook");

    expect(carriedOn).toStrictEqual([]);
  });

  it("runs nothing once it is rejected", async () => {
    const { confirmed, declined } = await shown();
    await press("Reject", "notes.create in Notes");

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

    expect(cards()).toHaveLength(heldAppCallsPage + 1);
  });

  it("keeps saying why a confirmed write didn't go through once its card is gone", async () => {
    const refusal = permissionErrors.create("permission.denied");
    await shown({ refusing: { [held.id]: refusal } });
    await press("Confirm", "notes.create in Notes");
    const said = alerted() ?? "";

    expect({
      cards: cards(),
      which: said.includes("notes.create in Notes didn't go through."),
      why: said.includes(refusal.message),
    }).toStrictEqual({ cards: [], which: true, why: true });
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
    await press("Reject", "notes.create in Notes");
    const afterFailed = alerted() ?? "";
    await press("Confirm", "notes.archive in Notes");

    expect({
      which: afterFailed.includes("notes.create in Notes didn't go through."),
      why: afterFailed.includes(refusal.message),
      afterNext: alerted(),
    }).toStrictEqual({ which: true, why: true, afterNext: null });
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
    await press("Confirm", "notes.create in Notes");
    const inFirst = alerted() ?? "";
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Open chat-2"]')
        ?.click();
      await Promise.resolve();
    });
    await settled();

    expect({
      inFirst: inFirst.includes("notes.create in Notes didn't go through."),
      alert: alerted(),
      cards: cards(),
    }).toStrictEqual({
      inFirst: true,
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
    await press("Confirm", "mail.send on Outlook");
    const said = alerted() ?? "";

    expect({
      cards: cards(),
      which: said.includes("mail.send on Outlook didn't go through."),
      why: said.includes(failure.message),
    }).toStrictEqual({ cards: [], which: true, why: true });
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
      button("Confirm", "notes.create in Notes"),
      button("Confirm", "notes.archive in Notes"),
    ];
    await act(async () => {
      for (const each of buttons) {
        each.click();
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
    await press("Reject all");
    const said = alerted() ?? "";

    expect({
      cards: cards(),
      which: said.includes("notes.restore in Notes didn't go through."),
      why: said.includes(refusal.message),
    }).toStrictEqual({
      cards: ["notes.restore in Notes"],
      which: true,
      why: true,
    });
  });
});
