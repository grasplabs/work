// A layer's trigger with a tooltip, or without one (tip.tsx). Tip loads only when a trigger has a
// `tooltip`; until it has, the trigger stands as it is, without the tooltip yet.
"use client";

import { lazy, Suspense } from "react";
import type { ReactElement } from "react";

const Tip = lazy(async () => {
  const module = await import("./tip");
  return { default: module.Tip };
});

export interface WithTipProps {
  /** The tooltip's words; none, no tooltip. */
  tooltip: string | undefined;
  /** Draws the layer's trigger, with a tooltip trigger's props merged in when there is one. */
  render: (props: Record<string, unknown>) => ReactElement;
  /** The tooltip is kept but never opens (tip.tsx). @default false */
  off?: boolean;
  /** The tooltip only repeats the trigger's name (tip.tsx). @default false */
  name?: boolean;
}

/** The trigger drawn by `render`, with the tooltip on it when there are words for it. */
export const WithTip = ({
  tooltip,
  render,
  off = false,
  name = false,
}: WithTipProps) => {
  if (tooltip === undefined) {
    return render({});
  }
  return (
    <Suspense fallback={render({})}>
      <Tip tooltip={tooltip} render={render} off={off} name={name} />
    </Suspense>
  );
};
