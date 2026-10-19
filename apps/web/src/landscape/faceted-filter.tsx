import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@grasp-os/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Separator } from "@grasp-os/ui/components/separator";
import { Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, ListFilterIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

// The prototype's faceted filter (`components/faceted-filter.tsx`), in the
// shape of the shadcn data-table faceted filter, as an app's audit trail
// uses it.

export interface FacetOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Rows with this value, for the count on the right. */
  count: number;
}

export interface Facet {
  key: string;
  title: string;
  options: FacetOption[];
  selected: string[];
}

/**
 * One filter button: a searchable list with a group per facet, counts on
 * the right, and the number of active choices on the button.
 */
export const FacetedFilter = ({
  facets,
  onChange,
  onClear,
  open,
  onOpenChange,
}: {
  facets: readonly Facet[];
  onChange: (key: string, selected: string[]) => void;
  onClear: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const active = facets.reduce((sum, facet) => sum + facet.selected.length, 0);
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>
        <ListFilterIcon data-icon="inline-start" />
        <Trans>Filter</Trans>
        {active > 0 ? (
          <>
            <Separator className="mx-1 h-4" orientation="vertical" />
            <Badge variant="secondary">{active}</Badge>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64" variant="flush">
        <Command>
          <CommandInput placeholder={t`Filter`} />
          <CommandList>
            <CommandEmpty>
              <Trans>Nothing found.</Trans>
            </CommandEmpty>
            {facets.map((facet, index) => (
              <Fragment key={facet.key}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={facet.title}>
                  {facet.options.map((option) => {
                    const isSelected = facet.selected.includes(option.value);
                    return (
                      <CommandItem
                        key={option.value}
                        onSelect={() => {
                          onChange(
                            facet.key,
                            isSelected
                              ? facet.selected.filter(
                                  (value) => value !== option.value
                                )
                              : [...facet.selected, option.value]
                          );
                        }}
                        value={`${facet.title} ${option.label}`}
                      >
                        <span
                          aria-hidden="true"
                          className={
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground flex size-4 items-center justify-center rounded-sm border"
                              : "border-input flex size-4 items-center justify-center rounded-sm border [&_svg]:invisible"
                          }
                        >
                          <CheckIcon className="size-3" />
                        </span>
                        {option.icon}
                        <span>{option.label}</span>
                        <CommandShortcut>{option.count}</CommandShortcut>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </Fragment>
            ))}
            {active > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem className="justify-center" onSelect={onClear}>
                    <Trans>Clear filters</Trans>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
