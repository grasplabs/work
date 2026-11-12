/**
 * What Grasp can do for one row of a list, behind one button: the commands
 * that are rarely given (a new start, drawing a workflow again) stay out
 * of the row until they are asked for. Each is given as a button gives it
 * (commands.tsx), asking first when it can't be undone.
 */
import type { AdminCommand } from "@grasp-os/shared/admin-command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";
import type { Confirm } from "./commands.tsx";

/** One command in a row's menu. */
export interface CommandMenuItem {
  /** What the menu calls it. */
  words: string;
  command: AdminCommand;
  /** Said before it is given, when it can't be undone. */
  confirm?: Confirm;
}

/**
 * The menu of one row: `label` names whom it is for, to a screen reader.
 * Nothing shows when there is nothing to do.
 */
export const CommandMenu = ({
  clientId,
  label,
  items,
}: {
  clientId: string;
  label: string;
  items: readonly CommandMenuItem[];
}) => {
  const { busy, failure, give } = useCommand(clientId);
  const [asking, setAsking] = useState<CommandMenuItem | null>(null);
  if (items.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={label}
              disabled={busy}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            {items.map((item) => (
              <DropdownMenuItem
                key={item.words}
                onClick={() => {
                  if (item.confirm === undefined) {
                    void give(item.command);
                  } else {
                    setAsking(item);
                  }
                }}
                variant={item.confirm === undefined ? "default" : "destructive"}
              >
                {item.words}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setAsking(null);
          }
        }}
        open={asking !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking?.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {asking?.confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (asking !== null) {
                  void give(asking.command);
                }
              }}
              variant="destructive"
            >
              {asking?.confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CommandFailure failure={failure} />
    </span>
  );
};
