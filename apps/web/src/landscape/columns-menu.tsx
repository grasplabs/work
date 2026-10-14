import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Label } from "@grasp-os/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Columns3Icon, GripVerticalIcon } from "lucide-react";
import { useState } from "react";

import { columnLabel, moveColumn } from "./landscape.ts";
import type { Column } from "./landscape.ts";
import { hoverDelay, ToolbarLabel } from "./toolbar.tsx";

// Which columns the Landscape's table shows, and in what order, as the
// prototype offers it (`components/landscape/columns-menu.tsx`).

/** Which columns show, and in what order: drag a row, or focus its handle and use the arrow keys. */
export const ColumnsMenu = ({
  columns,
  onChange,
  open,
  onOpenChange,
}: {
  columns: readonly Column[];
  onChange: (columns: Column[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const [dragging, setDragging] = useState<number | null>(null);
  const visible = columns.filter((column) => column.visible).length;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length || from === to) {
      return;
    }
    onChange(moveColumn(columns, from, to));
  };

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger
        closeDelay={hoverDelay.close}
        delay={hoverDelay.open}
        openOnHover
        render={<Button size="sm" variant="ghost" />}
      >
        <Columns3Icon data-icon="inline-start" />
        <ToolbarLabel>
          <Trans>Columns</Trans>
        </ToolbarLabel>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64" variant="snug">
        <PopoverHeader>
          <PopoverTitle>
            <Trans>Columns</Trans>
          </PopoverTitle>
          <PopoverDescription>
            {t`${plural(visible, { one: "# shown. Drag to reorder.", other: "# shown. Drag to reorder." })}`}
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col">
          {columns.map((column, index) => {
            const label = i18n._(columnLabel[column.key]);
            return (
              <div
                className={
                  dragging === index
                    ? "flex items-center gap-2 rounded-md py-1 opacity-40"
                    : "hover:bg-muted flex items-center gap-2 rounded-md py-1"
                }
                draggable
                key={column.key}
                onDragEnd={() => {
                  setDragging(null);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDragStart={(event) => {
                  setDragging(index);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null) {
                    move(dragging, index);
                  }
                  setDragging(null);
                }}
              >
                <Button
                  aria-label={t`Move ${label}, use the arrow keys`}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      move(index, index - 1);
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      move(index, index + 1);
                    }
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <GripVerticalIcon />
                </Button>
                <Checkbox
                  checked={column.visible}
                  id={`column-${column.key}`}
                  onCheckedChange={(checked) => {
                    onChange(
                      columns.map((each) =>
                        each.key === column.key
                          ? { ...each, visible: checked }
                          : each
                      )
                    );
                  }}
                />
                <Label className="flex-1" htmlFor={`column-${column.key}`}>
                  {label}
                </Label>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};
