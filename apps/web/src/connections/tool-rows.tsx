import type { CatalogTool } from "@grasp-os/shared/connect";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { RowList, RowListItem } from "../grasp/row-list/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// One group of an app's tools (what only reads, or what creates and
// changes), as rows of Grasp UI's Row list: each a few plain words, not the
// action's name a call takes, and only the first few until someone asks
// for all of them. An app such as Gmail has some sixty: a wall of them
// says less than six and "Show all 60".

const styles = stylex.create({
  more: { justifySelf: "start", marginBlockStart: grasp.space1 },
  group: { display: "grid" },
});

/** How many of a group's tools show before "Show all". */
const first = 5;

/**
 * A tool's action name in plain words: `GMAIL_SEND_EMAIL` reads "Send
 * email", `mail.list` reads "Mail list". The provider's own words, so not
 * translated.
 */
export const toolWords = (name: string, app: string): string => {
  const prefix = `${app.replaceAll(/[^a-z0-9]/giu, "").toUpperCase()}_`;
  const bare = name.toUpperCase().startsWith(prefix)
    ? name.slice(prefix.length)
    : name;
  const words = bare
    .replaceAll(/[._-]+/gu, " ")
    .replaceAll(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .trim()
    .toLowerCase();
  return words === ""
    ? name
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** One group's tools, the first few, with the rest a press away. */
export const ToolRows = ({
  tools,
  slug,
  allowed,
  label,
}: {
  tools: readonly CatalogTool[];
  /** The app's id in the catalog, which a Composio tool's name starts with. */
  slug: string;
  /** The tools a connection allows; every tool where there is none to go by. */
  allowed: ReadonlySet<string> | undefined;
  /** What the group is, for a screen reader. */
  label: string;
}) => {
  const { t } = useLingui();
  const [all, setAll] = useState(false);
  const shown = all ? tools : tools.slice(0, first);
  const count = tools.length;
  return (
    <div {...stylex.props(styles.group)}>
      <RowList aria-label={label}>
        {shown.map((tool) => (
          <RowListItem
            detail={
              allowed === undefined || allowed.has(tool.name) ? undefined : (
                <Badge>{t`Not allowed`}</Badge>
              )
            }
            key={tool.name}
            name={toolWords(tool.name, slug)}
          />
        ))}
      </RowList>
      {count > first ? (
        <Button
          layout={styles.more}
          onClick={() => {
            setAll((was) => !was);
          }}
          size="sm"
          variant="ghost"
        >
          {all
            ? t`Show fewer`
            : t`${plural(count, { one: "Show the # tool", other: "Show all # tools" })}`}
        </Button>
      ) : null}
    </div>
  );
};
