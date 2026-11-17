"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import {
  MenuContent,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { createElement, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { DropdownMenu, menuStyles } from "../dropdown-menu";
import { focus } from "../focus/focus";
import { ChevronDown, Icon, Search, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { popoverStyles } from "../popover/styles";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";
import { stopEscape } from "./escape";
import { tabOutTarget } from "./tab-out";
import { composerAgentWords } from "./words";

/** One agent a message can go to. */
export interface ComposerAgentOption {
  /** What `onValueChange` receives. */
  value: string;
  /** Its name ("Invoice chaser"). */
  label: string;
  /** What it is for, in one quiet line under its name ("Chases unpaid invoices"). */
  description?: string;
  /** Its mark as an icon. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** Its mark as a picture: its address, or `true` for its initials. Used when it has no `icon`. */
  avatar?: string | true;
  /** Out of use: shown, dimmed, and cannot be chosen. */
  disabled?: boolean;
}

/** The last row of the menu: a link to all the agents. */
export interface ComposerAgentAll {
  /** Its words ("All agents"). */
  label: string;
  /** Where it goes. */
  href: string;
}

/** Every prop a ComposerAgent takes. */
export interface ComposerAgentProps {
  /** The agents, in the menu's order. With none, nothing is drawn. */
  agents: ComposerAgentOption[];
  /** The chosen agent's `value`. */
  value: string;
  /** Called with the agent chosen. */
  onValueChange: (value: string) => void;
  /** A last row, a link to all the agents ("All agents"). */
  all?: ComposerAgentAll;
  /**
   * The control's name for a screen reader, before the agent's own name.
   * @default "Agent"
   */
  "aria-label"?: string;
  /**
   * The search field's name and placeholder, with more than eight agents.
   * @default "Search agents"
   */
  searchLabel?: string;
  /**
   * What the list says when nothing matches the search.
   * @default "No agents found"
   */
  emptyLabel?: string;
}

/** Past this many agents a search field stands above them. */
const SEARCH_FROM = 8;

const styles = stylex.create({
  // The menu: as wide as the model's, its rows taller for their second line.
  panel: {
    width: `min(${grasp.modelMenuWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height, ${grasp.popupHeight}))`,
    overflowY: "auto",
    transformOrigin: "var(--transform-origin)",
  },
  // The search, the list and the link to all: the list takes what room is left and scrolls.
  searchPanel: {
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr) auto",
    overflowY: "hidden",
  },
  command: {
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    minHeight: 0,
  },
  search: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.space3,
    minHeight: grasp.controlMd,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
    color: grasp.muted,
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  list: {
    display: "grid",
    alignContent: "start",
    padding: grasp.space1,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  // An agent's row: its mark on the name's line, its name, and its quiet line under it.
  row: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: { default: grasp.controlXs, [media.coarse]: grasp.tap },
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    cursor: "pointer",
    outline: "none",
    backgroundColor: {
      default: "transparent",
      ":is([data-highlighted])": grasp.itemFillHighlight,
    },
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
    textDecoration: "none",
  },
  // The mark stands on the name's line.
  markLine: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    height: grasp.textSmLine,
  },
  words: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  line: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    height: grasp.textSmLine,
  },
  // The last row, a link to all the agents: quiet, its words where the names start.
  all: {
    color: grasp.muted,
    paddingInlineStart: `calc(${grasp.space2} + ${grasp.iconSm} + ${grasp.space2})`,
    alignItems: "center",
  },
  allFoot: {
    padding: grasp.space1,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  separator: {
    height: grasp.hairline,
    marginBlock: grasp.space1,
    backgroundColor: grasp.line,
  },
  empty: {
    display: { default: "block", ":empty": "none" },
    padding: grasp.space3,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

/** An agent's mark: its icon, or its picture (its initials until it loads). */
const AgentMarkOf = ({ agent }: { agent: ComposerAgentOption | undefined }) => {
  if (agent === undefined) {
    return null;
  }
  if (agent.icon !== undefined) {
    return <Icon icon={agent.icon} />;
  }
  if (agent.avatar === undefined) {
    return null;
  }
  return (
    <Avatar decorative name={agent.label} size="2xs">
      {typeof agent.avatar === "string" && <AvatarImage src={agent.avatar} />}
      <AvatarFallback />
    </Avatar>
  );
};

/** An agent's row's inside: its mark, its name and its line, and at its end the tick of the chosen one. */
const RowInside = ({
  agent,
  end,
}: {
  agent: ComposerAgentOption;
  end: ReactNode;
}) => (
  <>
    <span aria-hidden="true" {...stylex.props(styles.markLine)}>
      <AgentMarkOf agent={agent} />
    </span>
    <span {...stylex.props(styles.words)}>
      <span {...stylex.props(styles.name)}>{agent.label}</span>
      {agent.description !== undefined && agent.description !== "" && (
        <span {...stylex.props(styles.line)}>{agent.description}</span>
      )}
    </span>
    {end}
  </>
);

/** The control in the footer: the chosen agent's mark and name, and the chevron. */
const Face = ({
  props,
  agent,
}: {
  props: Record<string, unknown>;
  agent: ComposerAgentOption | undefined;
}) => (
  <button
    {...props}
    type="button"
    data-slot="composer-agent"
    {...stylex.props(controlStyles.control, focus.ring)}
  >
    <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
    <span key={agent?.value} {...stylex.props(controlStyles.value)}>
      <AgentMarkOf agent={agent} />
      <span {...stylex.props(controlStyles.words, controlStyles.narrowWords)}>
        {agent?.label}
      </span>
    </span>
    <Icon icon={ChevronDown} />
  </button>
);

/** The tick on the chosen agent's row. */
const ChosenTick = () => (
  <span aria-hidden="true" {...stylex.props(styles.tick)}>
    <Icon icon={Tick} />
  </span>
);

/** What the two forms of the menu share. */
interface FormProps {
  agents: ComposerAgentOption[];
  chosen: ComposerAgentOption | undefined;
  value: string;
  onValueChange: (value: string) => void;
  all: ComposerAgentAll | undefined;
  label: string;
  disabled: boolean;
}

/** Up to eight agents: a menu, the arrows move and type-ahead finds a name. */
const AgentMenu = ({
  agents,
  chosen,
  value,
  onValueChange,
  all,
  label,
  disabled,
}: FormProps) => (
  <DropdownMenu>
    <MenuTrigger
      disabled={disabled}
      aria-label={`${label}: ${chosen?.label ?? ""}`}
      render={(props: Record<string, unknown>) => (
        <Face props={props} agent={chosen} />
      )}
    />
    <MenuContent
      side="top"
      align="start"
      sideOffset={popup.popoverGap}
      collisionPadding={popup.gutter}
      aria-label={label}
      onKeyDown={stopEscape}
      {...stylex.props(menuStyles.panel, menuStyles.motion, styles.panel)}
    >
      <MenuRadioGroup
        value={value}
        onValueChange={(next: string) => {
          onValueChange(next);
        }}
      >
        {agents.map((agent) => (
          <MenuRadioItem
            key={agent.value}
            value={agent.value}
            label={agent.label}
            disabled={agent.disabled}
            className={stylex.props(styles.row).className}
          >
            <RowInside
              agent={agent}
              end={
                <MenuItemIndicator {...stylex.props(styles.tick)}>
                  <Icon icon={Tick} />
                </MenuItemIndicator>
              }
            />
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {all !== undefined && (
        <>
          <MenuSeparator {...stylex.props(styles.separator)} />
          <MenuItem
            label={all.label}
            render={createElement("a", { href: all.href })}
            className={stylex.props(styles.row, styles.all).className}
          >
            {all.label}
          </MenuItem>
        </>
      )}
    </MenuContent>
  </DropdownMenu>
);

/** More than eight: a search field over the list; typing finds an agent by name. */
const AgentSearch = ({
  agents,
  chosen,
  value,
  onValueChange,
  all,
  label,
  disabled,
  searchLabel,
  emptyLabel,
}: FormProps & { searchLabel: string; emptyLabel: string }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Tab from the last stop (the link to all agents): on past the control, the menu closed.
    const out =
      event.key === "Tab"
        ? tabOutTarget(event.currentTarget, event.target, event.shiftKey)
        : undefined;
    if (out !== undefined) {
      event.preventDefault();
      setOpen(false);
      out.focus();
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
    }
    stopEscape(event);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${label}: ${chosen?.label ?? ""}`}
        render={(props: Record<string, unknown>) => (
          <Face props={props} agent={chosen} />
        )}
      />
      <PopoverContent
        onKeyDown={keys}
        side="top"
        align="start"
        sideOffset={popup.popoverGap}
        collisionPadding={popup.gutter}
        aria-label={label}
        {...stylex.props(
          popoverStyles.panel,
          popoverStyles.motion,
          styles.panel,
          styles.searchPanel
        )}
      >
        <Command
          query={query}
          onQueryChange={setQuery}
          onAction={(next: string) => {
            onValueChange(next);
            setOpen(false);
          }}
          {...stylex.props(styles.command)}
        >
          <div {...stylex.props(styles.search)}>
            <Icon icon={Search} />
            <CommandInput
              aria-label={searchLabel}
              placeholder={searchLabel}
              {...stylex.props(styles.input)}
            />
          </div>
          <div {...stylex.props(styles.list)}>
            <CommandEmpty {...stylex.props(styles.empty)}>
              {emptyLabel}
            </CommandEmpty>
            <CommandList aria-label={label}>
              {agents.map((agent) => (
                <CommandItem
                  key={agent.value}
                  value={agent.value}
                  label={agent.label}
                  keywords={
                    agent.description === undefined
                      ? undefined
                      : [agent.description]
                  }
                  disabled={agent.disabled}
                  {...stylex.props(styles.row)}
                >
                  <RowInside
                    agent={agent}
                    end={agent.value === value ? <ChosenTick /> : null}
                  />
                </CommandItem>
              ))}
            </CommandList>
          </div>
        </Command>
        {all !== undefined && (
          <div {...stylex.props(styles.allFoot)}>
            <a
              href={all.href}
              {...stylex.props(styles.row, styles.all, focus.inside)}
            >
              {all.label}
            </a>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

/** The agent a message goes to: a quiet control before the model, and its menu. */
export const ComposerAgent = ({
  agents,
  value,
  onValueChange,
  all,
  "aria-label": label = composerAgentWords.agent,
  searchLabel = composerAgentWords.search,
  emptyLabel = composerAgentWords.empty,
}: ComposerAgentProps) => {
  const disabled = useComposerDisabled();
  if (agents.length === 0) {
    return null;
  }
  const chosen = agents.find((agent) => agent.value === value);
  const shared: FormProps = {
    agents,
    chosen,
    value,
    onValueChange,
    all,
    label,
    disabled,
  };
  return agents.length > SEARCH_FROM ? (
    <AgentSearch
      {...shared}
      searchLabel={searchLabel}
      emptyLabel={emptyLabel}
    />
  ) : (
    <AgentMenu {...shared} />
  );
};
