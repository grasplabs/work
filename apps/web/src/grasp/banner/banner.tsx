/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Banner stays a wrapper over Alert's banner look until step 9 removes it (handover/audit/RELEASE.md §7). */
import type { ReactNode } from "react";

import { Alert } from "../alert";
import type { AlertLayoutStyle, AlertVariant } from "../alert";
import type { IconData } from "../icons";

/** @deprecated Use `AlertVariant` (Alert's `tone`). */
export type BannerTone = AlertVariant;

/** @deprecated Use `AlertLayoutStyle`. */
export type BannerLayoutStyle = AlertLayoutStyle;

/** @deprecated Use `AlertProps`, with `variant="banner"`. */
export interface BannerProps {
  /** The message, in a sentence, on its own line under the title ("Reports pause on Sunday."). */
  children?: ReactNode;
  /** The news itself, in medium, on the first line ("Scheduled maintenance"). */
  title?: string;
  /**
   * What the message is: `neutral` a notice, `success` something that went well, `attention` a
   * warning, `danger` an outage or something that stopped. Each has its tint and its icon, and
   * says it in words too.
   * @default "neutral"
   */
  tone?: BannerTone;
  /** Another icon from the icons entry (`@/components/grasp/icons`), in the tone's colour. Each tone has its own when this is left out. */
  icon?: IconData;
  /**
   * What to do about it: one or two Buttons of size `xs`, the main one first, after the message.
   * They wrap under the words when the line is too narrow.
   */
  action?: ReactNode;
  /**
   * Shows a dismiss button at the end. The banner goes at once, then this runs: remember it, so
   * the banner does not come back on the next page.
   */
  onDismiss?: () => void;
  /**
   * The dismiss button's name, in the page's language.
   * @default "Dismiss"
   */
  dismissLabel?: string;
  /** @deprecated Use `layout`. */
  style?: BannerLayoutStyle;
  /** Layout only: where it sits (for example, kept at the top as the page scrolls). */
  layout?: BannerLayoutStyle;
}

/** @deprecated Use `Alert` with `variant="banner"`: `<Alert variant="banner" tone="attention" title="…">…</Alert>`. */
export const Banner = ({ style, layout = style, ...props }: BannerProps) => (
  <Alert variant="banner" layout={layout} {...props} />
);
