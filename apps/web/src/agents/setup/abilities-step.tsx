import { Badge } from "@grasp-os/ui/components/badge";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Switch } from "@grasp-os/ui/components/switch";
import { EyeIcon, PencilIcon, SendIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import { SettingsCard } from "../settings-card.tsx";
import { toggled } from "./model.ts";
import type { Ability, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// What it may do in the person's apps (Ruben: switches, not checkboxes):
// read, write, message others, the kinds of work core keeps for an agent
// (setup/model.ts). A card as settings are, an ability a row: its mark,
// its name and one plain line, its switch on the end edge. Writing and
// messaging carry the attention badge: they ask first, every time. What
// it does on its own (the web, workflows, Apps) is asked once core keeps it.

/** The groups, and the abilities in each. */
const groups: readonly { key: string; abilities: readonly Ability[] }[] = [
  { key: "apps", abilities: ["read", "change", "reach"] },
];

/** Each ability's mark. */
const marks: Record<Ability, IconData> = {
  read: EyeIcon,
  change: PencilIcon,
  reach: SendIcon,
};

/** The abilities that wait for a person's yes each time. */
const asksFirst: ReadonlySet<Ability> = new Set(["change", "reach"]);

const styles = stylex.create({
  groups: { display: "grid", gap: space["5"] },
});

export const AbilitiesStep = ({ setup, change, name }: StepProps) => {
  const { t } = useLingui();
  const { abilityNames } = useSetupWords();
  const groupNames: Record<string, string> = {
    apps: t`In your apps`,
  };
  return (
    <Question
      line={t`Pick what it may do. You can change this later.`}
      title={t`What can ${name} do?`}
    >
      <div {...stylex.props(styles.groups)}>
        {groups.map((group) => (
          <SettingsCard key={group.key} title={groupNames[group.key] ?? ""}>
            <ItemGroup>
              {group.abilities.map((ability, index) => {
                const { label, info } = abilityNames[ability];
                const on = setup.abilities.has(ability);
                return (
                  <Fragment key={ability}>
                    {index === 0 ? null : <ItemSeparator />}
                    <Item size="sm">
                      <ItemMedia>
                        <IconTile
                          icon={marks[ability]}
                          size="sm"
                          variant={on ? "tinted" : "default"}
                        />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{label}</ItemTitle>
                        {asksFirst.has(ability) ? (
                          <span>
                            <Badge size="sm" variant="warning">
                              {t`Asks you first`}
                            </Badge>
                          </span>
                        ) : (
                          <ItemDescription>{info}</ItemDescription>
                        )}
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={label}
                          checked={on}
                          onCheckedChange={(next) => {
                            change({
                              abilities: toggled(
                                setup.abilities,
                                ability,
                                next
                              ),
                            });
                          }}
                        />
                      </ItemActions>
                    </Item>
                  </Fragment>
                );
              })}
            </ItemGroup>
          </SettingsCard>
        ))}
      </div>
    </Question>
  );
};
