// @vitest-environment happy-dom
import type { WorkflowTrigger } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatDateTime } from "../format.ts";
import { WorkflowTriggers } from "./triggers.tsx";

// What starts a workflow on its own, as its page lists it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** How long the copy button tells what happened before it offers again. */
const copiedFor = 1500;

/** The page's text, as a person reads it: tags gone, spaces collapsed. */
const textOf = (triggers: WorkflowTrigger[]): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <WorkflowTriggers triggers={triggers} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("a workflow's triggers", () => {
  it("shows a schedule with its next run, and one that stopped", () => {
    const nextRunAt = "2026-10-14T07:00:00.000Z";
    const running = textOf([
      {
        type: "schedule",
        position: 0,
        param: "every",
        timeZone: "Europe/Amsterdam",
        nextRunAt,
        stopped: false,
      },
    ]);
    const stopped = textOf([
      {
        type: "schedule",
        position: 0,
        param: "every",
        timeZone: "Europe/Amsterdam",
        nextRunAt: null,
        stopped: true,
      },
    ]);
    expect([running, stopped]).toStrictEqual([
      `On the schedule set by every (Europe/Amsterdam) Next run: ${formatDateTime(nextRunAt)}`,
      "On the schedule set by every (Europe/Amsterdam) No next run Stopped",
    ]);
  });

  it("shows an email trigger's whole address, to copy, once the deployment has its mail domain, and an event trigger's event", () => {
    expect(
      textOf([
        {
          type: "email",
          position: 0,
          localPart: "invoices",
          address: "invoices@mail.acme.test",
        },
        { type: "event", position: 1, event: "invoice.paid" },
      ])
    ).toBe(
      "When an email arrives at invoices@mail.acme.test Copy address When the event invoice.paid happens"
    );
  });

  it("shows an email trigger's address as the part before the @ while the deployment has no mail domain set", () => {
    expect(
      textOf([
        { type: "email", position: 0, localPart: "invoices", address: null },
      ])
    ).toBe(
      "When an email arrives for invoices The part of the address before the @, on the mail domain set up for Grasp."
    );
  });

  it("shows two triggers alike in all it shows as two rows", () => {
    // One event under two filters: the filters aren't shown, their places are what differs.
    const markup = renderToStaticMarkup(
      <I18nProvider i18n={i18n}>
        <WorkflowTriggers
          triggers={[
            { type: "event", position: 0, event: "invoice.paid" },
            { type: "event", position: 1, event: "invoice.paid" },
          ]}
        />
      </I18nProvider>
    );
    expect(markup.match(/<li\b/gu)?.length).toBe(2);
  });

  it("says when nothing starts it on its own", () => {
    expect(textOf([])).toBe(
      "Nothing starts it on its own: it runs when someone starts it."
    );
  });

  describe("copying an email trigger's address", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      document.body.replaceChildren();
    });

    /** The button's text after a click, with the clipboard `writing` it. */
    const clicked = async (writing: (text: string) => void) => {
      vi.useFakeTimers();
      const written: string[] = [];
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
        async (text) => {
          written.push(text);
          writing(text);
          await Promise.resolve();
        }
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          <I18nProvider i18n={i18n}>
            <WorkflowTriggers
              triggers={[
                {
                  type: "email",
                  position: 0,
                  localPart: "invoices",
                  address: "invoices@mail.acme.test",
                },
              ]}
            />
          </I18nProvider>
        );
      });
      const button = (): HTMLButtonElement => {
        const found = host.querySelector("button");
        if (found === null) {
          throw new Error("No copy button.");
        }
        return found;
      };
      await act(async () => {
        button().click();
        await Promise.resolve();
      });
      const after = button().textContent;
      act(() => {
        vi.advanceTimersByTime(copiedFor - 1);
      });
      const before = button().textContent;
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const reset = button().textContent;
      act(() => {
        root.unmount();
      });
      return { written, after, before, reset };
    };

    it("copies the whole address, says so, and offers to copy again after a moment", async () => {
      await expect(clicked(() => {})).resolves.toStrictEqual({
        written: ["invoices@mail.acme.test"],
        after: "Address copied",
        before: "Address copied",
        reset: "Copy address",
      });
    });

    it("says when the address couldn't be copied, and offers to copy again after a moment", async () => {
      await expect(
        clicked(() => {
          throw new Error("The clipboard is not allowed here.");
        })
      ).resolves.toStrictEqual({
        written: ["invoices@mail.acme.test"],
        after: "Could not copy the address",
        before: "Could not copy the address",
        reset: "Copy address",
      });
    });
  });
});
