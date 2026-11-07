import type {
  DataModelRule,
  DataModelTable,
} from "@grasp-os/shared/data-model";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
} from "@grasp-os/ui/components/item";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Trans, useLingui } from "@lingui/react/macro";
import { UserIcon } from "lucide-react";
import { useId, useState } from "react";

import { formatList } from "../format.ts";
import {
  accessAfter,
  changing,
  choiceKey,
  choiceOf,
  choicesFor,
  seeing,
} from "./access-choices.ts";
import type { AccessChoice, Answer } from "./access-choices.ts";
import type { ModelOperation } from "./data-model-changes.tsx";

// A table's access in an App's Data view, as two questions with one
// answer each, who can see its records and who can change them, each
// answer said as what it means for one person, Sam; and whether every
// look at its records is recorded. Answers map exactly onto the
// definition's access (access-choices.ts), saved with `setAccess`, which
// is reviewed before it's made.

/** An answer, in a few words. */
const useChoiceLabel = () => {
  const { t } = useLingui();
  return (choice: AccessChoice): string => {
    switch (choice.kind) {
      case "everyone": {
        return t`Everyone who uses the App`;
      }
      case "added": {
        return t`Only the person who added the record`;
      }
      case "person": {
        const { field } = choice;
        return t`The person in ${field}`;
      }
      case "team": {
        const { field } = choice;
        return t`The team in ${field}`;
      }
      case "builders": {
        return t`Only the App's builders`;
      }
      case "nobody": {
        return t`Nobody`;
      }
      case "code": {
        return t`As the App's code sets it`;
      }
      default: {
        return "";
      }
    }
  };
};

/** Who a rule reaches, in a few words. */
const useRuleWords = () => {
  const { t } = useLingui();
  return (rule: DataModelRule): string => {
    switch (rule.kind) {
      case "owner": {
        return t`the person who added it`;
      }
      case "person": {
        const { field } = rule;
        return t`the person in ${field}`;
      }
      case "team": {
        const { field } = rule;
        return t`the team in ${field}`;
      }
      case "role": {
        return rule.role === "builder"
          ? t`the App's builders`
          : t`everyone who uses the App`;
      }
      default: {
        return "";
      }
    }
  };
};

/** What an answer means for one person, Sam, seeing records of `table`. */
const useSeeSentence = () => {
  const { t } = useLingui();
  const ruleWords = useRuleWords();
  return (choice: AccessChoice, table: string, rules: DataModelRule[]) => {
    switch (choice.kind) {
      case "everyone": {
        return t`Sam, like everyone who uses the App, sees every record in ${table}.`;
      }
      case "added": {
        return t`Sam sees only the records in ${table} that Sam added.`;
      }
      case "person": {
        const { field } = choice;
        return t`Sam sees only the records in ${table} whose ${field} is Sam.`;
      }
      case "team": {
        const { field } = choice;
        return t`Sam sees only the records in ${table} whose ${field} is one of Sam's teams.`;
      }
      case "builders": {
        return t`Sam sees the records in ${table} only as one of the App's builders.`;
      }
      case "nobody": {
        return t`Nobody sees the records in ${table}, Sam included.`;
      }
      case "code": {
        const who = formatList(rules.map(ruleWords));
        return t`Sam sees a record in ${table} as one of these: ${who}.`;
      }
      default: {
        return "";
      }
    }
  };
};

/** What an answer means for one person, Sam, changing records of `table`. */
const useChangeSentence = () => {
  const { t } = useLingui();
  const ruleWords = useRuleWords();
  return (choice: AccessChoice, table: string, rules: DataModelRule[]) => {
    switch (choice.kind) {
      case "everyone": {
        return t`Sam, like everyone who uses the App, can change any record in ${table} Sam sees.`;
      }
      case "added": {
        return t`Sam can change only the records in ${table} that Sam added.`;
      }
      case "person": {
        const { field } = choice;
        return t`Sam can change only the records in ${table} whose ${field} is Sam.`;
      }
      case "team": {
        const { field } = choice;
        return t`Sam can change only the records in ${table} whose ${field} is one of Sam's teams.`;
      }
      case "builders": {
        return t`Sam can change the records in ${table} only as one of the App's builders.`;
      }
      case "nobody": {
        return t`Nobody changes the records in ${table}, Sam included.`;
      }
      case "code": {
        const who = formatList(rules.map(ruleWords));
        return t`Sam can change a record in ${table} as one of these: ${who}.`;
      }
      default: {
        return "";
      }
    }
  };
};

