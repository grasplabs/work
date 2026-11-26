import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Icon, LayoutGridIcon } from "@grasp-os/ui/lib/icons";
import { useSyncExternalStore } from "react";

import {
  ditherLookNow,
  ditherNames,
  ditherVariants,
  onDitherLook,
  setDitherLook,
} from "./look.ts";

// On a local stack only (`vp run dev`): a menu in the bar that switches the
// dither Stephen's field is drawn in, and the pointer's effect on it, so the
// person can feel each on the real setup and interview (look.ts). A build
// for anywhere else has none of it. Its words are a developer's, in
// English, and not in the catalogs.

const label = "Dither background (local only)";

const Picker = ({ size }: { size: "icon-sm" | "icon" }) => {
  const look = useSyncExternalStore(onDitherLook, ditherLookNow);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={label} size={size} tooltip={label} variant="ghost">
          <Icon icon={LayoutGridIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Dither (local only)</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value: unknown) => {
              const chosen = ditherVariants.find(
                (variant) => variant === value
              );
              if (chosen !== undefined) {
                setDitherLook({ variant: chosen });
              }
            }}
            value={look.variant}
          >
            {ditherVariants.map((variant) => (
              <DropdownMenuRadioItem key={variant} value={variant}>
                {ditherNames[variant]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={look.cursor}
          onCheckedChange={(checked: boolean) => {
            setDitherLook({ cursor: checked });
          }}
        >
          Cursor effect
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The dither menu in the bar: on a local stack only. */
export const DitherPicker = ({ size }: { size: "icon-sm" | "icon" }) =>
  import.meta.env.DEV ? <Picker size={size} /> : null;
