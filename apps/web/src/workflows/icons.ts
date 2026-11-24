import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  CableIcon as HugeCableIcon,
  FitToScreenIcon as HugeFitToScreenIcon,
  SearchAddIcon,
  SearchMinusIcon,
  SplitIcon as HugeSplitIcon,
} from "@hugeicons/core-free-icons";

// The drawings the workflows pages need that Damsko's `lib/icons` lacks
// (the registry gap "icons the workflows pages need"), from the same
// Hugeicons set the reference draws them from, under Damsko's names, for
// its Icon. Each goes once Damsko has it.

/** Fit to the view: the canvas zoomed back to show it whole. */
export const FitToScreenIcon: IconData = HugeFitToScreenIcon;
/** Zoom in. */
export const ZoomInIcon: IconData = SearchAddIcon;
/** Zoom out. */
export const ZoomOutIcon: IconData = SearchMinusIcon;
/** Split into two, side by side: a flow laid out left to right. */
export const SplitIcon: IconData = HugeSplitIcon;
/** A connection to an app. */
export const CableIcon: IconData = HugeCableIcon;