/** One question: its answers to pick one of, and what the one picked means. */
const Question = ({
  legend,
  answers,
  picked,
  sentence,
  disabled,
  onPick,
}: {
  legend: string;
  answers: Answer[];
  picked: AccessChoice;
  sentence: string;
  disabled: boolean;
  onPick: (answer: Answer) => void;
}) => {
  const ids = useId();
  const label = useChoiceLabel();
  const shown: AccessChoice[] =
    picked.kind === "code" ? [...answers, picked] : answers;
  return (
    <FieldSet>
      <FieldLegend>{legend}</FieldLegend>
      <RadioGroup
        disabled={disabled}
        onValueChange={(next: unknown) => {
          const answer = answers.find((each) => choiceKey(each) === next);
          if (answer !== undefined) {
            onPick(answer);
          }
        }}
        value={choiceKey(picked)}
      >
        {shown.map((choice) => {
          const key = choiceKey(choice);
          return (
            <Field key={key} orientation="horizontal">
              <RadioGroupItem
                disabled={choice.kind === "code"}
                id={`${ids}-${key}`}
                value={key}
              />
              <FieldLabel htmlFor={`${ids}-${key}`}>{label(choice)}</FieldLabel>
            </Field>
          );
        })}
      </RadioGroup>
      <Item size="sm" variant="muted">
        <ItemMedia variant="icon">
          <UserIcon />
        </ItemMedia>
        <ItemContent>
          <ItemDescription>{sentence}</ItemDescription>
        </ItemContent>
      </Item>
    </FieldSet>
  );
};

/** Who can see and change a table's records, and whether every look is recorded. */
export const AccessView = ({
  table,
  disabled,
  onChange,
}: {
  table: DataModelTable;
  disabled: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const seeSentence = useSeeSentence();
  const changeSentence = useChangeSentence();
  const [read, setRead] = useState<Answer>();
  const [write, setWrite] = useState<Answer>();
  const [sensitive, setSensitive] = useState(table.sensitive);
  const answers = choicesFor(table);
  const { name } = table;
  const access = accessAfter(table, {
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
  });
  // Shown as saved would read it: an answer for who sees can change what
  // changes follow.
  const after: DataModelTable = {
    ...table,
    access: {
      read: access.read,
      write: access.write,
      rows: { read: access.rows?.read ?? [], write: access.rows?.write ?? [] },
    },
  };
  const seen = seeing(after);
  const changed = changing(after);
  const dirty =
    read !== undefined || write !== undefined || sensitive !== table.sensitive;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form
        aria-label={t`Access to ${name}`}
        className="flex max-w-2xl flex-col gap-8 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void onChange({
            op: "setAccess",
            table: name,
            access,
            ...(sensitive ? { sensitive: true } : {}),
          });
        }}
      >
        <Question
          answers={answers}
          disabled={disabled}
          legend={t`Who can see records in ${name}?`}
          onPick={setRead}
          picked={choiceOf(seen)}
          sentence={seeSentence(choiceOf(seen), name, seen.rules)}
        />
        <Question
          answers={answers}
          disabled={disabled}
          legend={t`Who can change them?`}
          onPick={setWrite}
          picked={choiceOf(changed)}
          sentence={changeSentence(choiceOf(changed), name, changed.rules)}
        />
        <Field orientation="horizontal">
          <Checkbox
            checked={sensitive}
            // A table stays sensitive once it is: its history kept no values.
            disabled={disabled || table.sensitive}
            id={`${ids}-sensitive`}
            onCheckedChange={setSensitive}
          />
          <FieldLabel htmlFor={`${ids}-sensitive`}>
            <Trans>
              Record every time someone looks at these records, and keep no past
              values
            </Trans>
          </FieldLabel>
        </Field>
        <div>
          <Button disabled={disabled || !dirty} type="submit">
            <Trans>Save access</Trans>
          </Button>
        </div>
      </form>
    </div>
  );
};
