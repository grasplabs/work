import type { IconData } from "@grasp-os/ui/lib/icons";
import { KeyboardIcon as HugeKeyboardIcon } from "@hugeicons/core-free-icons";

// The drawing the report's viewer needs that Damsko's `lib/icons` lacks
// (the registry gap "a file viewer", 2026-11-25), from the same Hugeicons
// set #2503 draws it from, under Damsko's name, for its Icon. It goes once
// Damsko has it.

/** The keyboard: the list of shortcuts. */
export const KeyboardIcon: IconData = HugeKeyboardIcon;
