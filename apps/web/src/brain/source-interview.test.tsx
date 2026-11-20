// @vitest-environment happy-dom
import type { Statement } from "@grasp-os/shared/brain";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PartWords } from "../frame/part-words.tsx";
import {
  SourceDocument,
  SourceInterview,
  SourceQuotes,
  SourceTabs,
} from "./source-interview.tsx";
import type { TranscribedSource } from "./source-interview.tsx";

// A source's own words as the note page shows them: a conversation opens on
// its transcript, a link to a statement makes its turn the current one, and
// a quote at the side brings the transcript back from the summary at its
// moment; a document reads as a page, each statement once with its kind's
// word, and a link to a statement read inside another still lands.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const said = (
  id: string,
  kind: Statement["kind"],
  text: string
): Statement => ({
  id,
  kind,
  text,
  sourceId: "s-1",
  teamIds: [],
  toolIds: [],
});

const conversation: TranscribedSource = {
  id: "s-1",
  kind: "interview",
  title: "Finance interview",
  date: "2026-11-10",
  transcript: {
    turns: [
      { at: "00:10", speaker: "Grasp", text: "What takes your time?" },
      { at: "00:40", speaker: "Lead", text: "Month end takes three days." },
      { at: "01:30", speaker: "Grasp", text: "And what would help?" },
      { at: "02:05", speaker: "Lead", text: "Invoices matched for us." },
    ],
    chapters: [{ title: "Month end", at: "00:10" }],
  },
};

const statements = [
  said("st-sink", "timeSink", "Month end takes three days."),
  said("st-wish", "wish", "Invoices matched for us."),
];

const shown = (page: ReactNode): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <PartWords>{page}</PartWords>
      </I18nProvider>
    );
  });
  return host;
};

const conversationPage = (activeId?: string) => (
  <SourceInterview
    activeId={activeId}
    source={conversation}
    statements={statements}
  >
    <SourceTabs activeId={activeId}>
      <p>Month end is slow.</p>
    </SourceTabs>
    <SourceQuotes
      onRemove={undefined}
      source={conversation}
      statements={statements}
    />
  </SourceInterview>
);

const tab = (host: HTMLElement, name: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (each) => each.textContent === name
  );
  if (found === undefined) {
    throw new Error(`No tab named ${name}`);
  }
  return found;
};

const currentTurn = (host: HTMLElement) =>
  host.querySelector('[data-slot="interview-turn"][aria-current="true"]')
    ?.textContent;

describe("a source's own words", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("opens on the transcript at the statement a link named", () => {
    const host = shown(conversationPage("st-wish"));
    expect(tab(host, "Transcript").getAttribute("aria-selected")).toBe("true");
    expect(currentTurn(host)).toContain("Invoices matched for us.");
  });

  it("brings the transcript back from the summary at a quote's moment", () => {
    const host = shown(conversationPage());
    act(() => {
      tab(host, "Summary").click();
    });
    expect(tab(host, "Summary").getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("Month end is slow.");
    const wish = [
      ...host.querySelectorAll<HTMLElement>('[data-slot="interview-quote"]'),
    ]
      .find((quote) => quote.textContent?.includes("Invoices matched for us."))
      ?.querySelector<HTMLElement>('[data-slot="interview-cite"]');
    act(() => {
      wish?.click();
    });
    expect(tab(host, "Transcript").getAttribute("aria-selected")).toBe("true");
    expect(currentTurn(host)).toContain("Invoices matched for us.");
  });

  it("opens the transcript again when a link names another statement", () => {
    const host = shown(conversationPage());
    act(() => {
      tab(host, "Summary").click();
    });
    act(() => {
      root?.render(
        <I18nProvider i18n={i18n}>
          <PartWords>{conversationPage("st-sink")}</PartWords>
        </I18nProvider>
      );
    });
    expect(tab(host, "Transcript").getAttribute("aria-selected")).toBe("true");
    expect(currentTurn(host)).toContain("Month end takes three days.");
  });

  const document_: TranscribedSource = {
    ...conversation,
    kind: "document",
    title: "Handbook",
    transcript: {
      unit: "passage",
      turns: [
        {
          at: "1",
          speaker: "Payments",
          text: "Invoices are paid on Fridays. Late ones wait a week.",
        },
      ],
      chapters: [{ title: "Payments", at: "1" }],
    },
  };
  const tagged = [
    said("st-rule", "rule", "Invoices are paid on Fridays."),
    said("st-inside", "blocker", "paid on Fridays"),
    said("st-sink", "timeSink", "Late ones wait a week."),
  ];

  it("reads a document as a page, each passage once beside its statements' kinds", () => {
    const host = shown(
      <SourceDocument source={document_} statements={tagged} />
    );
    expect(
      host.textContent?.split("Invoices are paid on Fridays.")
    ).toHaveLength(2);
    expect(host.querySelector("#st-rule")?.textContent).toContain(
      "Rule and Blocker"
    );
    expect(host.querySelector("#st-sink")?.textContent).toContain(
      "Late ones wait a week."
    );
    expect(host.querySelector("#st-inside")?.nextElementSibling?.id).toBe(
      "st-rule"
    );
  });
});
