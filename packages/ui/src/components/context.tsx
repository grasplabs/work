// Context: how much of the model's context window a conversation has used,
// built on HoverCard, Button and
// Progress. The trigger is an outline Button with a ring of how full the
// window is and its share ("8% context"); resting on it, or tabbing to it, opens a card with the
// tokens used of the most, a bar of the same, and a row per kind of token, with what each cost when
// the caller says.
//
//   <Context usedTokens={10660} maxTokens={128000} usage={message.metadata.usage}>
//     <ContextTrigger />
//     <ContextContent>
//       <ContextContentHeader />
//       <ContextContentBody>
//         <ContextInputUsage />
//         <ContextOutputUsage />
//         <ContextReasoningUsage />
//         <ContextCacheUsage />
//       </ContextContentBody>
//       <ContextContentFooter />
//     </ContextContent>
//   </Context>
//
// It takes numbers and only formats them, in the I18nProvider's locale: it knows no model, works
// out no price and takes no pricing dependency. A cost is the caller's, already worked out, in its
// currency. The usage is the AI SDK's `LanguageModelUsage`, declared here, so there is no AI SDK
// dependency. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use } from "react";
import type { ReactNode } from "react";

import { useI18n, useLocale } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import { colors, font, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { Button } from "./button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import type { HoverCardProps } from "./hover-card";
import { Progress, ProgressCircle } from "./progress";

/**
 * The tokens a conversation has used, by kind, as the AI SDK's `LanguageModelUsage` gives them
 * (`message.metadata.usage`): what went in, what came out, the model's thinking, and what was read
 * from the cache.
 */
export interface ContextUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
}

/** What the usage cost, worked out by the caller: by kind and in all, in `currency`. */
export interface ContextCost {
  /** The currency of every amount, as an ISO 4217 code ("USD", "EUR"). */
  currency: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: number;
  /** The whole cost: ContextContentFooter shows it. */
  total?: number;
}

/** Every prop Context takes. */
export interface ContextProps {
  /** Its ContextTrigger, then its ContextContent. */
  children: ReactNode;
  /** How many tokens of the window the conversation has used. */
  usedTokens: number;
  /** The model's context window, in tokens: the AI SDK does not send it, so set it from the model. */
  maxTokens: number;
  /** The tokens used, by kind: the usage rows read it. */
  usage?: ContextUsage;
  /** What the usage cost, already worked out. Left out, no cost is shown. */
  cost?: ContextCost;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the card wants to open or close. */
  onOpenChange?: HoverCardProps["onOpenChange"];
  /**
   * How long the pointer rests on the trigger, or focus stays on it, before the card opens, in
   * milliseconds: the trigger is a control, so the card answers at once.
   * @default 10
   */
  openDelay?: number;
  /**
   * How long the card stays once the pointer leaves the trigger and the card, in milliseconds.
   * @default 100
   */
  closeDelay?: number;
}

