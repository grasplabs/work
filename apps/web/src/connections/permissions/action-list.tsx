// Every action of an app in a compact row under its kind (view, change,
// delete), found by typing, each with Off, Read or Write on one control. A
// row's name opens its provider's own description, in its words.
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Icon, SearchIcon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { AllowedTool } from "../tool-choices.ts";
import { choiceOf, countOn, toolKinds, withChoice } from "./model.ts";
import type { Choice, SortedTool, ToolKind } from "./model.ts";
import { KindDot } from "./parts.tsx";

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  kind: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    paddingBlockEnd: space[1],
  },
  list: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "grid",
    gap: space[1],
    paddingBlock: space[1],
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space[3],
  },
  name: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
    padding: 0,
    border: "none",
    background: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  about: { paddingInlineStart: space[4], paddingBlockEnd: space[1] },
});

/** One action: its name, its choice, and its description when opened. */
const Row = ({
  entry,
  choice,
  onChoice,
}: {
  entry: SortedTool;
  choice: Choice;
  onChoice: (choice: Choice) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { tool, name, deprecated } = entry;
  return (
    <li {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.line)}>
        <button
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          type="button"
          {...stylex.props(styles.name)}
        >
          <Text
            as="span"
            color={choice === "off" ? "muted" : "default"}
            size="sm"
            truncate
          >
            {deprecated ? t`${name} (old)` : name}
          </Text>
        </button>
        <ToggleGroup
          aria-label={t`What Grasp may do: ${name}`}
          onValueChange={(value) => {
            const [next] = value;
            if (next === "off" || next === "read" || next === "write") {
              onChoice(next);
            }
          }}
          value={[choice]}
        >
          <ToggleGroupItem value="off">
            {t({ message: "Off", context: "what a tool may do" })}
          </ToggleGroupItem>
          {/* Read only where Composio tags the tool read-only: connect
              refuses a read for any other. */}
          {tool.readOnly ? (
            <ToggleGroupItem value="read">
              {t({ message: "Read", context: "what a tool may do" })}
            </ToggleGroupItem>
          ) : null}
          <ToggleGroupItem value="write">
            {t({ message: "Write", context: "what a tool may do" })}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {open ? (
        <div {...stylex.props(styles.about)}>
          <Text color="muted" size="xs">
            {tool.description ?? t`No description.`}
          </Text>
        </div>
      ) : null}
    </li>
  );
};

/** Every action in one list, found by typing. */
export const ActionList = ({
  sorted,
  allowed,
  onAllowed,
}: {
  sorted: readonly SortedTool[];
  allowed: readonly AllowedTool[];
  onAllowed: (next: AllowedTool[]) => void;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const typed = query.trim().toLowerCase();
  const shown = sorted.filter(
    (entry) => typed === "" || entry.name.toLowerCase().includes(typed)
  );
  const titles: Readonly<Record<ToolKind, string>> = {
    look: t({ message: "View", context: "kind of tool" }),
    change: t({ message: "Change", context: "kind of tool" }),
    remove: t({ message: "Delete", context: "kind of tool" }),
  };
  return (
    <div {...stylex.props(styles.stack)}>
      <InputGroup size="sm">
        <InputGroupAddon>
          <Icon icon={SearchIcon} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t`Search actions`}
          onValueChange={setQuery}
          placeholder={t`Search actions`}
          type="search"
          value={query}
        />
      </InputGroup>
      {shown.length === 0 ? (
        <Text color="muted" size="xs">
          {t`No action matches.`}
        </Text>
      ) : null}
      {toolKinds.map((kind) => {
        const ofThis = shown.filter((entry) => entry.kind === kind);
        if (ofThis.length === 0) {
          return null;
        }
        return (
          <section aria-label={titles[kind]} key={kind}>
            <div {...stylex.props(styles.kind)}>
              <KindDot kind={kind} />
              <Text as="span" size="xs" weight="medium">
                {titles[kind]}
              </Text>
              <Text as="span" color="subtle" size="xs">
                {t`${countOn(allowed, ofThis)} of ${ofThis.length} on`}
              </Text>
            </div>
            <ul {...stylex.props(styles.list)}>
              {ofThis.map((entry) => (
                <Row
                  choice={choiceOf(allowed, entry.tool.name)}
                  entry={entry}
                  key={entry.tool.name}
                  onChoice={(choice) => {
                    onAllowed(withChoice(allowed, entry.tool.name, choice));
                  }}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};
