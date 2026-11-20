// Each kind of block's icon, shared by the gutter's menus and the slash menu, so they never drift.
import {
  FoldSection,
  HeadingText,
  Info,
  ListBulleted,
  ListNumbered,
  QuoteText,
  TableGrid,
  TextParagraph,
} from "../../icons";
import type { IconData } from "../../icons";
import type { BlockKind } from "./commands";

export const kindIcons: Record<BlockKind, IconData> = {
  paragraph: TextParagraph,
  heading: HeadingText,
  bulletList: ListBulleted,
  orderedList: ListNumbered,
  blockquote: QuoteText,
  callout: Info,
  details: FoldSection,
  table: TableGrid,
};
