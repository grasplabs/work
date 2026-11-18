"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@ui-sdk/react/menu";
import {
  Fragment,
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { ReactNode, RefObject } from "react";

import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  menuStyles,
} from "../dropdown-menu";
import { Agent, Attach, ChevronRight, Icon, Plus, Tick } from "../icons";
import type { IconData } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { AgentMarkOf, RowInside, agentMenuStyles } from "./agent";
import type { ComposerAgentAll, ComposerAgentOption } from "./agent";
import { useShowChosenAgent } from "./agent-chip";
import { useComposerDisabled, useOpenMentions } from "./context";
import { cornerStyles } from "./corner";
import { stopEscape } from "./escape";
import { useComposerWords } from "./words";

/** One kind of thing a person can add to a message. */
export interface ComposerKind {
  /** What `onKind` receives ("people"). */
  value: string;
  /** Its name ("People"). */
  label: string;
  /** Its mark. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** One line on what it is, shown in the mention menu ("Tag someone in the team"). */
  description?: string;
}

/** One action about the chat, in the plus menu's last group. */
export interface ComposerAddAction {
  /** What `onAction` receives ("instructions"). */
  value: string;
  /** Its words ("Edit instructions"). */
  label: string;
  /** Its mark. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** Its keys, as Dropdown menu's items take them ("mod+k"). */
  shortcut?: string;
  /** Out of use. */
  disabled?: boolean;
}

/** Every prop a ComposerAdd takes. */
export interface ComposerAddProps {
  /** Called with the files chosen from the device. Without it there is no Upload attachment. */
  onAttach?: (files: File[]) => void;
  /** The kinds of thing that can be added, after the upload. */
  kinds?: ComposerKind[];
  /** Called with the kind chosen. Without it, the composer's mention menu opens at that kind. */
  onKind?: (kind: string) => void;
  /** Actions about this chat, in a group of their own at the menu's end: what a separate adjust button used to hold. */
  actions?: ComposerAddAction[];
  /** Called with the action chosen. */
  onAction?: (action: string) => void;
  /**
   * The actions' heading.
   * @default "This chat"
   */
  actionsLabel?: string;
  /**
   * Which files the device's picker offers, as an input's `accept` ("image/*,.pdf").
   */
  accept?: string;
  /**
   * The plus button's name.
   * @default "Add to message"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * The upload item's words.
   * @default "Upload attachment"
   */
  uploadLabel?: string;
  /**
   * The agents a message can go to, as ComposerAgent takes them. With them and `onValueChange`, a
   * row "Agent" opens their list, and a chosen agent other than the default shows above the text.
   */
  agents?: ComposerAgentOption[];
  /** The chosen agent's `value`. */
  value?: string;
  /** Called with the agent chosen, or with the default one when the chip above the text is removed. */
  onValueChange?: (value: string) => void;
  /** A last row in the agents' list, a link to all of them ("All agents"). */
  all?: ComposerAgentAll;
  /**
   * The agent a message goes to when no other is chosen: chosen, it shows no chip above the text.
   * @default the first agent
   */
  defaultAgent?: string;
  /**
   * The agents' row's words.
   * @default "Agent"
   */
  agentLabel?: string;
}

const noKinds: ComposerKind[] = [];
const noActions: ComposerAddAction[] = [];
const noAgents: ComposerAgentOption[] = [];

const styles = stylex.create({
  // The agents' row: a menu item that opens a list beside it, lit while it is open too.
  agentRow: {
    backgroundColor: {
      default: "transparent",
      ":is([data-highlighted], [data-open])": {
        default: grasp.itemFillHighlight,
        [media.forced]: "Highlight",
      },
    },
  },
  // The chosen agent at the row's end: its mark and its name, quieter than the row's words.
  chosen: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 100,
    minWidth: 0,
    marginInlineStart: "auto",
    color: { default: grasp.muted, [media.forced]: "inherit" },
    fontWeight: grasp.weightRegular,
  },
  chosenName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: { default: grasp.muted, [media.forced]: "inherit" },
  },
});

// Cmd or Ctrl and / clicks the hidden file input, while focus is in its form. Returns the cleanup.
const listenForPicker = (picker: RefObject<HTMLInputElement | null>) => {
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "/" || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    const form = picker.current?.closest("form");
    if (
      !form ||
      !(event.target instanceof Node) ||
      !form.contains(event.target)
    ) {
      return;
    }
    event.preventDefault();
    picker.current?.click();
  };
  document.addEventListener("keydown", keys);
  return () => {
    document.removeEventListener("keydown", keys);
  };
};

/** The agents' row and the list it opens beside it: arrows, Enter, Escape back to the row. */
const AgentsSub = ({
  agents,
  value,
  onValueChange,
  all,
  label,
}: {
  agents: ComposerAgentOption[];
  value: string;
  onValueChange: (value: string) => void;
  all: ComposerAgentAll | undefined;
  label: string;
}) => {
  const chosen = agents.find((agent) => agent.value === value);
  return (
    <MenuSub>
      <MenuSubTrigger
        className={stylex.props(menuStyles.item, styles.agentRow).className}
      >
        <span
          aria-hidden="true"
          data-menu-icon=""
          {...stylex.props(menuStyles.icon)}
        >
          <Icon icon={Agent} />
        </span>
        <span {...stylex.props(menuStyles.words)}>{label}</span>
        {chosen !== undefined && (
          <span {...stylex.props(styles.chosen)}>
            <span
              aria-hidden="true"
              {...stylex.props(agentMenuStyles.markLine)}
            >
              <AgentMarkOf agent={chosen} />
            </span>
            <span {...stylex.props(styles.chosenName)}>{chosen.label}</span>
          </span>
        )}
        <span aria-hidden="true" {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronRight} />
        </span>
      </MenuSubTrigger>
      <MenuSubContent
        sideOffset={popup.gap}
        alignOffset={-popup.gap}
        collisionPadding={popup.gutter}
        aria-label={label}
        {...stylex.props(
          menuStyles.panel,
          menuStyles.motion,
          agentMenuStyles.panel
        )}
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
              closeOnSelect
              className={stylex.props(agentMenuStyles.row).className}
            >
              <RowInside
                agent={agent}
                end={
                  <MenuItemIndicator {...stylex.props(agentMenuStyles.tick)}>
                    <Icon icon={Tick} />
                  </MenuItemIndicator>
                }
              />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {all !== undefined && (
          <>
            <MenuSeparator {...stylex.props(agentMenuStyles.separator)} />
            <MenuItem
              label={all.label}
              render={createElement("a", { href: all.href })}
              className={
                stylex.props(agentMenuStyles.row, agentMenuStyles.all).className
              }
            >
              {all.label}
            </MenuItem>
          </>
        )}
      </MenuSubContent>
    </MenuSub>
  );
};

