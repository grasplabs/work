import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Settings' building blocks for Settings › Stephen, on the library: a
// section is a compact, flush Section card of its own (a picture may
// stand before its title, as Stephen's face does), and its rows are the
// library's Setting rows. The rest of Settings uses the library's parts
// directly (section.tsx says how a Settings page is laid out).

const styles = stylex.create({
  // A picture in line with the title.
  named: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  // A card's own room, for what is no list of rows.
  body: { padding: grasp.space4 },
});

/** A group of settings on one card: a title, more about it behind its info mark, then its rows. */
export const SettingsSection = ({
  title,
  description,
  info,
  media,
  action,
  children,
}: {
  title: string;
  /** One line under the title. Prefer `info`: the rows stand straight under the title. */
  description?: ReactNode;
  /** What the section is for, behind an info mark beside its title. */
  info?: string;
  /** A picture before the title, such as Stephen's face: the title then stands in line with it. */
  media?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) => (
  <SectionCard
    actions={action}
    density="compact"
    description={description}
    flush
    info={info}
    title={
      media === undefined ? (
        title
      ) : (
        <span {...stylex.props(styles.named)}>
          {media}
          {title}
        </span>
      )
    }
  >
    {children}
  </SectionCard>
);

/** One setting: what it is on the left, its control on the right; more about it behind its info mark. */
export const SettingsRow = ({
  label,
  description,
  htmlFor: _htmlFor,
  children,
}: {
  label: string;
  /** More about the setting, behind the row's info mark. */
  description?: string;
  /**
   * The control's id. The library's row names its control itself: pass a
   * control with its own `aria-label`.
   */
  htmlFor?: string;
  children: ReactNode;
}) => (
  <SettingRow info={description} label={label}>
    {children}
  </SettingRow>
);

/** What fills a section's card below its heading when it is no list of rows: the card's own room. */
export const SettingsBody = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.body)}>{children}</div>
);
