// TableCaption: what a table holds (table.tsx), in a short muted sentence under it. Table's own
// `caption` prop draws it; this part is for a caption that holds more than words.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { tableStyles as styles } from "./styles";

/** Every prop a TableCaption takes. */
export interface TableCaptionProps {
  /** What the table holds, in a short sentence. */
  children: ReactNode;
}

/** What the table holds, under it. Prefer Table's `caption`, which also names the scroll box. */
export const TableCaption = ({ children }: TableCaptionProps) => (
  <caption
    data-slot="table-caption"
    {...stylex.props(styles.caption, styles.captionUnder)}
  >
    {children}
  </caption>
);
