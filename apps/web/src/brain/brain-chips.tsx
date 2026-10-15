import { Button } from "@grasp-os/ui/components/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { MinusIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { dotClass, tintClass } from "./brain-colors.ts";
import { kindLabel, quoted } from "./brain.ts";
import type { Note } from "./brain.ts";

// Notes named on a page, and rows of them, as the prototype draws them
// (`components/brain-chips.tsx`).

/** How many items a row of links shows before the rest folds behind a count. */
const perRow = 3;

/** A row of links, the first three shown and the rest behind "+N", which opens the row in place and closes it again. */
export const Capped = ({
  children,
  className = "gap-1.5",
}: {
  children: ReactNode[];
  className?: string;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const hidden = children.length - perRow;
  if (hidden <= 0) {
    return (
      <span className={`flex flex-wrap items-center ${className}`}>
        {children}
      </span>
    );
  }
  return (
    <span className={`flex flex-wrap items-center ${className}`}>
      {open ? children : children.slice(0, perRow)}
      <Button
        aria-expanded={open}
        aria-label={
          open
            ? t`Show fewer`
            : t`${plural(hidden, { one: "Show # more", other: "Show # more" })}`
        }
        onClick={() => {
          setOpen(!open);
        }}
        size="xs"
        variant="secondary"
      >
        {open ? <MinusIcon /> : `+${hidden}`}
      </Button>
    </span>
  );
};

/** What marks a note in a chip: the logo of a tool or application, else the colour dot of its kind. */
const NoteMark = ({ note }: { note: Note }) => {
  if (note.kind === "tool" || note.kind === "app") {
    return <AppLogo name={note.title} size="xs" />;
  }
  return (
    <span
      className={`size-1.5 flex-none rounded-full ${dotClass(note.kind)}`}
    />
  );
};

/** A note named on a page: its colour dot and name, and a preview on hover, with why it is here when the page says. */
export const NoteChip = ({
  note,
  label,
  reason,
}: {
  note: Note;
  /** The words the page names it with; its title without them. */
  label?: string | undefined;
  reason?: string | undefined;
}) => {
  const { i18n } = useLingui();
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Link
            className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 align-baseline leading-tight ${tintClass(note.kind)}`}
            params={{ noteId: note.id }}
            to="/brain/$noteId"
          />
        }
      >
        <NoteMark note={note} />
        <span className="truncate">{label ?? note.title}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start">
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className={`size-1.5 rounded-full ${dotClass(note.kind)}`} />
            {i18n._(kindLabel[note.kind])}
          </span>
          <span className="font-medium">
            {note.kind === "statement" ? quoted(note.title) : note.title}
          </span>
          <span className="text-muted-foreground line-clamp-3">
            {note.summary}
          </span>
          {/* Why the note is linked from where it is shown, where the place says. */}
          {reason === undefined ? null : (
            <span className="border-t pt-1.5 text-xs">{reason}</span>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};
