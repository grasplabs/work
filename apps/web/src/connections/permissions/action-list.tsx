// Every action of an app in a compact row, found by typing, narrowed by
// kind, each with Off, Read or Write on one control. A row's name opens its
// provider's own description, which stays in its words. "Turn these off"
// works on what the list shows, so a search for "delete" and one press take
// every delete away.
import { Button } from "@grasp-os/ui/components/button";
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
import { Icon, SearchIcon, TriangleAlertIcon } from "@grasp-os/ui/lib/icons";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { AllowedTool } from "../tool-choices.ts";
import { choiceOf, countOn, withAll, withChoice } from "./model.ts";
import type { Choice, SortedTool, ToolKind } from "./model.ts";
import { KindDot } from "./parts.tsx";

const styles = stylex.create({
  stack: { display: "grid", gap: space[2] },
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
  },
  search: { flexBasis: "12rem", flexGrow: 1, minWidth: 0 },
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
  warn: {
    display: "flex",
    alignItems: "center",
    gap: space[1],
    color: colors.warning,
    [iconVars.size]: size.iconSm,
  },
});

type Filter = "all" | ToolKind | "on";

const filterValues: ReadonlySet<string> = new Set([
  "all",
  "look",
  "change",
  "remove",
  "on",
]);

const isFilter = (value: unknown): value is Filter =>
  typeof value === "string" && filterValues.has(value);

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
  const { tool, name, kind, deprecated } = entry;
  // Marked Read against its provider's word: it would change things without asking.
  const readAgainstHint = choice === "read" && !tool.readOnly;
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
          <KindDot kind={kind} />
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
          <ToggleGroupItem value="read">
            {t({ message: "Read", context: "what a tool may do" })}
          </ToggleGroupItem>
          <ToggleGroupItem value="write">
            {t({ message: "Write", context: "what a tool may do" })}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {readAgainstHint ? (
        <span {...stylex.props(styles.warn, styles.about)}>
          <Icon icon={TriangleAlertIcon} />
          <Text as="span" color="secondary" size="xs">
            {t`Composio says this changes things. As Read, it would do so without asking.`}
          </Text>
        </span>
      ) : null}
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
  const [filter, setFilter] = useState<Filter>("all");
  const typed = query.trim().toLowerCase();
  const shown = sorted.filter(
    (entry) =>
      (typed === "" || entry.name.toLowerCase().includes(typed)) &&
      (filter === "all" ||
        (filter === "on"
          ? choiceOf(allowed, entry.tool.name) !== "off"
          : entry.kind === filter))
  );
  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: t`All` },
    { value: "look", label: t({ message: "View", context: "kind of tool" }) },
    {
      value: "change",
      label: t({ message: "Change", context: "kind of tool" }),
    },
    {
      value: "remove",
      label: t({ message: "Delete", context: "kind of tool" }),
    },
    { value: "on", label: t`On ${countOn(allowed, sorted)}` },
  ];
  return (
    <div {...stylex.props(styles.stack)}>
      <div {...stylex.props(styles.tools)}>
        <InputGroup size="sm" style={styles.search}>
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
        <Button
          disabled={countOn(allowed, shown) === 0}
          onClick={() => {
            onAllowed(withAll(allowed, shown, false));
          }}
          size="xs"
          variant="ghost"
        >
          {t`Turn these off`}
        </Button>
      </div>
      <ToggleGroup
        aria-label={t`Show`}
        onValueChange={(value) => {
          const [next] = value;
          if (isFilter(next)) {
            setFilter(next);
          }
        }}
        value={[filter]}
      >
        {filters.map(({ value, label }) => (
          <ToggleGroupItem key={value} value={value}>
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {shown.length === 0 ? (
        <Text color="muted" size="xs">
          {t`No action matches.`}
        </Text>
      ) : (
        <ul aria-label={t`Actions`} {...stylex.props(styles.list)}>
          {shown.map((entry) => (
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
      )}
    </div>
  );
};
