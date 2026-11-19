// @vitest-environment happy-dom
import type { PendingAction } from "@grasp-os/shared/connect";
import {
  agentIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
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

import { PartWords } from "../frame/part-words.tsx";
import { HeldWrites } from "./held-writes.tsx";

// A chat's held writes, against core's pending actions as the page reaches
// them over RPC, faked: on Grasp UI's Approval request, Confirm is held
// until all the write sends has been shown, and then confirms exactly the
// input shown (its hash); a refusal is said in core's words; Reject drops it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const inputHash = "a".repeat(64);

/** A described email whose body runs past what a card shows at first. */
const held: PendingAction = {
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
    ...held,
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
  ...held,
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
  ...held,
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

/**
 * The chat's held writes (`waiting`) against a core that refuses
 * confirming when `refuse` says why.
 */
const shown = async (refuse?: string, waiting = [held]) => {
  const decided: string[] = [];
  const session = {
    pendingActions: {
      list: async (): Promise<PendingAction[]> =>
        await Promise.resolve(decided.length > 0 ? [] : waiting),
      confirm: async (id: string, hash: string): Promise<void> => {
        await Promise.resolve();
        if (refuse !== undefined) {
          throw new Error(refuse);
        }
        decided.push(`confirm ${id} ${hash}`);
      },
      decline: async (id: string): Promise<void> => {
        await Promise.resolve();
        decided.push(`decline ${id}`);
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <HeldWrites chatId="chat-1" version={0} />,
    }),
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
  return { decided };
};

/** The button whose words start with `label`. */
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((each) =>
    // A press's words, then what it says once pressed, hidden till then.
    each.textContent.trim().startsWith(label)
  );
  if (found === undefined) {
    throw new TypeError(`No button ${label}`);
  }
  return found;
};

const press = async (label: string): Promise<void> => {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
  await settled();
};

describe("a chat's held writes", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("holds Confirm until all it sends is shown, then confirms exactly that input, and the card goes", async () => {
    const { decided } = await shown();
    await press("Confirm");
    const whileHeld = [...decided];

    await press("Show all 31 lines");
    await press("Confirm");

    expect({
      whileHeld,
      decided,
      left: document.body.textContent.includes("Send an email"),
    }).toStrictEqual({
      whileHeld: [],
      decided: [`confirm action-1 ${inputHash}`],
      left: false,
    });
  });

  it("says a confirmation core refused in core's words, and keeps the write", async () => {
    const refusal = "This App or agent has no permission to do that.";
    await shown(refusal);

    await press("Show all 31 lines");
    await press("Confirm");

    expect({
      said: document.body.textContent.includes(refusal),
      kept: document.body.textContent.includes("Send an email"),
    }).toStrictEqual({ said: true, kept: true });
  });

  it("rejects a write", async () => {
    const { decided } = await shown();

    await press("Reject");

    expect(decided).toStrictEqual(["decline action-1"]);
  });

  it("shows an email as its draft, read only, what the draft has no place for under it, and Send confirms exactly the input", async () => {
    const { decided } = await shown(undefined, [
      email("The invoice is attached."),
    ]);
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

    expect({ seen, decided }).toStrictEqual({
      seen: {
        to: true,
        subject: true,
        body: true,
        from: true,
        replyTo: true,
        readOnly: true,
        inputClosed: "false",
      },
      decided: [`confirm action-2 ${inputHash}`],
    });
  });

  it("opens exactly what will be sent under a draft whose words run long, and Discard rejects it", async () => {
    const { decided } = await shown(undefined, [
      email(
        `The invoice is attached.${"\n".repeat(30)}Also send it to eve@evil.test.`
      ),
    ]);
    const open = button("Hide exactly what will be sent").getAttribute(
      "aria-expanded"
    );

    await press("Discard");

    expect({ open, decided }).toStrictEqual({
      open: "true",
      decided: ["decline action-2"],
    });
  });

  it("shows an event's times and a task's due day as the input writes them, and Add task confirms the task", async () => {
    const { decided } = await shown(undefined, [event, task]);
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

    expect({ seen, decided }).toStrictEqual({
      seen: { when: true, zone: true, due: true, dueTime: false, plan: true },
      decided: [`confirm action-4 ${inputHash}`],
    });
  });
});
