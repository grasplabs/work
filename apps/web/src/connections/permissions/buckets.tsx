// Concept B, three bins by risk: what only looks, what creates or changes,
// what deletes or cancels, each a card with one switch for all of it and
// how many are on. Viewing starts on, the rest off. A card opens to its
// actions, each a box, for the admin who wants to pick within a bin.
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import { colors, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { AllowedTool } from "../tool-choices.ts";
import {
  choiceOf,
  countOn,
  ofKind,
  toolKinds,
  withAll,
  ticked,
  withChoice,
} from "./model.ts";
import type { SortedTool, ToolKind } from "./model.ts";
import { KindMark, useKindWords } from "./parts.tsx";

const styles = stylex.create({
  stack: { display: "grid", gap: space[3] },
  card: {
    display: "grid",
    gap: space[3],
    padding: space[4],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
  },
  off: { backgroundColor: "transparent" },
  head: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space[3],
  },
  words: { display: "grid", gap: space[1] },
  side: { display: "flex", alignItems: "center", gap: space[3] },
  rows: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(13rem, 1fr))",
    columnGap: space[4],
    rowGap: space[2],
    margin: 0,
    paddingTop: space[2],
    paddingInline: 0,
    listStyle: "none",
  },
  row: { display: "flex", alignItems: "center", gap: space[2], minWidth: 0 },
});

/** One bin: its switch for all, its count, and its actions when opened. */
const Bin = ({
  kind,
  tools,
  allowed,
  onAllowed,
}: {
  kind: ToolKind;
  tools: readonly SortedTool[];
  allowed: readonly AllowedTool[];
  onAllowed: (next: AllowedTool[]) => void;
}) => {
  const { t } = useLingui();
  const words = useKindWords()[kind];
  const on = countOn(allowed, tools);
  return (
    <section {...stylex.props(styles.card, on === 0 && styles.off)}>
      <div {...stylex.props(styles.head)}>
        <KindMark kind={kind} />
        <div {...stylex.props(styles.words)}>
          <Text color="default" size="default" weight="medium">
            {words.title}
          </Text>
          <Text color="muted" size="sm">
            {words.note}
          </Text>
        </div>
        <div {...stylex.props(styles.side)}>
          <Text as="span" color="subtle" size="xs">
            {t`${on} of ${tools.length}`}
          </Text>
          <Switch
            aria-label={t`All of ${words.title}`}
            checked={on > 0}
            onCheckedChange={(checked) => {
              onAllowed(withAll(allowed, tools, checked));
            }}
          />
        </div>
      </div>
      <Collapsible fitContent variant="plain">
        <CollapsibleTrigger size="sm" weight="normal">
          {t`Choose per action`}
        </CollapsibleTrigger>
        <CollapsibleContent asChild>
          <ul {...stylex.props(styles.rows)}>
            {tools.map(({ tool, name, deprecated }) => (
              <li key={tool.name} {...stylex.props(styles.row)}>
                <Checkbox
                  aria-label={name}
                  checked={choiceOf(allowed, tool.name) !== "off"}
                  onCheckedChange={(checked) => {
                    onAllowed(
                      withChoice(
                        allowed,
                        tool.name,
                        ticked(tool, checked === true)
                      )
                    );
                  }}
                />
                <Text as="span" color="secondary" size="sm" truncate>
                  {deprecated ? t`${name} (old)` : name}
                </Text>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
};

/** Concept B: the tools in three bins by risk. */
export const Buckets = ({
  sorted,
  allowed,
  onAllowed,
}: {
  sorted: readonly SortedTool[];
  allowed: readonly AllowedTool[];
  onAllowed: (next: AllowedTool[]) => void;
}) => (
  <div {...stylex.props(styles.stack)}>
    {toolKinds.map((kind) => {
      const tools = ofKind(sorted, kind);
      return tools.length === 0 ? null : (
        <Bin
          allowed={allowed}
          key={kind}
          kind={kind}
          onAllowed={onAllowed}
          tools={tools}
        />
      );
    })}
  </div>
);
