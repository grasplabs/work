import { Badge } from "@grasp-os/ui/components/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactElement, ReactNode } from "react";

// The signals on an app's pages, as the prototype draws them
// (`components/landscape/insight.tsx`): a dot that carries a tone, and what
// Grasp read about a value, opened from it. The prototype opens a claim
// with evidence in its evidence drawer; Grasp keeps no evidence on apps
// yet, so every insight opens as a popover.

/** How much a signal needs attention: attention (orange), fine (green) or neither. */
export type Tone = "attention" | "agreed" | "neutral";

const dotClass: Record<Tone, string> = {
  attention: "bg-status-attention size-1.5 shrink-0 rounded-full",
  agreed: "bg-status-agreed size-1.5 shrink-0 rounded-full",
  neutral: "bg-faint size-1.5 shrink-0 rounded-full",
};

/** A small dot that carries a tone, the only colour signal in the app pages. */
export const StatusDot = ({ tone }: { tone: Tone }) => (
  <span aria-hidden="true" className={dotClass[tone]} />
);

export type Confidence = "high" | "medium" | "low";

export const confidenceLabel: Record<Confidence, MessageDescriptor> = {
  high: msg`High confidence`,
  medium: msg`Medium confidence`,
  low: msg`Low confidence`,
};

/** One piece of evidence behind an insight: where it came from and the passage it rests on. */
export interface Evidence {
  source: string;
  excerpt: string;
}

/** What Grasp read about a value: what it means, and the evidence behind it. */
export interface Insight {
  label: string;
  summary: ReactNode;
  confidence?: Confidence;
  /** Extra facts shown as label and value. */
  rows?: { label: string; value: ReactNode }[];
  evidence?: Evidence[];
}

/** The body of an insight, for use in any popover or panel. */
export const InsightBody = ({ insight }: { insight: Insight }) => {
  const { i18n } = useLingui();
  return (
    <>
      <PopoverHeader>
        <div className="flex items-start justify-between gap-3">
          <PopoverTitle>{insight.label}</PopoverTitle>
          {insight.confidence === undefined ? null : (
            <Badge variant="secondary">
              {i18n._(confidenceLabel[insight.confidence])}
            </Badge>
          )}
        </div>
        <PopoverDescription>{insight.summary}</PopoverDescription>
      </PopoverHeader>
      {insight.rows !== undefined && insight.rows.length > 0 ? (
        <dl className="grid-label-value grid gap-x-4 gap-y-1">
          {insight.rows.map((row) => (
            <div className="contents" key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {insight.evidence !== undefined && insight.evidence.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground">
            <Trans>Evidence</Trans>
          </span>
          <ItemGroup spacing="snug">
            {insight.evidence.map((evidence) => (
              <Item
                key={`${evidence.source}-${evidence.excerpt}`}
                size="xs"
                variant="muted"
              >
                <ItemContent>
                  <ItemTitle>{evidence.source}</ItemTitle>
                  <ItemDescription>{evidence.excerpt}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
      ) : null}
    </>
  );
};

/**
 * A value that opens what Grasp read about it. `render` is the trigger
 * element (usually a Button or a plain button); `children` is what it shows.
 */
export const InsightPopover = ({
  insight,
  render,
  children,
  side = "bottom",
  align = "start",
}: {
  insight: Insight;
  render: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) => (
  <Popover>
    <PopoverTrigger render={render}>{children}</PopoverTrigger>
    <PopoverContent align={align} className="w-96" side={side}>
      <InsightBody insight={insight} />
    </PopoverContent>
  </Popover>
);
