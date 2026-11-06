import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Announcements, DragEndEvent, Modifier } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cssVars } from "@grasp-os/ui/lib/css-vars";
import { cn } from "@grasp-os/ui/lib/utils";
import { GripVerticalIcon } from "lucide-react";
import { useLayoutEffect } from "react";
import type * as React from "react";

/*
 * A list put in order by hand: each item dragged by its handle, or moved
 * from the keyboard (Space or Enter on the handle picks it up, the arrows
 * move it, Space or Enter drops it, Escape puts it back), and every move
 * said to screen readers. dnd-kit underneath; the words are the page's,
 * as the kit holds no language of its own.
 */

/** What a screen reader hears as an item is moved: its name, and its place from 1. */
interface SortableWords {
  /** How to move an item from the keyboard, read once a handle has focus. */
  instructions: string;
  picked: (name: string, place: number) => string;
  moved: (name: string, place: number) => string;
  dropped: (name: string, place: number) => string;
  cancelled: (name: string) => string;
}

/** An item of the list: its stable ID, and the name it's said by. */
interface SortableEntry {
  id: string;
  name: string;
}

/** Only up and down: a list's items never leave its column. */
const alongTheList: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const modifiers = [alongTheList];

/**
 * Where every item is, known before a drag starts: a key pressed right
 * after another finds them measured.
 */
const measuring = { droppable: { strategy: MeasuringStrategy.Always } };

/**
 * An item dropped is at its place at once: no slide from where it was,
 * which would also leave the next pick-up measuring it mid-slide.
 */
const still = () => false;

/**
 * The items, in order, put in order by hand: `onMove` hears an item's ID
 * and the place it was dropped at, from 0. Its children are its
 * `SortableItem`s, in `items`' order.
 */
function SortableList({
  items,
  onMove,
  words,
  disabled = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"ul">, "onMove"> & {
  items: readonly SortableEntry[];
  onMove: (id: string, to: number) => void;
  words: SortableWords;
  disabled?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
  const ids = items.map(({ id }) => id);
  const nameOf = (id: string | number): string =>
    items.find((item) => item.id === id)?.name ?? String(id);
  const placeOf = (id: string | number | undefined): number =>
    ids.indexOf(String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      words.picked(nameOf(active.id), placeOf(active.id)),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : words.moved(nameOf(active.id), placeOf(over.id)),
    onDragEnd: ({ active, over }) =>
      words.dropped(nameOf(active.id), placeOf(over?.id ?? active.id)),
    onDragCancel: ({ active }) => words.cancelled(nameOf(active.id)),
  };
  const end = ({ active, over }: DragEndEvent): void => {
    if (over === null || active.id === over.id) {
      return;
    }
    const to = ids.indexOf(String(over.id));
    if (to !== -1) {
      onMove(String(active.id), to);
    }
  };
  return (
    <DndContext
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: words.instructions },
      }}
      collisionDetection={closestCenter}
      measuring={measuring}
      modifiers={modifiers}
      onDragEnd={end}
      sensors={sensors}
    >
      <SortableContext
        disabled={disabled}
        items={ids}
        strategy={verticalListSortingStrategy}
      >
        <ul
          data-slot="sortable-list"
          className={cn("flex min-w-0 flex-col gap-0.5", className)}
          {...props}
        >
          {children}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/**
 * An item of a `SortableList`, by its `id`: its grip first (`handleLabel`
 * names it), which drags it and moves it from the keyboard, then its
 * children.
 */
function SortableItem({
  id,
  handleLabel,
  className,
  children,
  ...props
}: React.ComponentProps<"li"> & { id: string; handleLabel: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
    node,
  } = useSortable({ id, transition: null, animateLayoutChanges: still });
  const moved = CSS.Translate.toString(transform) ?? "none";
  // Where the drag has it, set on the item it already holds: a ref of its
  // own would hand dnd-kit a new node each render, mid-drag.
  useLayoutEffect(() => {
    cssVars({ "--moved": moved })(node.current);
  }, [moved, node]);
  return (
    <li
      data-slot="sortable-item"
      data-dragging={isDragging ? "" : undefined}
      ref={setNodeRef}
      className={cn(
        "bg-background relative flex min-w-0 transform-(--moved) items-center gap-1 rounded-md data-dragging:z-10 data-dragging:shadow-md",
        className
      )}
      {...props}
    >
      <button
        type="button"
        data-slot="sortable-handle"
        title={handleLabel}
        disabled={attributes["aria-disabled"]}
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={handleLabel}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm outline-none focus-visible:ring-3 active:cursor-grabbing disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
      >
        <GripVerticalIcon aria-hidden />
      </button>
      {children}
    </li>
  );
}

export { SortableItem, SortableList };
export type { SortableEntry, SortableWords };
