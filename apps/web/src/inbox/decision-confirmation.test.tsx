// @vitest-environment happy-dom
import type { DecisionView } from "@grasp-os/shared/decisions";
import {
  runIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DecisionConfirmDialog } from "./decision-confirmation.tsx";
import type { PendingConfirmation } from "./decision-confirmation.tsx";

// Grasp's own confirmation of an answer to a decision: focus starts on
// Cancel, the safe answer, never on the body or a copy button inside it;
// Confirm stays off for its first second; Escape cancels, and nothing but
// Confirm confirms.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const decision: DecisionView = {
  id: "decision-1",
  workflowResource: {
    id: workflowResourceIdSchema.parse("wr-1"),
    name: "invoices",
  },
  workflow: workflowIdSchema.parse("invoices"),
  run: runIdSchema.parse("run-1"),
  description: "Pay Globex the 50,000 it asked for?",
  input: { supplier: "Globex", amount: 50_000 },
  status: "open",
  expiresAt: "2026-11-20T09:00:00.000Z",
  revision: "revision-1",
};

/** An approval with a long comment, and what the App's page sent as JSON. */
const pending: PendingConfirmation = {
  decision,
  response: {
    approved: true,
    payload: {
      comment: Array.from(
        { length: 60 },
        (_, line) => `Line ${line + 1} of a long comment.`
      ).join("\n"),
    },
  },
};

/** Lets renders and effects settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** Waits `ms`, letting renders settle. */
const waited = async (ms: number): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, ms);
    await promise;
  });
  await settle();
};

/**
 * Opens the confirmation of `pending`, as the decision's page does: it
 * closes once the answer is confirmed or cancelled.
 */
const opened = async () => {
  const onConfirm = vi.fn<(confirmed: PendingConfirmation) => void>();
  const onCancel = vi.fn<(cancelled: PendingConfirmation) => void>();
  const Page = () => {
    const [asked, setAsked] = useState<PendingConfirmation | undefined>(
      pending
    );
    return (
      <DecisionConfirmDialog
        onCancel={(cancelled) => {
          setAsked(undefined);
          onCancel(cancelled);
        }}
        onConfirm={(confirmed) => {
          setAsked(undefined);
          onConfirm(confirmed);
        }}
        pending={asked}
        source="page"
      />
    );
  };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <Page />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  await settle();
  // The focus move waits a frame.
  await waited(50);
  return { onConfirm, onCancel };
};

/** The dialog's button whose words are `words`. */
const button = (words: string): HTMLButtonElement | undefined =>
  [
    ...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button"),
  ].find((each) => each.textContent.trim() === words);

/** Whether the button can be pressed. */
const on = (each: HTMLButtonElement | undefined): boolean =>
  each !== undefined &&
  !each.disabled &&
  each.getAttribute("aria-disabled") !== "true";

describe("the confirmation of an answer to a decision", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("starts on Cancel, holds Confirm for a second, then confirms that answer", async () => {
    const { onConfirm } = await opened();
    const first = {
      focus: document.activeElement?.textContent.trim(),
      confirm: on(button("Confirm")),
    };
    await waited(1100);
    const later = on(button("Confirm"));
    await act(async () => {
      button("Confirm")?.click();
      await Promise.resolve();
    });
    await settle();

    expect({
      first,
      later,
      confirmed: onConfirm.mock.calls,
    }).toStrictEqual({
      first: { focus: "Cancel", confirm: false },
      later: true,
      confirmed: [[pending]],
    });
  });

  it("cancels on Escape, and never confirms", async () => {
    const { onConfirm, onCancel } = await opened();
    await waited(1100);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await Promise.resolve();
    });
    await settle();

    expect({
      confirmed: onConfirm.mock.calls.length,
      cancelled: onCancel.mock.calls.length > 0,
    }).toStrictEqual({ confirmed: 0, cancelled: true });
  });

  it("never confirms on a press outside it", async () => {
    const { onConfirm } = await opened();
    await waited(1100);
    const shade = document.querySelector("[data-slot='dialog-overlay']");
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "click"]) {
        shade?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      await Promise.resolve();
    });
    await settle();

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
