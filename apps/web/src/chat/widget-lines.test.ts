import type { ChatToolEvent } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { widgetLinesOf } from "./widget-lines.ts";

// What a chat's code did to the person's dashboard, as lines under the
// code step that did it (widget-lines.ts).

/** A call of the chat's code, by step, method and outcome. */
const call = (
  id: number,
  callId: string,
  method: string,
  outcome: ChatToolEvent["outcome"] = "ok"
): ChatToolEvent => ({
  id,
  callId,
  method,
  target: null,
  summary: {},
  outcome,
  reason: outcome === "ok" ? null : "dashboard.widget_unreadable",
  at: "2026-10-28T09:00:00.000Z",
});

describe("a chat's widget lines", () => {
  it("say each widget a step made or changed, in order, and nothing for a refused call, another step's or another method", () => {
    const tools = [
      call(1, "step-1", "dashboard.widgets"),
      call(2, "step-1", "dashboard.makeWidget"),
      call(3, "step-1", "dashboard.makeWidget", "refused"),
      call(4, "step-1", "dashboard.changeWidget"),
      call(5, "step-2", "dashboard.makeWidget"),
      call(6, "step-1", "workflows.runs"),
    ];
    expect({
      first: widgetLinesOf(tools, "step-1"),
      second: widgetLinesOf(tools, "step-2"),
      none: widgetLinesOf(tools, "step-3"),
    }).toStrictEqual({
      first: [
        { id: 2, done: "made" },
        { id: 4, done: "changed" },
      ],
      second: [{ id: 5, done: "made" }],
      none: [],
    });
  });
});