/** Hands the card the chosen agent to show above the text, while it is not the default one. */
const useChosenAgentChip = (
  agents: ComposerAgentOption[],
  value: string | undefined,
  onValueChange: ((value: string) => void) | undefined,
  defaultAgent: string | undefined
) => {
  const show = useShowChosenAgent();
  const home = defaultAgent ?? agents[0]?.value;
  // Before paint, so a chosen agent's chip never shows a frame late.
  useLayoutEffect(() => {
    const agent = agents.find((each) => each.value === value);
    const fallback = agents.find((each) => each.value === home);
    const shown =
      agent !== undefined &&
      fallback !== undefined &&
      agent.value !== fallback.value &&
      onValueChange !== undefined;
    show?.(
      shown
        ? {
            agent,
            fallback,
            onRemove: () => {
              onValueChange(fallback.value);
            },
          }
        : null
    );
    return () => {
      show?.(null);
    };
  }, [show, agents, value, home, onValueChange]);
};

/** The menu's parts that hold something, a hairline between each two. */
const withHairlines = (parts: ReactNode[]) =>
  parts.flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <Fragment key={`hairline-${index}`}>
            <DropdownMenuSeparator />
          </Fragment>,
          part,
        ]
  );

/** The plus menu: upload a file, or add a person, an agent, a skill or a file. */
export const ComposerAdd = ({
  onAttach,
  kinds = noKinds,
  onKind,
  actions = noActions,
  onAction,
  actionsLabel: actionsGiven,
  accept,
  label: labelDeprecated,
  "aria-label": labelGiven,
  uploadLabel: uploadGiven,
  agents = noAgents,
  value,
  onValueChange,
  all,
  defaultAgent,
  agentLabel: agentGiven,
}: ComposerAddProps) => {
  const disabled = useComposerDisabled();
  // Its words: the caller's where given, else the product's catalogue (GraspWords), else English.
  const words = useComposerWords("add");
  const actionsLabel = actionsGiven ?? words.actions;
  const label = labelGiven ?? labelDeprecated ?? words.label;
  const uploadLabel = uploadGiven ?? words.upload;
  const agentLabel = agentGiven ?? words.agent;
  // A chosen agent other than the default shows above the text.
  useChosenAgentChip(agents, value, onValueChange, defaultAgent);
  // Without its own onKind, a kind opens the composer's mention menu at that kind.
  const openMentions = useOpenMentions();
  const choose = onKind ?? ((kind: string) => openMentions?.(kind));
  const picker = useRef<HTMLInputElement | null>(null);

  // Cmd or Ctrl and / opens the device's picker, while focus is in this composer.
  useEffect(
    () => (onAttach === undefined ? undefined : listenForPicker(picker)),
    [onAttach]
  );

  return (
    <DropdownMenu>
      {/* First or last in its side of the footer, the button nests in the card's corner (corner.ts);
          its menu stands outside the nest, so it keeps the system's corners. */}
      <span {...stylex.props(cornerStyles.nest)}>
        {onAttach && (
          <input
            ref={picker}
            type="file"
            multiple
            accept={accept}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              if (files.length > 0) {
                onAttach(files);
              }
            }}
          />
        )}
        <DropdownMenuTrigger
          icon={Plus}
          aria-label={label}
          variant="ghost"
          size="sm"
          disabled={disabled}
        />
      </span>
      <DropdownMenuContent side="top" align="start" onKeyDown={stopEscape}>
        {withHairlines(
          [
            onAttach && (
              <DropdownMenuItem
                key="upload"
                icon={Attach}
                shortcut="mod+/"
                onSelect={() => {
                  picker.current?.click();
                }}
              >
                {uploadLabel}
              </DropdownMenuItem>
            ),
            kinds.length > 0 &&
              kinds.map((kind) => (
                <DropdownMenuItem
                  key={kind.value}
                  icon={kind.icon}
                  onSelect={() => {
                    choose(kind.value);
                  }}
                >
                  {kind.label}
                </DropdownMenuItem>
              )),
            agents.length > 0 &&
              value !== undefined &&
              onValueChange !== undefined && (
                <AgentsSub
                  key="agents"
                  agents={agents}
                  value={value}
                  onValueChange={onValueChange}
                  all={all}
                  label={agentLabel}
                />
              ),
            actions.length > 0 && (
              <DropdownMenuGroup key="actions">
                <DropdownMenuLabel>{actionsLabel}</DropdownMenuLabel>
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.value}
                    icon={action.icon}
                    shortcut={action.shortcut}
                    disabled={action.disabled}
                    onSelect={() => {
                      onAction?.(action.value);
                    }}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ),
          ].filter(Boolean)
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
