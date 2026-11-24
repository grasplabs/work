import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

// The last row of a list of places or platforms: one Grasp can't connect
// to yet, pressed to type its name, and asked for by name.

export const OtherRow = ({
  label,
  placeholder,
  disabled,
  onAdd,
}: {
  label: string;
  placeholder: string;
  disabled: boolean;
  onAdd: (name: string) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  // Opened, the field takes the keys at once.
  useEffect(() => {
    if (open) {
      field.current?.focus();
    }
  }, [open]);
  const add = () => {
    const typed = name.trim();
    if (typed === "") {
      return;
    }
    onAdd(typed);
    setName("");
    setOpen(false);
  };
  if (!open) {
    return (
      <Item
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
        </ItemContent>
      </Item>
    );
  }
  return (
    <Item variant="outline">
      <ItemContent>
        <Input
          aria-label={placeholder}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              add();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
          onValueChange={setName}
          placeholder={placeholder}
          ref={field}
          value={name}
        />
      </ItemContent>
      <ItemActions>
        <Button
          disabled={disabled || name.trim() === ""}
          onClick={add}
          variant="outline"
        >
          {t`Ask for it`}
        </Button>
      </ItemActions>
    </Item>
  );
};