/** Every prop a ContextTrigger takes. */
export interface ContextTriggerProps {
  /**
   * What the trigger shows in place of the ring and the share ("8% context"). With
   * `asChild`, the one element drawn as the trigger.
   */
  children?: ReactNode;
  /**
   * Draw the one element given as the child as the trigger, in its own look.
   * @default false
   */
  asChild?: boolean;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a ContextContent takes. */
export interface ContextContentProps {
  /** Its ContextContentHeader, ContextContentBody and ContextContentFooter. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextContentHeader takes. */
export interface ContextContentHeaderProps {
  /** What it shows in place of the tokens used of the most and the bar. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextContentBody takes. */
export interface ContextContentBodyProps {
  /** Its usage rows: ContextInputUsage, ContextOutputUsage, ContextReasoningUsage, ContextCacheUsage. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextContentFooter takes. */
export interface ContextContentFooterProps {
  /** What it shows in place of the total cost. Left out with no `cost.total`, it draws nothing. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a usage row takes: ContextInputUsage, ContextOutputUsage, ContextReasoningUsage and ContextCacheUsage. */
interface ContextUsageProps {
  /**
   * What the row shows in place of its kind, its tokens and their cost. Left out with none of its
   * kind used, the row draws nothing.
   */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextInputUsage takes. */
export type ContextInputUsageProps = ContextUsageProps;
/** Every prop a ContextOutputUsage takes. */
export type ContextOutputUsageProps = ContextUsageProps;
/** Every prop a ContextReasoningUsage takes. */
export type ContextReasoningUsageProps = ContextUsageProps;
/** Every prop a ContextCacheUsage takes. */
export type ContextCacheUsageProps = ContextUsageProps;

const styles = stylex.create({
  // The card's sections, one under the other.
  sections: {
    display: "grid",
    rowGap: space["3"],
    minWidth: 0,
  },
  header: {
    display: "grid",
    rowGap: space["2"],
    minWidth: 0,
  },
  // A label at the start and its figure at the end, on one line.
  line: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space["3"],
    minWidth: 0,
  },
  title: {
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  figure: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  body: {
    display: "grid",
    rowGap: space["1"],
    minWidth: 0,
  },
  label: { color: colors.mutedForeground },
  // The count and its cost as two items a gap apart: as runs of digits in one line, right to left
  // would join them and put the gap on the far side.
  tokens: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: space["2"],
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  cost: {
    color: colors.mutedForeground,
  },
  // The total under a hairline, the card's last line.
  footer: {
    paddingBlockStart: space["3"],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  ring: { display: "inline-flex" },
});

interface ContextValue {
  usedTokens: number;
  maxTokens: number;
  usage: ContextUsage | undefined;
  cost: ContextCost | undefined;
}

const ContextValueContext = createContext<ContextValue | null>(null);

const useContextValue = () => {
  const value = use(ContextValueContext);
  if (value === null) {
    throw new Error("Context parts must be used within Context.");
  }
  return value;
};

/** The share of the window used, from 0 to 1; 0 for a window of no size. */
const shareOf = (used: number, max: number) =>
  max > 0 ? Math.max(0, used) / max : 0;

/**
 * Money in `currency`; a currency Intl does not know (a typo, a made-up code) is written as the
 * plain number, never a page that fails to draw.
 */
const moneyFormat = (locale: string | undefined, currency: string) => {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency });
  } catch {
    return new Intl.NumberFormat(locale);
  }
};

/** The formatters, in the provider's locale: tokens compact ("10.7K"), the share whole ("8%"). */
const useFormats = () => {
  const locale = useLocale();
  return {
    tokens: new Intl.NumberFormat(locale, { notation: "compact" }),
    percent: new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 0,
    }),
    money: (currency: string) => moneyFormat(locale, currency),
  };
};

/** The root: holds the numbers, the trigger and the card, and renders nothing of its own. */
export const Context = ({
  children,
  usedTokens,
  maxTokens,
  usage,
  cost,
  openDelay = 10,
  closeDelay = 100,
  ...card
}: ContextProps) => (
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
  <ContextValueContext value={{ usedTokens, maxTokens, usage, cost }}>
    <HoverCard {...card} openDelay={openDelay} closeDelay={closeDelay}>
      {children}
    </HoverCard>
  </ContextValueContext>
);

/** The trigger: an outline Button with a ring of how full the window is, and its share in words. */
export const ContextTrigger = ({
  children,
  asChild = false,
  style,
}: ContextTriggerProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const words = useI18n().context;
  const formats = useFormats();
  const share = shareOf(usedTokens, maxTokens);
  if (asChild) {
    return (
      <HoverCardTrigger variant="default" asChild style={style}>
        {children}
      </HoverCardTrigger>
    );
  }
  return (
    <HoverCardTrigger variant="default" asChild style={style}>
      <Button variant="outline" size="sm">
        {children ?? (
          <>
            {/* The share is said in the words beside it: the ring only shows it. */}
            <span aria-hidden="true" {...stylex.props(styles.ring)}>
              <ProgressCircle value={Math.min(share, 1) * 100} size="sm" />
            </span>
            {words.trigger(formats.percent.format(share))}
          </>
        )}
      </Button>
    </HoverCardTrigger>
  );
};

/** The card: the header, the usage rows and the footer, one under the other. */
export const ContextContent = ({ children, style }: ContextContentProps) => (
  <HoverCardContent style={style}>
    <div data-slot="context-content" {...stylex.props(styles.sections)}>
      {children}
    </div>
  </HoverCardContent>
);

/** The tokens used of the most ("10.7K / 128K"), and a bar of the same. */
export const ContextContentHeader = ({
  children,
  style,
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const words = useI18n().context;
  const formats = useFormats();
  const share = shareOf(usedTokens, maxTokens);
  return (
    <div
      data-slot="context-content-header"
      {...stylex.props(styles.header, style)}
    >
      {children ?? (
        <>
          <div {...stylex.props(styles.line)}>
            <span {...stylex.props(styles.title)}>{words.title}</span>
            <span {...stylex.props(styles.figure)}>
              {words.used(
                formats.tokens.format(usedTokens),
                formats.tokens.format(maxTokens)
              )}
            </span>
          </div>
          <Progress
            aria-label={words.progress}
            value={Math.min(share, 1) * 100}
          />
        </>
      )}
    </div>
  );
};

/** The usage rows, one under the other. */
export const ContextContentBody = ({
  children,
  style,
}: ContextContentBodyProps) => (
  <div data-slot="context-content-body" {...stylex.props(styles.body, style)}>
    {children}
  </div>
);

/** The total cost under a hairline, when the caller gave one. */
export const ContextContentFooter = ({
  children,
  style,
}: ContextContentFooterProps) => {
  const { cost } = useContextValue();
  const words = useI18n().context;
  const formats = useFormats();
  if (children === undefined && cost?.total === undefined) {
    return null;
  }
  return (
    <div
      data-slot="context-content-footer"
      {...stylex.props(styles.line, styles.footer, style)}
    >
      {children ??
        (cost?.total === undefined ? null : (
          <>
            <span {...stylex.props(styles.label)}>{words.totalCost}</span>
            <span {...stylex.props(styles.tokens)}>
              {formats.money(cost.currency).format(cost.total)}
            </span>
          </>
        ))}
    </div>
  );
};

type UsageKind = keyof I18nCatalog["context"]["kinds"];

const tokensOf = (usage: ContextUsage | undefined, kind: UsageKind) => {
  if (kind === "input") {
    return usage?.inputTokens;
  }
  if (kind === "output") {
    return usage?.outputTokens;
  }
  return kind === "reasoning"
    ? usage?.reasoningTokens
    : usage?.cachedInputTokens;
};

/** One usage row: its kind, its tokens, and what they cost when the caller says. */
const UsageRow = ({
  kind,
  children,
  style,
}: ContextUsageProps & { kind: UsageKind }) => {
  const { usage, cost } = useContextValue();
  const words = useI18n().context;
  const formats = useFormats();
  const tokens = tokensOf(usage, kind);
  if (children === undefined && (tokens === undefined || tokens === 0)) {
    return null;
  }
  const amount = cost?.[kind];
  return (
    <div
      data-slot={`context-${kind}-usage`}
      {...stylex.props(styles.line, style)}
    >
      {children ?? (
        <>
          <span {...stylex.props(styles.label)}>{words.kinds[kind]}</span>
          <span {...stylex.props(styles.tokens)}>
            {formats.tokens.format(tokens ?? 0)}
            {amount === undefined || cost === undefined ? null : (
              <span {...stylex.props(styles.cost)}>
                {formats.money(cost.currency).format(amount)}
              </span>
            )}
          </span>
        </>
      )}
    </div>
  );
};

/** The tokens that went in, and their cost. */
export const ContextInputUsage = (props: ContextInputUsageProps) => (
  <UsageRow kind="input" {...props} />
);

/** The tokens that came out, and their cost. */
export const ContextOutputUsage = (props: ContextOutputUsageProps) => (
  <UsageRow kind="output" {...props} />
);

/** The tokens the model spent thinking, and their cost. */
export const ContextReasoningUsage = (props: ContextReasoningUsageProps) => (
  <UsageRow kind="reasoning" {...props} />
);

/** The tokens read from the cache, and their cost. */
export const ContextCacheUsage = (props: ContextCacheUsageProps) => (
  <UsageRow kind="cache" {...props} />
);
