import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import { Icon, MessageCircleIcon, TableIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// A Brain page's properties, one quiet press away, as the prototype's
// page D has them: Grasp's facts about the note, then the questions it
// still waits on, each with who can answer, their count on the press.
// Damsko's Collapsible opens them; its key and value rows hold them.

/** One of the page's facts: read only, a short name, its value and, if it helps, an icon. */
export interface PageFact {
  key: string;
  value: ReactNode;
  icon?: IconData;
}

/** A question the page cannot answer yet, and the person (a role) who can. */
export interface PageOpenQuestion {
  id: string;
  question: string;
  who: string;
}

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    color: colors.mutedForeground,
  },
  count: { color: colors.foreground },
  body: { paddingBlockStart: space["2"] },
});

export const PageProperties = ({
  facts,
  questions,
}: {
  facts: readonly PageFact[];
  /** Waiting for an answer: each a row of its own after the facts, and their count on the press. */
  questions: readonly PageOpenQuestion[];
}) => {
  const { t } = useLingui();
  const open = questions.length;
  const items: KeyValueItem[] = [
    ...facts.map((fact) => ({
      id: fact.key,
      label: fact.key,
      value: fact.value,
      ...(fact.icon === undefined ? {} : { icon: fact.icon }),
    })),
    ...questions.map(({ id, question, who }) => ({
      id,
      label: question,
      value: t`Not answered yet · ${who}`,
      icon: MessageCircleIcon,
    })),
  ];
  return (
    <Collapsible fitContent>
      <CollapsibleTrigger>
        <span {...stylex.props(styles.trigger)}>
          <Icon icon={TableIcon} />
          {t`Properties`}
          {open > 0 ? (
            <span {...stylex.props(styles.count)}>
              {` · ${plural(open, { one: "# open", other: "# open" })}`}
            </span>
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div {...stylex.props(styles.body)}>
          <KeyValueList
            items={items}
            orientation="horizontal"
            valueAlign="start"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
