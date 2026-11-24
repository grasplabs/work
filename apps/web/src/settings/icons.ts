import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  AppWindowIcon as HugeAppWindowIcon,
  ContrastIcon as HugeContrastIcon,
  Invoice01Icon,
  LaptopIcon as HugeLaptopIcon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons";

// The drawings Settings needs that Damsko's `lib/icons` lacks (the
// registry gap "icons the settings pages need"), from the same Hugeicons
// set the reference draws them from, under Damsko's names, for its Icon.
// Each goes once Damsko has it. The cable is the workflows pages' own
// (workflows/icons.ts).

/** Light and dark, half and half: how Grasp looks. */
export const ContrastIcon: IconData = HugeContrastIcon;
/** An invoice: billing. */
export const FileInvoiceIcon: IconData = Invoice01Icon;
/** A computer: a device someone is signed in on. */
export const LaptopIcon: IconData = HugeLaptopIcon;
/** A phone: a device someone is signed in on. */
export const SmartphoneIcon: IconData = SmartPhone01Icon;
/** A window of an App: an App did it. */
export const AppWindowIcon: IconData = HugeAppWindowIcon;
