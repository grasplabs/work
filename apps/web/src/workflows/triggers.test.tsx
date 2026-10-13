import type { WorkflowTrigger } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatDateTime } from "../format.ts";
import { WorkflowTriggers } from "./triggers.tsx";

// What starts a workflow on its own, as its page lists it.

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
        param: "every",
        timeZone: "Europe/Amsterdam",
        nextRunAt,
        stopped: false,
      },
    ]);
    const stopped = textOf([
      {
        type: "schedule",
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

  it("shows an email trigger's address and an event trigger's event", () => {
    expect(
      textOf([
        { type: "email", address: "invoices-acme@mail.example" },
        { type: "event", event: "invoice.paid" },
      ])
    ).toBe(
      "When an email arrives at invoices-acme@mail.example When the event invoice.paid happens"
    );
  });

  it("says when nothing starts it on its own", () => {
    expect(textOf([])).toBe(
      "Nothing starts it on its own: it runs when someone starts it."
    );
  });
});
