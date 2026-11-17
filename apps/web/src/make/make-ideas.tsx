import type { Blueprint } from "@grasp-os/shared/apps";
import { useLingui } from "@lingui/react/macro";

import { AppWindow, Workflow } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { processNames } from "../workflows/business-process.tsx";
import type { MakeExample } from "./examples.ts";

// What Chat's own page offers to start from on Make something (`?make=`),
// under the box: for an App, the organization's blueprints
// (`apps.blueprints.list`); for a workflow, which has none, a starting
// sentence for each of a few business processes (examples.ts). Picking
// one only fills the box with a sentence that names it, for the person to
// change and send: nothing is made, and Grasp's agent still proposes a
// plan first.

/** One idea: a few words to pick it by, a line under them, and what it fills the box with. */
interface Idea {
  key: string;
  title: string;
  description: string;
  fill: string;
}

/**
 * The ideas, each a tile that fills the box (`onPick`), marked with the
 * icon of what it makes (`icon`).
 */
const Ideas = ({
  ideas,
  icon,
  onPick,
}: {
  ideas: readonly Idea[];
  icon: IconData;
  onPick: (text: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <ItemGroup aria-label={t`Ideas to start from`}>
      {ideas.map(({ key, title, description, fill }) => (
        <Item
          key={key}
          render={
            <button
              aria-label={title}
              onClick={() => {
                onPick(fill);
              }}
              type="button"
            />
          }
          size="sm"
          variant="outline"
        >
          <ItemMedia icon={icon} />
          <ItemContent>
            <ItemTitle>{title}</ItemTitle>
            <ItemDescription>{description}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};

/** The blueprints to start an App from, each filling the box with a sentence naming it. */
export const BlueprintIdeas = ({
  blueprints,
  onPick,
}: {
  blueprints: readonly Blueprint[];
  onPick: (text: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <Ideas
      ideas={blueprints.map(({ id, name, description }) => ({
        key: id,
        title: name,
        description,
        fill:
          description === ""
            ? t`Make an App from the ${name} blueprint.`
            : t`Make an App from the ${name} blueprint: ${description}`,
      }))}
      icon={AppWindow}
      onPick={onPick}
    />
  );
};

/** A starting sentence for a workflow, for each of a few business processes. */
export const WorkflowIdeas = ({
  examples,
  onPick,
}: {
  examples: readonly MakeExample[];
  onPick: (text: string) => void;
}) => {
  const { i18n } = useLingui();
  return (
    <Ideas
      ideas={examples.map(({ process, title, idea }) => ({
        key: process,
        title: i18n._(title),
        description: i18n._(processNames[process]),
        fill: i18n._(idea),
      }))}
      icon={Workflow}
      onPick={onPick}
    />
  );
};
