// DropdownMenuItem: an action in a dropdown menu (menu.tsx), UI SDK's MenuItem in Grasp's look: an
// icon, its words, and the keys of its shortcut at the end. Pressing it runs it and closes the menu.
// An item with work keeps the menu open while the work runs, closes it when done, and says so on
// the item when it failed: for a person, and to an agent with the same words.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import type { ButtonState } from "@ui-sdk/react/button";
import {
  MenuItem as ItemPrimitive,
  MenuItemIcon,
  MenuShortcut,
} from "@ui-sdk/react/menu";
import type { MenuItemState } from "@ui-sdk/react/menu";
import { useShortcutHint } from "@ui-sdk/react/shortcuts";
import { useRef } from "react";
import type { ComponentProps } from "react";

import { announce } from "../announce/announce";
import { Icon, Spinner } from "../icons";
import type { IconData } from "../icons";
import { useMenuWork } from "./menu";
import type { MenuWork } from "./menu";
import { menuStyles as styles } from "./styles";

type ItemPrimitiveProps = ComponentProps<typeof ItemPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** What every item takes. */
interface ItemBase extends Omit<
  ItemPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "value"
  | "label"
  | "shortcut"
  | "destructive"
  | "onSelect"
> {
  /** The words on the item: a verb first ("Duplicate"). Typing its first letters finds it, and an agent presses it by them. */
  children: string;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * The keys that do the same elsewhere on the page, like `"mod+d"`: shown at the end as ⌘D on a
   * Mac and Ctrl+D elsewhere, and named to a screen reader. It shows the keys; binding them is the
   * page's.
   */
  shortcut?: string;
  /**
   * An item that deletes or cannot be undone: drawn in the danger colour, and an agent asks the
   * person before pressing it.
   * @default false
   */
  danger?: boolean;
  /**
   * Out of use: drawn at half strength and pressing it does nothing, but the keys still reach it,
   * as the menu pattern asks.
   * @default false
   */
  disabled?: boolean;
  /**
   * What the item does, for the person an agent must ask first ("Deletes the report"). A `danger`
   * item asks with its own words when this is left out.
   */
  agentConfirm?: string;
  /**
   * Flips the icon in right to left, for one that points the way of reading, like Sign out's arrow.
   * @default false
   */
  mirrorIcon?: boolean;
}

/** An item that only runs something quick. */
interface WithoutWork {
  /** Runs when it is pressed, by pointer, Enter or Space. Call `event.preventDefault()` to keep the menu open. */
  onSelect?: (event: Event) => void;
  /**
   * Whether pressing it closes the menu.
   * @default true
   */
  closeOnSelect?: boolean;
  action?: undefined;
  failedLabel?: never;
}

/**
 * An item with work to do before the menu closes.
 */
interface WithWork {
  onSelect?: never;
  closeOnSelect?: never;
  /**
   * The work. Return a Promise and the menu stays open while it runs, with a spinner at the end of
   * the item. When it fails, the item says `failedLabel` and the menu stays open to try again.
   */
  action: () => unknown;
  /** The words when the work failed, at the end of the item and to an agent ("Could not publish"). */
  failedLabel: string;
}

/** Every prop a DropdownMenuItem takes: these, and the rest of UI SDK's MenuItem. */
export type DropdownMenuItemProps = ItemBase & (WithoutWork | WithWork);

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

interface Keys {
  text: string;
  aria: string;
}

interface ItemLook {
  children: string;
  icon?: IconData | undefined;
  mirrorIcon?: boolean | undefined;
  danger: boolean;
  failedLabel?: string | undefined;
  keys?: Keys | undefined;
}

/** What stands at the end of the item: the spinner while it works, its failure, or its keys. */
const End = ({
  look,
  pending,
  failed,
}: {
  look: ItemLook;
  pending: boolean;
  failed: boolean;
}) => {
  if (pending) {
    return (
      <span aria-hidden="true" {...stylex.props(styles.end, styles.spinner)}>
        <Icon icon={Spinner} />
      </span>
    );
  }
  if (failed && look.failedLabel !== undefined && look.failedLabel !== "") {
    return (
      <span {...stylex.props(styles.end, styles.failed)}>
        {look.failedLabel}
      </span>
    );
  }
  return (
    look.keys && (
      <MenuShortcut {...stylex.props(styles.end)}>
        {look.keys.text}
      </MenuShortcut>
    )
  );
};

/** The item's inside: its icon, its words, and at the end its keys, or its work, or its failure. */
const Inside = ({
  look,
  pending,
  failed,
}: {
  look: ItemLook;
  pending: boolean;
  failed: boolean;
}) => (
  <>
    {look.icon && (
      <MenuItemIcon
        mirror={look.mirrorIcon}
        data-menu-icon=""
        {...stylex.props(styles.icon)}
      >
        <Icon icon={look.icon} />
      </MenuItemIcon>
    )}
    <span
      {...stylex.props(
        styles.words,
        look.icon === undefined && styles.wordsBare
      )}
    >
      {look.children}
    </span>
    <End look={look} pending={pending} failed={failed} />
  </>
);

const itemClass = (
  danger: boolean,
  highlighted: boolean,
  disabled: boolean,
  pending: boolean
) =>
  className(
    styles.item,
    highlighted && styles.highlighted,
    danger && styles.danger,
    danger && highlighted && styles.dangerHighlighted,
    disabled && !pending && styles.disabled,
    pending && styles.pending
  );

