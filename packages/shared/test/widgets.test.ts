import { describe, expect, it } from "vite-plus/test";

import {
  widgetAnswer,
  widgetAnswerMaxChars,
  widgetDraftOf,
} from "../src/widgets.ts";

// A model's answer read as a widget (widgets.ts): untrusted text, so a
// parser, tested on its own. What core does with what it reads is tested
// through the dashboard (core's dashboard-widgets.test.ts).

const widget = {
  title: "Failures",
  days: 7,
  parts: [{ type: "number", label: "Failed", measure: "failed" }],
};

/** Parts side by side. */
const row = (parts: unknown[]) => ({ type: "row", parts });

/** Whether `text` reads as a widget. */
const reads = (text: string): boolean => widgetAnswer(text).ok;

describe(widgetAnswer, () => {
  it("reads a widget whatever comes around its JSON, a code fence say, with its note", () => {
    expect(
      widgetAnswer(
        `Here it is:\n\`\`\`json\n${JSON.stringify({ widget, note: "Weekly only." })}\n\`\`\``
      )
    ).toStrictEqual({ ok: true, spec: widget, note: "Weekly only." });
  });

  it("never reads an answer too long, whatever it holds", () => {
    const padded = JSON.stringify({
      widget: { ...widget, title: "Failures" },
      note: "x".repeat(widgetAnswerMaxChars),
    });

    expect(reads(padded)).toBeFalsy();
  });

  it("keeps nothing but the spec's own parts and settings: no setting of its own, no row in a row, no part more", () => {
    const [number] = widget.parts;

    expect({
      extraSetting: reads(
        JSON.stringify({ widget: { ...widget, colour: "#f00" } })
      ),
      extraOnPart: reads(
        JSON.stringify({
          widget: { ...widget, parts: [{ ...number, style: "big" }] },
        })
      ),
      rowInRow: reads(
        JSON.stringify({
          widget: { ...widget, parts: [row([number, row([number, number])])] },
        })
      ),
      fiveParts: reads(
        JSON.stringify({
          widget: { ...widget, parts: Array.from({ length: 5 }, () => number) },
        })
      ),
      otherWindow: reads(JSON.stringify({ widget: { ...widget, days: 90 } })),
    }).toStrictEqual({
      extraSetting: false,
      extraOnPart: false,
      rowInRow: false,
      fiveParts: false,
      otherWindow: false,
    });
  });

  it("says what kept an answer from being a widget, at most a few things", () => {
    const answer = widgetAnswer(
      JSON.stringify({
        widget: {
          ...widget,
          parts: Array.from({ length: 12 }, () => ({ type: "chart" })),
        },
      })
    );

    expect({
      read: answer.ok,
      few: !answer.ok && answer.problems.length <= 8,
    }).toStrictEqual({ read: false, few: true });
  });
});

describe("a widget read while its answer is still written", () => {
  it("has its title as far as it came and its parts' kinds, a half-written escape left out", () => {
    const whole = JSON.stringify({
      widget: {
        title: 'Fails "now"',
        days: 7,
        parts: [
          { type: "number", measure: "failed", label: "Failed" },
          row([{ type: "bars", measure: "started", by: "workflow" }]),
          { type: "html", html: "<b>x</b>" },
        ],
      },
    });
    const upTo = (end: string) => whole.slice(0, whole.indexOf(end));

    expect([
      widgetDraftOf(""),
      widgetDraftOf('{"widget": {"title": "'),
      widgetDraftOf(upTo("now")),
      widgetDraftOf(`${upTo("now")}now\\`),
      widgetDraftOf(upTo('"days"')),
      widgetDraftOf(whole),
    ]).toStrictEqual([
      { title: null, parts: [] },
      { title: null, parts: [] },
      { title: 'Fails "', parts: [] },
      { title: 'Fails "now', parts: [] },
      { title: 'Fails "now"', parts: [] },
      // A part the dashboard doesn't have isn't one.
      { title: 'Fails "now"', parts: ["number", "row", "bars"] },
    ]);
  });
});
