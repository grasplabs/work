"use client";

import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { cn } from "@grasp-os/ui/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import * as React from "react";

// A title renamed where it stands, joined to its menu as one control: the
// name, which a click turns into a field to type the new one in (Enter or
// leaving it keeps it, Escape keeps the old one), and a chevron opening
// what can be done with what it names, its Rename among it. Not in shadcn;
// built as its parts are, on the kit's dropdown menu.
//
//   <EditableTitle value={title} onValueChange={rename} label="Chat name">
//     <EditableTitleField />
//     <DropdownMenu>
//       <EditableTitleTrigger aria-label="More for this chat" />
//       <EditableTitleMenuContent>
//         <EditableTitleRenameItem>Rename</EditableTitleRenameItem>
//         …
//       </EditableTitleMenuContent>
//     </DropdownMenu>
//   </EditableTitle>

interface EditableTitleContextProps {
  value: string;
  label: string;
  editing: boolean;
  /** Turns the title into its field, focused, the name selected. */
  edit: () => void;
  /** Keeps `next` as the title, where it is a new one, and leaves the field. */
  commit: (next: string) => void;
  /** Leaves the field, keeping the title as it was. */
  cancel: () => void;
  /** The field, while there is one: where the menu gives focus back. */
  field: React.RefObject<HTMLInputElement | null>;
  /** Turns the title into its field from its menu's Rename. */
  editFromMenu: () => void;
  /**
   * Where its menu gives the focus as it closes: after Rename, the field,
   * where it is drawn already, or nowhere, as it takes the focus once
   * drawn; else back where it was.
   */
  focusAfterMenu: () => HTMLElement | boolean;
}

const EditableTitleContext =
  React.createContext<EditableTitleContextProps | null>(null);

function useEditableTitle() {
  const context = React.useContext(EditableTitleContext);
  if (!context) {
    throw new Error("useEditableTitle must be used within an EditableTitle.");
  }
  return context;
}

/**
 * The control: `value`, renamed to what is typed (`onValueChange`, given
 * the new name trimmed, and never an empty or unchanged one). `label`
 * names the field to assistive technology.
 */
function EditableTitle({
  value,
  onValueChange,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const field = React.useRef<HTMLInputElement>(null);
  const fromMenu = React.useRef(false);
  const context: EditableTitleContextProps = {
    value,
    label,
    editing,
    edit: () => {
      setEditing(true);
    },
    commit: (next) => {
      fromMenu.current = false;
      setEditing(false);
      const name = next.trim();
      if (name !== "" && name !== value) {
        onValueChange(name);
      }
    },
    cancel: () => {
      fromMenu.current = false;
      setEditing(false);
    },
    field,
    editFromMenu: () => {
      fromMenu.current = true;
      setEditing(true);
    },
    focusAfterMenu: () => (fromMenu.current ? (field.current ?? false) : true),
  };
  return (
    // The React Compiler memoizes the value; nothing here does by hand (AGENTS.md).
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <EditableTitleContext.Provider value={context}>
      <div
        data-slot="editable-title"
        data-editing={editing}
        className={cn(
          "group/editable-title hover:bg-accent has-focus-visible:ring-ring/50 data-[editing=true]:ring-ring/50 flex h-8 min-w-0 items-center rounded-md transition-colors has-focus-visible:ring-3 data-[editing=true]:bg-transparent data-[editing=true]:ring-1",
          className
        )}
        {...props}
      />
    </EditableTitleContext.Provider>
  );
}

/** The title, or, renaming, the field the new name is typed in. */
function EditableTitleField({
  className,
  maxLength,
}: {
  className?: string;
  /** The longest name it takes. */
  maxLength?: number;
}) {
  const { value, label, editing, edit, commit, cancel, field } =
    useEditableTitle();
  if (editing) {
    return (
      <input
        ref={field}
        aria-label={label}
        // It opens to be typed in, the name selected to be typed over.
        autoFocus
        data-slot="editable-title-input"
        defaultValue={value}
        maxLength={maxLength}
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent px-2 text-sm font-medium outline-hidden",
          className
        )}
        onBlur={(event) => {
          commit(event.currentTarget.value);
        }}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            // What has a use of its own for Escape (a panel) leaves it be.
            event.stopPropagation();
            cancel();
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`${label}: ${value}`}
      data-slot="editable-title-field"
      className={cn(
        "h-full min-w-0 truncate rounded-l-md px-2 text-left text-sm font-medium outline-hidden",
        className
      )}
      onClick={edit}
    >
      {value}
    </button>
  );
}

/**
 * Its menu's content: the kit's dropdown menu's, which, closing on Rename,
 * gives the focus to the field the new name is typed in, not back to the
 * chevron.
 */
function EditableTitleMenuContent(
  props: React.ComponentProps<typeof DropdownMenuContent>
) {
  const { focusAfterMenu } = useEditableTitle();
  // Asked as it closes, after the click on Rename has begun the renaming.
  return <DropdownMenuContent finalFocus={focusAfterMenu} {...props} />;
}

/** The chevron that opens the menu, the control's right half. */
function EditableTitleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuTrigger>) {
  return (
    <DropdownMenuTrigger
      data-slot="editable-title-trigger"
      render={
        <Button
          size="icon-sm"
          variant="ghost"
          className={cn(
            "text-muted-foreground group-hover/editable-title:text-foreground rounded-l-none hover:bg-transparent aria-expanded:bg-transparent",
            className
          )}
        />
      }
      {...props}
    >
      <ChevronDownIcon />
    </DropdownMenuTrigger>
  );
}

/** The menu's Rename: the title turns into its field, which takes the focus. */
function EditableTitleRenameItem({
  onClick,
  ...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
  const { editFromMenu } = useEditableTitle();
  return (
    <DropdownMenuItem
      onClick={(event) => {
        onClick?.(event);
        editFromMenu();
      }}
      {...props}
    />
  );
}

export {
  EditableTitle,
  EditableTitleField,
  EditableTitleMenuContent,
  EditableTitleRenameItem,
  EditableTitleTrigger,
  useEditableTitle,
};
