import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  Select,
  SelectContent,
  SelectTrigger,
} from "@grasp-os/ui/components/select";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { CheckIcon } from "lucide-react";
import type * as React from "react";

/*
 * A data model as a no-code tool shows one (an App's tables and their
 * fields, in its workspace): the tables in a column of their own, the one
 * open standing out; and the picker a field's kind is chosen from, each
 * kind with its icon on a tile. Every word is the page's: the kit holds
 * no language of its own. The fields themselves are a grid's columns
 * (record-grid.tsx).
 */

const fieldTypeIconVariants = cva(
  "bg-tinted text-tinted-foreground inline-flex shrink-0 items-center justify-center rounded-md [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      size: {
        default: "size-8 [&_svg]:size-4",
        sm: "size-6 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { size: "default" },
  }
);

/** A field kind's icon, on its tile. */
function FieldTypeIcon({
  className,
  size,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof fieldTypeIconVariants>) {
  return (
    <span
      data-slot="field-type-icon"
      aria-hidden
      className={cn(fieldTypeIconVariants({ size }), className)}
      {...props}
    />
  );
}

/** A field kind a person can pick: its value, its name, what it holds, and its icon. */
interface FieldTypeOption {
  value: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
}

/**
 * The picker of a field's kind: each kind with its icon and what it
 * holds, as a no-code tool lists them. `label` names it to assistive
 * technology.
 */
function FieldTypePicker({
  options,
  value,
  onValueChange,
  label,
  disabled,
  size = "default",
  className,
}: {
  options: readonly FieldTypeOption[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
}) {
  const picked = options.find((option) => option.value === value);
  return (
    <Select
      disabled={disabled}
      items={options.map((option) => ({
        value: option.value,
        label: option.label,
      }))}
      onValueChange={(next: unknown) => {
        if (typeof next === "string") {
          onValueChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={label}
        className={cn("min-w-40", className)}
        data-slot="field-type-picker"
        size={size}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {picked === undefined ? null : (
            <FieldTypeIcon size="sm">{picked.icon}</FieldTypeIcon>
          )}
          <span className="truncate">{picked?.label}</span>
        </span>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="w-72 p-1">
        {options.map((option) => (
          <SelectPrimitive.Item
            className="focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center gap-2.5 rounded-sm py-1.5 pr-8 pl-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50"
            key={option.value}
            value={option.value}
          >
            <FieldTypeIcon size="sm">{option.icon}</FieldTypeIcon>
            <span className="flex min-w-0 flex-col">
              <SelectPrimitive.ItemText className="font-medium">
                {option.label}
              </SelectPrimitive.ItemText>
              {option.description === undefined ? null : (
                <span className="text-muted-foreground text-xs">
                  {option.description}
                </span>
              )}
            </span>
            <SelectPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
              <CheckIcon className="pointer-events-none size-4" />
            </SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The column of a data model's tables, a list of buttons. */
function ModelTableList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="model-table-list"
      className={cn("flex min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

const modelTableItemVariants = cva(
  "focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-sm transition-colors duration-100 outline-none focus-visible:ring-[3px] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      active: {
        true: "bg-tinted text-tinted-foreground font-medium",
        false: "text-foreground hover:bg-muted",
      },
    },
    defaultVariants: { active: false },
  }
);

/**
 * A table of the model: its icon, its name and what to say of it (`meta`,
 * its fields' count), a button that opens it; the open one `active`
 * (`aria-current`).
 */
function ModelTableItem({
  active = false,
  icon,
  meta,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & {
  active?: boolean;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <li data-slot="model-table-item" className="min-w-0">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        className={cn(modelTableItemVariants({ active }), className)}
        {...props}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {meta === undefined ? null : (
          <span className="text-muted-foreground text-xs tabular-nums">
            {meta}
          </span>
        )}
      </button>
    </li>
  );
}

export { FieldTypeIcon, FieldTypePicker, ModelTableItem, ModelTableList };
export type { FieldTypeOption };