interface WorkItemProps {
  shared: Record<string, unknown> & { disabled?: boolean | undefined };
  look: ItemLook;
  action: () => unknown;
  failedLabel: string;
}

// The events UI SDK's Button turns into its own press: a click, and the Enter and Space keys,
// which it answers with a click. Anything else that selects the item, like a pointer released on it
// after pressing the trigger, is handed to the Button as a click.
const reachesButton = (event: Event) =>
  event.type === "click" || event.type.startsWith("key");

/**
 * Runs an item's work, then closes the menu if it is still the same opening. A failure is said to a
 * screen reader and rejects with the failure words, so an agent's press fails with them.
 */
const runWork = async (
  action: () => unknown,
  menu: MenuWork,
  failedLabel: string
) => {
  const opening = menu.opening();
  try {
    await action();
  } catch (error) {
    announce(failedLabel);
    throw new Error(failedLabel, { cause: error });
  }
  if (menu.opening() === opening) {
    menu.controller.close({ reason: "item-press" });
  }
};

/** Sets a ref, whichever kind it is. */
const assignRef = (ref: unknown, element: HTMLElement | null) => {
  if (typeof ref === "function") {
    Reflect.apply(ref, null, [element]);
  } else if (typeof ref === "object" && ref !== null && "current" in ref) {
    Reflect.set(ref, "current", element);
  }
};

// An item with work: UI SDK's Button around UI SDK's MenuItem, on the one element. The item keeps
// its role, its place in the arrows' order and its highlight; the Button runs the work, so its press
// hands back the work's Promise, and an agent's press waits for it and fails with the failure words,
// as Dialog's and Popover's actions do. (UI SDK's bridge does not yet wait on a menu item's own
// Promise.) Once the work is done the menu closes, if it is still the same opening, and focus goes
// back to the trigger. UI SDK settles that Promise itself, so a person's failed press reaches the
// console as nothing; a screen reader hears the failure words.
const WorkItem = ({ shared, look, action, failedLabel }: WorkItemProps) => {
  const menu = useMenuWork();
  const self = useRef<HTMLElement | null>(null);
  if (!menu) {
    throw new Error(
      "A DropdownMenuItem with an action belongs inside a DropdownMenu, or a root that gives it MenuWork."
    );
  }
  const work = async () => {
    await runWork(action, menu, failedLabel);
  };
  return (
    <PressPrimitive
      pendingAnnouncement={menu.pendingAnnouncement}
      disabled={shared.disabled}
      focusableWhenDisabled
      onClick={work}
      render={(pressProps: Record<string, unknown>, press: ButtonState) => (
        <ItemPrimitive
          {...pressProps}
          {...shared}
          // The Button runs the work; the item only keeps the menu open while it does.
          closeOnSelect={false}
          ref={(element: HTMLElement | null) => {
            self.current = element;
            assignRef(pressProps.ref, element);
          }}
          onSelect={(event: Event) => {
            event.preventDefault();
            if (!reachesButton(event)) {
              self.current?.click();
            }
          }}
          className={(state: MenuItemState) =>
            itemClass(
              look.danger,
              state.highlighted,
              state.disabled,
              press.pending
            )
          }
        >
          <Inside
            look={look}
            pending={press.pending}
            failed={press.error !== undefined}
          />
        </ItemPrimitive>
      )}
    />
  );
};

const Item = ({
  children,
  icon,
  mirrorIcon,
  shortcut: _shortcut,
  danger = false,
  agentConfirm,
  onSelect,
  action,
  failedLabel,
  keys,
  ...rest
}: DropdownMenuItemProps & { keys?: Keys }) => {
  const confirm = agentConfirm ?? (danger ? children : undefined);
  const look: ItemLook = {
    children,
    icon,
    mirrorIcon,
    danger,
    failedLabel,
    keys,
  };
  const shared = {
    ...rest,
    label: children,
    destructive: danger,
    "aria-keyshortcuts": keys?.aria,
    "data-agent-confirm": confirm,
  };
  if (action) {
    return (
      <WorkItem
        shared={shared}
        look={look}
        action={action}
        failedLabel={failedLabel}
      />
    );
  }
  return (
    <ItemPrimitive
      {...shared}
      onSelect={onSelect}
      className={(state: MenuItemState) =>
        itemClass(danger, state.highlighted, state.disabled, state.pending)
      }
    >
      {(state: MenuItemState) => (
        <Inside look={look} pending={state.pending} failed={false} />
      )}
    </ItemPrimitive>
  );
};

// The keys, written for the platform the same way on the server and on first render, then for the
// one it is on.
const WithKeys = (props: DropdownMenuItemProps & { shortcut: string }) => {
  const hint = useShortcutHint(props.shortcut);
  return (
    <Item {...props} keys={{ text: hint.text, aria: hint.ariaKeyshortcuts }} />
  );
};

/** An item in the menu. */
export const DropdownMenuItem = (props: DropdownMenuItemProps) => {
  if (props.shortcut !== undefined && props.shortcut !== "") {
    return <WithKeys {...props} shortcut={props.shortcut} />;
  }
  return <Item {...props} />;
};
