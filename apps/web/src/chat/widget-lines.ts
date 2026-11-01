import type { ChatToolEvent } from "@grasp-os/shared/chat";

// What a chat's code did to the person's dashboard (`env.dashboard`, core's
// agent-dashboard.ts), as a line under the code step that did it: a widget
// Grasp made, or one it changed. Core hands the agent only the widget's ID
// (its title is written from names the agent may not read), so the line
// says what was done and leads to the dashboard, where the widget is.

/** A widget a code step made or changed, as its line says it. */
export interface WidgetLine {
  /** The call's event: one line per call. */
  id: number;
  done: "made" | "changed";
}

const doneBy: Readonly<Record<string, WidgetLine["done"]>> = {
  "dashboard.makeWidget": "made",
  "dashboard.changeWidget": "changed",
};

/**
 * The widgets the code step `callId` made or changed, in the order it did:
 * only calls that went through; one refused made or changed nothing.
 */
export const widgetLinesOf = (
  tools: readonly ChatToolEvent[],
  callId: string
): WidgetLine[] =>
  tools.flatMap((event) => {
    const done = doneBy[event.method];
    return event.callId === callId && event.outcome === "ok" && done
      ? [{ id: event.id, done }]
      : [];
  });
