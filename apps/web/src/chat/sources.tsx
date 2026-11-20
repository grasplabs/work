import type { ChatProvenance } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Badge } from "../grasp/badge/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Cable, Icon } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// What the chat's answers may hold, on Grasp UI's parts: the sources core
// says the chat read from, each by its name where the page knows it (a
// connection), else by its ID. Only what core reports: the page never
// guesses a source.

/** A source the chat read, as the page names it. */
export interface SourceName {
  name: string;
}

const styles = stylex.create({
  // What the chat read, under its last answer, before the box.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: grasp.space2,
  },
  list: {
    display: "grid",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
  },
});

/**
 * What the chat's answers drew on, as core says: whether the chat's agent
 * was restricted, and the sources it read, folded.
 */
export const ChatSources = ({
  provenance,
  names,
  sourcesShown = true,
}: {
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
  /** Whether the fold of sources shows: not where something nearer says it, or wants the eye. */
  sourcesShown?: boolean;
}) => {
  const { t } = useLingui();
  const { restricted } = provenance;
  const sources = sourcesShown ? provenance.sources : [];
  const count = sources.length;
  if (count === 0 && !restricted) {
    return null;
  }
  return (
    <div {...stylex.props(styles.row)}>
      {restricted ? <Badge tone="attention">{t`Restricted`}</Badge> : null}
      {count === 0 ? null : (
        <Collapsible
          fit
          title={t`${plural(count, { one: "Answers draw on # source", other: "Answers draw on # sources" })}`}
        >
          <ul {...stylex.props(styles.list)}>
            {sources.map((id) => {
              const name = names.get(id)?.name ?? id;
              return (
                <li key={id} {...stylex.props(styles.item)}>
                  <Icon icon={Cable} />
                  <Text size="sm">{name}</Text>
                </li>
              );
            })}
          </ul>
        </Collapsible>
      )}
    </div>
  );
};
