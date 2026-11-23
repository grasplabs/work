import { agentJobMax } from "@grasp-os/shared/agents";
import { Field } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { templatesFor } from "../agent-templates.ts";
import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// What it should do: the starting points that suit its name, as the
// Damsko's items in a grid, each its mark, its name and when it works
// with what it hands over (Ruben, 21 November: the cards were loud, their
// type drifted from the page's), a press takes one and goes on; or the
// person's own line.

/** How many starting points it shows: the ones the name suits best. */
const cardsShown = 4;

export const JobStep = ({ setup, change, name, pick }: StepProps) => {
  const { t, i18n } = useLingui();
  return (
    <Question
      line={t`Pick one, or write it in one line.`}
      title={t`What should ${name} do?`}
    >
      <ItemGrid aria-label={t`Starting points`}>
        {templatesFor(name)
          .slice(0, cardsShown)
          .map((template) => (
            <Item
              key={template.key}
              onClick={() => {
                pick(template);
              }}
              variant="outline"
            >
              <ItemMedia variant="icon">
                <Icon icon={template.icon} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{i18n._(template.label)}</ItemTitle>
                <ItemDescription>
                  {`${i18n._(template.cadence)} → ${i18n._(template.outcome)}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
      </ItemGrid>
      <Field>
        <Input
          aria-label={t`What it is for`}
          autoComplete="off"
          autoFocus
          maxLength={agentJobMax}
          onValueChange={(value) => {
            change({ job: value, template: undefined });
          }}
          placeholder={t`Or write it yourself`}
          size="lg"
          value={setup.job}
        />
      </Field>
    </Question>
  );
};
