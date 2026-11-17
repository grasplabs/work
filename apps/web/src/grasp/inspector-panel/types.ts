// The Inspector panel's public types: its rows, its sections, its views and its props.
import type { ReactNode } from "react";

import type { IconTileLook } from "../icon-tile";
import type { IconData } from "../icons";
import type { PanelLayoutStyle } from "../panel";

/** One row of a section's card: a thing of some kind, by name. */
export interface InspectorRow {
  /** A unique, lasting key for the row. */
  id: string;
  /** Its name, on one line ("Every Monday at 08:00"). */
  name: string;
  /** Its kind's icon, in the one accent, from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** A quiet word or two at its end: its kind, its state ("Schedule"). */
  detail?: ReactNode;
  /** It cannot be changed or removed: why, said by a small lock after its name. */
  locked?: string;
  /** Removes it: a bin at the row's end, shown under a pointer and with focus, always on touch. */
  onRemove?: () => void;
  /** Opens it: the whole row is then one button. */
  onPress?: () => void;
  /** It has just been added: it arrives once. */
  fresh?: boolean;
}

/** One section: a quiet label, one action at its end, one card under it. */
export interface InspectorSection {
  /** A unique, lasting key for the section. */
  id: string;
  /** Its label, a word or two ("Triggers"). */
  label: string;
  /** What the section is for, in a tooltip on the label. */
  hint?: string;
  /** Its rows. With none (and no `text` or `content`) the card is one row that adds the first. */
  rows?: readonly InspectorRow[];
  /** Long words in its card, folded with a fade and an expand button. */
  text?: ReactNode;
  /** Anything else in its card, where rows and text do not fit: Key value rows, a small form. */
  content?: ReactNode;
  /** Adds to it: "Add" at the label's end, and the whole card's row while it is empty. */
  onAdd?: () => void;
  /** The empty card's words, where "Add" and the label read badly ("Add a trigger"). */
  addLabel?: string;
  /** Another action at the label's end, in place of "Add": a two-way switch, a menu. */
  action?: ReactNode;
}

/** One view of the panel, behind a tab in its head. */
export interface InspectorView {
  /** A short, unique name for the view in code ("settings"). */
  value: string;
  /** Its tab's words. */
  label: string;
  /** Its tab's icon; the tabs fold to icons in the bar once the panel has scrolled. */
  icon: IconData;
  /** Its sections, in order. */
  sections: readonly InspectorSection[];
  /** Anything under its sections: a line of small print, a folded "Advanced settings". */
  foot?: ReactNode;
}

/** Every word the panel shows or says beyond your own, so a product can translate them. */
export interface InspectorPanelWords {
  /** The action at a section's end. */
  add: string;
  /** An empty section's row: "Add triggers". */
  addTo: (label: string) => string;
  /** A row's bin: "Remove Every Monday at 08:00". */
  remove: (name: string) => string;
  /** A long text's expand button: "Show all the instructions". */
  showAll: (label: string) => string;
  /** The close button. */
  close: string;
  /** The views' tabs. */
  views: string;
}

/** Every prop an InspectorPanel takes. */
export interface InspectorPanelProps {
  /** What the panel is, for a screen reader ("Agent details"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The object's name, in Geist Serif. */
  title: string;
  /** A sentence about it, under its name. */
  description?: ReactNode;
  /** The object's own icon, in the tile at the head. */
  icon?: IconData;
  /**
   * The tile's look: `tint`, a faint wash of mint (as an agent's tile in Sources); `gradient`, the
   * mint-to-pine light; `raised`, plain.
   * @default "tint"
   */
  iconLook?: IconTileLook;
  /** The object is at work: the tile's light leans. @default false */
  running?: boolean;
  /** Quiet facts under the description, a dot between them: who, when. */
  meta?: ReactNode[];
  /** The bar's actions: one primary, then quiet ones, each a 28px Button. */
  actions?: ReactNode;
  /** Shows a close button in the bar, and runs when it is pressed. */
  onClose?: () => void;
  /** The sections, when the panel has one view. */
  sections?: readonly InspectorSection[];
  /** Anything under the sections, when the panel has one view: small print, a folded "Advanced settings". */
  foot?: ReactNode;
  /** Several views, each with its sections, as tabs in the head. Leave `sections` out. */
  views?: readonly InspectorView[];
  /** The view shown at first, by its `value`. The first, unless given. */
  defaultView?: string;
  /** The view shown, when you keep it in state. Pair it with `onViewChange`. */
  view?: string;
  /** Called with the view chosen. */
  onViewChange?: (view: string) => void;
  /** On the high lift with the panel's corner, as beside a page. In a Sheet, set it false. @default true */
  framed?: boolean;
  /** The faint dither behind the head. @default false */
  texture?: boolean;
  /** The words it shows and says, to replace the English ones: any of them. */
  words?: Partial<InspectorPanelWords>;
  /** @deprecated Use `layout`. */
  style?: PanelLayoutStyle;
  /** Layout only: where it sits and how wide and tall it is. */
  layout?: PanelLayoutStyle;
}
