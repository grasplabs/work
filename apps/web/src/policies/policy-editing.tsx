import {
  policyTextMax,
  ruleConditionSchema,
  ruleEffectSchema,
  ruleStatusSchema,
} from "@grasp-os/shared/policies";
import type {
  RuleEdit,
  RuleEffect,
  RuleInput,
  RuleStatus,
} from "@grasp-os/shared/policies";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  FileUpIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDay } from "../format.ts";
import { PageHeading, SectionTitle } from "../frame/page.tsx";
import { exposureMeta } from "../landscape/landscape.ts";
import type { LandscapeApp } from "../landscape/landscape.ts";
import { useCoreAction } from "../use-core-action.ts";
import { policyToday } from "./policies-data.ts";
import {
  accessLabel,
  aiKindLabel,
  certificateLabel,
  dpaLabel,
  effectDescription,
  effectLabel,
  extensionLabel,
  regionLabel,
  ruleStatusDescription,
  ruleStatusLabel,
  trainingLabel,
} from "./policy.ts";
import type {
  PolicyDocument,
  PolicyException,
  PolicyRule,
  RuleCondition,
  RuleField,
} from "./policy.ts";

// The policy pages as an admin changes them: uploading a policy and
// publishing or removing it, making a rule by hand or from a policy's
// passage and editing or deleting it, and letting one app break one rule
// until a day. Each is core's own call (`session.policies`), which takes it
// from the organization's own admins alone and audits it; the page is read
// again after it. Everyone else sees the pages as they are, with none of
// this.

/** Whether `identity` may change the policies: the organization's own admins, never Grasp staff. */
export const editsPolicies = (identity: Pick<Identity, "role" | "staff">) =>
  isMemberAdmin(identity);

/* ── Conditions ──────────────────────────────────────────────────────── */

/** Each kind of condition, by the fact it checks, in the order offered. */
const fieldLabel: Record<RuleField, MessageDescriptor> = {
  hosting: msg({ message: "Where it's hosted", context: "rule condition" }),
  vendor: msg({ message: "Vendor", context: "rule condition" }),
  ai: msg({ message: "Kind of AI", context: "rule condition" }),
  training: msg({
    message: "Training on your data",
    context: "rule condition",
  }),
  data: msg({ message: "Data it touches", context: "rule condition" }),
  people: msg({ message: "People using it", context: "rule condition" }),
  owner: msg({ message: "Nobody owns it", context: "rule condition" }),
  certificate: msg({
    message: "Vendor certificates",
    context: "rule condition",
  }),
  dpa: msg({ message: "Processing agreement", context: "rule condition" }),
  access: msg({ message: "Access to company data", context: "rule condition" }),
  extension: msg({ message: "Browser extension", context: "rule condition" }),
};

const fields: readonly RuleField[] = [
  "hosting",
  "vendor",
  "ai",
  "training",
  "data",
  "people",
  "owner",
  "certificate",
  "dpa",
  "access",
  "extension",
];

/**
 * A condition as the dialog edits it, loose so a row can be half done:
 * core's schema (`ruleConditionSchema`) says whether it is one, as it
 * would when the rule is saved.
 */
export interface DraftCondition {
  /** Who it is while the rule is written, whatever is added or removed around it. */
  key: string;
  field: RuleField;
  op?: string;
  values: string[];
  /** The vendors as typed, commas and all; `values` is what they name. */
  typed?: string;
  moreThan: number;
}

/** The ways a condition with a choice of how it reads can read; the first is its start. */
const opsOf: Partial<
  Record<RuleField, { value: string; label: MessageDescriptor }[]>
> = {
  hosting: [
    { value: "outside", label: msg`Hosted outside all of` },
    { value: "in", label: msg`Hosted in one of` },
  ],
  vendor: [
    { value: "is", label: msg`Made by one of` },
    { value: "isNot", label: msg`Made by none of` },
  ],
  certificate: [
    { value: "lacksAny", label: msg`Lacks any of` },
    { value: "lacksAll", label: msg`Lacks all of` },
  ],
};

/** A condition of `field` as it starts: nothing picked yet. */
export const freshCondition = (field: RuleField): DraftCondition => ({
  key: crypto.randomUUID(),
  field,
  op: opsOf[field]?.[0]?.value,
  values: [],
  moreThan: 50,
});

/** What a row says, in the shape core's schema reads. */
const candidateOf = ({ field, op, values, moreThan }: DraftCondition) => {
  if (field === "people") {
    return { field, moreThan };
  }
  if (field === "owner") {
    return { field };
  }
  return { field, ...(op === undefined ? {} : { op }), values };
};

/** The condition core takes from a row, or none while it isn't one yet. */
export const conditionOf = (
  draft: DraftCondition
): RuleCondition | undefined => {
  const parsed = ruleConditionSchema.safeParse(candidateOf(draft));
  return parsed.success ? parsed.data : undefined;
};

/** A rule's condition as a row. */
const draftConditionOf = (condition: RuleCondition): DraftCondition => ({
  key: crypto.randomUUID(),
  field: condition.field,
  op: "op" in condition ? condition.op : undefined,
  values: "values" in condition ? [...condition.values] : [],
  moreThan: "moreThan" in condition ? condition.moreThan : 50,
});

const labelsOf = (labels: Record<string, MessageDescriptor>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

/** The values a listing condition picks from, each with its words. */
const choicesOf: Partial<
  Record<RuleField, { value: string; label: MessageDescriptor }[]>
> = {
  hosting: labelsOf(regionLabel),
  ai: labelsOf(aiKindLabel),
  training: labelsOf(trainingLabel),
  data: Object.entries(exposureMeta).map(([value, { label }]) => ({
    value,
    label,
  })),
  certificate: labelsOf(certificateLabel),
  dpa: labelsOf(dpaLabel),
  access: labelsOf(accessLabel),
  extension: labelsOf(extensionLabel),
};

/** Vendors as typed, one per comma: trimmed, none empty. */
const vendorsOf = (typed: string): string[] =>
  typed
    .split(",")
    .map((vendor) => vendor.trim())
    .filter((vendor) => vendor !== "");

/** One condition, as the prototype's card: what it checks, and the values it checks for. */
const ConditionCard = ({
  condition,
  disabled,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  disabled: boolean;
  onChange: (condition: DraftCondition) => void;
  onRemove: () => void;
}) => {
  const { t, i18n } = useLingui();
  const ids = useId();
  const field = i18n._(fieldLabel[condition.field]);
  const ops = opsOf[condition.field] ?? [];
  const choices = choicesOf[condition.field] ?? [];
  return (
    <Item size="sm" variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle id={`${ids}-field`}>{field}</ItemTitle>
        {ops.length === 0 ? null : (
          <NativeSelect
            aria-label={t`How ${field} reads`}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...condition, op: event.target.value });
            }}
            size="sm"
            value={condition.op}
          >
            {ops.map((op) => (
              <NativeSelectOption key={op.value} value={op.value}>
                {i18n._(op.label)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {condition.field === "vendor" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-vendors`}>
              <Trans>Vendors, separated by commas</Trans>
            </FieldLabel>
            <Input
              disabled={disabled}
              id={`${ids}-vendors`}
              onChange={(event) => {
                onChange({
                  ...condition,
                  typed: event.target.value,
                  values: vendorsOf(event.target.value),
                });
              }}
              placeholder="OpenAI, DeepSeek"
              value={condition.typed ?? condition.values.join(", ")}
            />
          </Field>
        ) : null}
        {condition.field === "people" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-people`}>
              <Trans>Used by more than this many people</Trans>
            </FieldLabel>
            <Input
              disabled={disabled}
              id={`${ids}-people`}
              min={0}
              onChange={(event) => {
                const moreThan = Math.trunc(Number(event.target.value));
                onChange({
                  ...condition,
                  moreThan: Number.isFinite(moreThan)
                    ? Math.max(0, moreThan)
                    : 0,
                });
              }}
              type="number"
              value={condition.moreThan}
            />
          </Field>
        ) : null}
        {choices.length === 0 ? null : (
          <ToggleGroup
            aria-labelledby={`${ids}-field`}
            className="flex-wrap"
            disabled={disabled}
            multiple
            onValueChange={(values) => {
              onChange({ ...condition, values });
            }}
            size="sm"
            value={condition.values}
            variant="outline"
          >
            {choices.map((choice) => (
              <ToggleGroupItem key={choice.value} value={choice.value}>
                {i18n._(choice.label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={t`Remove ${field}`}
          disabled={disabled}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </ItemActions>
    </Item>
  );
};

/**
 * A rule's conditions, each a card, "and" between them; a new one is
 * picked by what it checks, as in the prototype's editor.
 */
export const ConditionEditor = ({
  conditions,
  disabled,
  onChange,
}: {
  conditions: readonly DraftCondition[];
  disabled: boolean;
  onChange: (conditions: DraftCondition[]) => void;
}) => {
  const { i18n } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => (
        <div className="flex flex-col gap-2" key={condition.key}>
          {index > 0 ? (
            <span className="text-muted-foreground text-xs">
              <Trans context="between two conditions of a rule: both must hold">
                and
              </Trans>
            </span>
          ) : null}
          <ConditionCard
            condition={condition}
            disabled={disabled}
            onChange={(changed) => {
              onChange(
                conditions.map((each, at) => (at === index ? changed : each))
              );
            }}
            onRemove={() => {
              onChange(conditions.filter((_each, at) => at !== index));
            }}
          />
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled || conditions.length >= 20}
          render={
            <Button
              className="self-start"
              size="sm"
              type="button"
              variant="outline"
            />
          }
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>Add a condition</Trans>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            {fields.map((field) => (
              <DropdownMenuItem
                key={field}
                onClick={() => {
                  onChange([...conditions, freshCondition(field)]);
                }}
              >
                {i18n._(fieldLabel[field])}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

/* ── Rules ───────────────────────────────────────────────────────────── */

/** A rule as the dialog edits it. */
export interface RuleDraft {
  name: string;
  description: string;
  conditions: DraftCondition[];
  effect: RuleEffect;
  status: RuleStatus;
  policyId: string | null;
  excerpt: string;
}

export const draftOf = (
  rule: PolicyRule | undefined,
  policyId: string | null
): RuleDraft =>
  rule === undefined
    ? {
        name: "",
        description: "",
        conditions: [freshCondition("data")],
        effect: "flag",
        // A new rule only shows what it would do until someone turns it on.
        status: "watching",
        policyId,
        excerpt: "",
      }
    : {
        name: rule.name,
        description: rule.description,
        conditions: rule.conditions.map(draftConditionOf),
        effect: rule.effect,
        status: rule.status,
        policyId: rule.policyId,
        excerpt: rule.excerpt ?? "",
      };

/** The rule core takes, from what the dialog holds; none while a condition isn't one yet. */
export const ruleInputOf = (draft: RuleDraft): RuleInput | undefined => {
  const excerpt = draft.excerpt.trim();
  const conditions = draft.conditions.map(conditionOf);
  if (conditions.length === 0 || conditions.includes(undefined)) {
    return undefined;
  }
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    conditions: conditions.filter((each) => each !== undefined),
    effect: draft.effect,
    status: draft.status,
    policyId: draft.policyId,
    ...(draft.policyId === null || excerpt === "" ? {} : { excerpt }),
  };
};

/**
 * An edit core takes from the dialog: the rule without its status, which
 * only the status control turns, so an edit saved from an old page never
 * turns a rule back on or off.
 */
export const ruleEditOf = (draft: RuleDraft): RuleEdit | undefined => {
  const input = ruleInputOf(draft);
  if (input === undefined) {
    return undefined;
  }
  const { status: _status, ...edit } = input;
  return edit;
};

/** Whether `draft` can be saved: a name, and every condition one core takes. */
export const canSaveRule = (draft: RuleDraft): boolean =>
  draft.name.trim() !== "" && ruleInputOf(draft) !== undefined;

/**
 * Saves a rule: makes one and opens it, or replaces `rule`; then every
 * page, the policy manager's kept one included, reads it again.
 */
const useSaveRule = (rule?: PolicyRule) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const save = async (draft: RuleDraft): Promise<boolean> => {
    if (rule !== undefined) {
      const edit = ruleEditOf(draft);
      if (edit === undefined) {
        return false;
      }
      // From the revision this page read: core refuses it once the rule
      // changed since. Read again either way, so a refusal shows the rule
      // as it is now.
      const edited = await run(
        async (session) =>
          await session.policies.updateRule(rule.id, edit, rule.revision)
      );
      await router.invalidate();
      return edited !== undefined;
    }
    const input = ruleInputOf(draft);
    if (input === undefined) {
      return false;
    }
    const saved = await run(
      async (session) => await session.policies.createRule(input)
    );
    if (saved === undefined) {
      return false;
    }
    await navigate({
      to: "/policies/rules/$ruleId",
      params: { ruleId: saved.id },
    });
    await router.invalidate();
    return true;
  };
  return { busy, failure, save };
};

/** One choice of a rule's, as the prototype's card: its name, what it means, and its radio. */
const ChoiceCard = ({
  id,
  value,
  title,
  description,
}: {
  id: string;
  value: string;
  title: string;
  description: string;
}) => (
  <FieldLabel htmlFor={id}>
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <RadioGroupItem id={id} value={value} />
    </Field>
  </FieldLabel>
);

/**
 * Writing a rule, as the prototype's form: its name and what it is for,
 * the apps it catches, what it does, for a new rule whether it starts by
 * watching, and the policy it comes from.
 */
const RuleForm = ({
  draft,
  onChange,
  policies,
  disabled,
  fresh,
}: {
  draft: RuleDraft;
  onChange: (draft: RuleDraft) => void;
  policies: readonly PolicyDocument[];
  disabled: boolean;
  /** A new rule: it also says how it starts. */
  fresh: boolean;
}) => {
  const { t, i18n } = useLingui();
  const ids = useId();
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans context="the name of a policy rule">Name</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          disabled={disabled}
          id={`${ids}-name`}
          maxLength={120}
          onChange={(event) => {
            onChange({ ...draft, name: event.target.value });
          }}
          placeholder={t`Customer data stays in the EU`}
          value={draft.name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-description`}>
          <Trans>What it&apos;s for</Trans>
        </FieldLabel>
        <Textarea
          disabled={disabled}
          id={`${ids}-description`}
          maxLength={2000}
          onChange={(event) => {
            onChange({ ...draft, description: event.target.value });
          }}
          rows={2}
          value={draft.description}
        />
      </Field>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>Apps it catches</Trans>
        </FieldLegend>
        <FieldDescription>
          <Trans>An app breaks the rule when every condition holds.</Trans>
        </FieldDescription>
        <ConditionEditor
          conditions={draft.conditions}
          disabled={disabled}
          onChange={(conditions) => {
            onChange({ ...draft, conditions });
          }}
        />
      </FieldSet>
      <FieldSet>
        <FieldLegend id={`${ids}-effect`} variant="label">
          <Trans>What it does</Trans>
        </FieldLegend>
        <RadioGroup
          aria-labelledby={`${ids}-effect`}
          disabled={disabled}
          onValueChange={(value) => {
            const effect = ruleEffectSchema.safeParse(value);
            if (effect.success) {
              onChange({ ...draft, effect: effect.data });
            }
          }}
          value={draft.effect}
        >
          {(["flag", "block"] as const).map((effect) => (
            <ChoiceCard
              description={i18n._(effectDescription[effect])}
              id={`${ids}-effect-${effect}`}
              key={effect}
              title={i18n._(effectLabel[effect])}
              value={effect}
            />
          ))}
        </RadioGroup>
      </FieldSet>
      {fresh ? (
        <FieldSet>
          <FieldLegend id={`${ids}-start`} variant="label">
            <Trans context="how a new rule starts: watching or active">
              Start
            </Trans>
          </FieldLegend>
          <RadioGroup
            aria-labelledby={`${ids}-start`}
            disabled={disabled}
            onValueChange={(value) => {
              const status = ruleStatusSchema.safeParse(value);
              if (status.success) {
                onChange({ ...draft, status: status.data });
              }
            }}
            value={draft.status}
          >
            {(["watching", "active"] as const).map((status) => (
              <ChoiceCard
                description={i18n._(ruleStatusDescription[status])}
                id={`${ids}-status-${status}`}
                key={status}
                title={i18n._(ruleStatusLabel[status])}
                value={status}
              />
            ))}
          </RadioGroup>
        </FieldSet>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${ids}-source`}>
          <Trans>Where it comes from</Trans>
        </FieldLabel>
        <NativeSelect
          className="w-full"
          disabled={disabled}
          id={`${ids}-source`}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange({
              ...draft,
              policyId: chosen === "" ? null : chosen,
            });
          }}
          value={draft.policyId ?? ""}
        >
          <NativeSelectOption value="">{t`Made by hand`}</NativeSelectOption>
          {policies.map((policy) => (
            <NativeSelectOption key={policy.id} value={policy.id}>
              {policy.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {draft.policyId === null ? null : (
        <Field>
          <FieldLabel htmlFor={`${ids}-excerpt`}>
            <Trans>The passage it says</Trans>
          </FieldLabel>
          <Textarea
            disabled={disabled}
            id={`${ids}-excerpt`}
            maxLength={4000}
            onChange={(event) => {
              onChange({ ...draft, excerpt: event.target.value });
            }}
            rows={3}
            value={draft.excerpt}
          />
          <FieldDescription>
            <Trans>Word for word, as the policy has it.</Trans>
          </FieldDescription>
        </Field>
      )}
    </FieldGroup>
  );
};

/**
 * A rule made by hand, or from `policyId`, on a page of its own as in the
 * prototype (`routes/policies/rules/new.tsx`). It starts by watching unless
 * it is turned on straight away.
 */
export const NewRule = ({
  policies,
  policyId,
}: {
  policies: readonly PolicyDocument[];
  policyId: string | null;
}) => {
  const { t } = useLingui();
  const [draft, setDraft] = useState<RuleDraft>(() =>
    draftOf(undefined, policyId)
  );
  const { busy, failure, save } = useSaveRule();
  return (
    <>
      <PageHeading
        action={
          <>
            <Button
              nativeButton={false}
              render={<Link to="/policies" />}
              size="sm"
              variant="outline"
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              disabled={!canSaveRule(draft) || busy}
              onClick={() => {
                void save(draft);
              }}
              size="sm"
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              <Trans>Save rule</Trans>
            </Button>
          </>
        }
        description={t`Say which apps break the rule, and what happens to them.`}
        title={t`New rule`}
      />
      <ErrorText>{failure}</ErrorText>
      {/* Without the prototype's preview beside it: core works out what a rule catches once it is saved. */}
      <RuleForm
        disabled={busy}
        draft={draft}
        fresh
        onChange={setDraft}
        policies={policies}
      />
    </>
  );
};

/** Edits `rule`: everything but its status, which its page turns. */
const EditRuleDialog = ({
  rule,
  policies,
  open,
  onOpenChange,
}: {
  rule: PolicyRule;
  policies: readonly PolicyDocument[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const [draft, setDraft] = useState<RuleDraft>(() =>
    draftOf(rule, rule.policyId)
  );
  const { busy, failure, save } = useSaveRule(rule);
  const [confirming, setConfirming] = useState(false);
  const canSave = canSaveRule(draft) && !busy;
  // Made to block while it acts: from the save on, apps are blocked. The
  // page's rule is current as the save writes, or core refuses the save.
  const startsBlocking =
    rule.status === "active" &&
    rule.effect !== "block" &&
    draft.effect === "block";
  const commit = async (): Promise<void> => {
    if (await save(draft)) {
      onOpenChange(false);
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-2xl">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) {
              return;
            }
            if (startsBlocking) {
              setConfirming(true);
            } else {
              void commit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Edit the rule</Trans>
            </DialogTitle>
          </DialogHeader>
          <RuleForm
            disabled={busy}
            draft={draft}
            fresh={false}
            onChange={setDraft}
            policies={policies}
          />
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={!canSave} type="submit">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
        <AlertDialog onOpenChange={setConfirming} open={confirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Start blocking?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  The rule is active, so from the moment it is saved every app
                  that breaks it is marked as blocked, and its access should be
                  removed.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirming(false);
                  void commit();
                }}
              >
                <Trans>Start blocking</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Whether a rule watches, acts or is paused, turned on its page as in the
 * prototype. Core turns the status alone (`setRuleStatus`), and only from
 * the revision this page read, so the rule the page shows is the rule as
 * it turns. Turning a rule that blocks on asks first: from then on it
 * marks apps as blocked.
 */
export const RuleStatusControl = ({ rule }: { rule: PolicyRule }) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [confirming, setConfirming] = useState(false);
  const turn = async (status: RuleStatus): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () =>
          await session.policies.setRuleStatus(rule.id, status, rule.revision),
        async () => {
          await router.invalidate();
        }
      );
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <ToggleGroup
        aria-label={t`Status of this rule`}
        disabled={busy}
        onValueChange={(value) => {
          const next = ruleStatusSchema.safeParse(value[0]);
          if (!next.success || next.data === rule.status) {
            return;
          }
          if (next.data === "active" && rule.effect === "block") {
            setConfirming(true);
          } else {
            void turn(next.data);
          }
        }}
        size="sm"
        value={[rule.status]}
        variant="outline"
      >
        {(["watching", "active", "paused"] as const).map((status) => (
          <ToggleGroupItem key={status} value={status}>
            {i18n._(ruleStatusLabel[status])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ErrorText>{failure}</ErrorText>
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Start blocking?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Once it is active, every app that breaks this rule is marked as
                blocked, and its access should be removed.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                void turn("active");
              }}
            >
              <Trans>Start blocking</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

/* ── Policies ────────────────────────────────────────────────────────── */

/** A file's name without its extension: the title a policy starts with. */
const titleOf = (fileName: string): string => fileName.replace(/\.[^.]+$/u, "");

/**
 * Uploads a policy for review: its text, from a text or Markdown file or
 * pasted in. Grasp reads no PDF or Word file yet, so a policy in one is
 * pasted as its text.
 */
export const UploadPolicyDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const navigate = useNavigate();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const canUpload = title.trim() !== "" && text.trim() !== "" && !busy;
  const upload = async (): Promise<void> => {
    const uploaded = await run(
      async (session) =>
        await session.policies.upload({
          title: title.trim(),
          fileName: fileName === "" ? `${title.trim()}.txt` : fileName,
          text: text.trim(),
        })
    );
    if (uploaded !== undefined) {
      onOpenChange(false);
      await navigate({
        to: "/policies/documents/$policyId",
        params: { policyId: uploaded.id },
      });
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-2xl">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (canUpload) {
              void upload();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Upload a policy</Trans>
            </DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${ids}-file`}>
              <Trans>Text or Markdown file</Trans>
            </FieldLabel>
            <Input
              accept=".txt,.md,text/plain,text/markdown"
              disabled={busy}
              id={`${ids}-file`}
              onChange={(event) => {
                const [file] = event.target.files ?? [];
                if (file === undefined) {
                  return;
                }
                setFileName(file.name);
                if (title.trim() === "") {
                  setTitle(titleOf(file.name));
                }
                void (async () => {
                  setText(await file.text());
                })();
              }}
              type="file"
            />
            <FieldDescription>
              <Trans>
                Or paste the policy&apos;s text below: Grasp doesn&apos;t read
                PDF or Word files yet.
              </Trans>
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-title`}>
              <Trans context="the title of a policy document">Title</Trans>
            </FieldLabel>
            <Input
              autoComplete="off"
              disabled={busy}
              id={`${ids}-title`}
              maxLength={200}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              placeholder={t`Acceptable use of AI`}
              value={title}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-text`}>
              <Trans>The policy&apos;s text</Trans>
            </FieldLabel>
            <Textarea
              disabled={busy}
              id={`${ids}-text`}
              maxLength={policyTextMax}
              onChange={(event) => {
                setText(event.target.value);
              }}
              rows={8}
              value={text}
            />
            <FieldDescription>
              <Trans>
                It waits for you to publish it. Everyone in the company can see
                its title and its rules, never its text here.
              </Trans>
            </FieldDescription>
          </Field>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={!canUpload} type="submit">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              <Trans>Upload</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Asks before removing what can't be had back. */
export const RemoveDialog = ({
  title,
  description,
  open,
  onOpenChange,
  onRemove,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onRemove} variant="destructive">
          <Trans>Remove</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/* ── Exceptions ──────────────────────────────────────────────────────── */

/** Lets one app break `rule` until a day, in place of any exception it had. */
export const ExceptionDialog = ({
  rule,
  apps,
  open,
  onOpenChange,
}: {
  rule: PolicyRule;
  /** The Landscape's apps, to pick the one from. */
  apps: readonly LandscapeApp[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [appId, setAppId] = useState(apps[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const today = policyToday();
  const canGrant =
    appId !== "" && reason.trim() !== "" && until >= today && !busy;
  const grant = async (): Promise<void> => {
    const granted = await run(
      async (session) =>
        await session.policies.grantException({
          ruleId: rule.id,
          appId,
          reason: reason.trim(),
          until,
        })
    );
    if (granted !== undefined) {
      onOpenChange(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (canGrant) {
              void grant();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Let an app break this rule</Trans>
            </DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${ids}-app`}>
              <Trans context="an app in the landscape">App</Trans>
            </FieldLabel>
            <NativeSelect
              className="w-full"
              disabled={busy || apps.length === 0}
              id={`${ids}-app`}
              onChange={(event) => {
                setAppId(event.target.value);
              }}
              value={appId}
            >
              {apps.map((app) => (
                <NativeSelectOption key={app.id} value={app.id}>
                  {app.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-reason`}>
              <Trans>Why</Trans>
            </FieldLabel>
            <Textarea
              disabled={busy}
              id={`${ids}-reason`}
              maxLength={2000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              rows={3}
              value={reason}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-until`}>
              <Trans>Until</Trans>
            </FieldLabel>
            <Input
              disabled={busy}
              id={`${ids}-until`}
              min={today}
              onChange={(event) => {
                setUntil(event.target.value);
              }}
              type="date"
              value={until}
            />
            <FieldDescription>
              <Trans>
                Its last day: the rule catches the app again after it.
              </Trans>
            </FieldDescription>
          </Field>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={!canGrant} type="submit">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              <Trans>Grant</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/* ── The pages' actions ──────────────────────────────────────────────── */

/** The policy manager's actions: upload a policy, make a rule by hand on its own page. */
export const PoliciesActions = () => {
  const [uploading, setUploading] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setUploading(true);
        }}
        size="sm"
        variant="outline"
      >
        <FileUpIcon data-icon="inline-start" />
        <Trans>Upload a policy</Trans>
      </Button>
      <Button
        nativeButton={false}
        render={<Link to="/policies/rules/new" />}
        size="sm"
      >
        <PlusIcon data-icon="inline-start" />
        <Trans>New rule</Trans>
      </Button>
      {/* Mounted while open, so each opening starts from nothing. */}
      {uploading ? (
        <UploadPolicyDialog onOpenChange={setUploading} open={uploading} />
      ) : null}
    </>
  );
};

/**
 * Leaves the page for `to` and reads every page again, so none shows what
 * was just changed or removed.
 */
const useLeaveAndReload = () => {
  const navigate = useNavigate();
  const router = useRouter();
  return async (to: "/policies"): Promise<void> => {
    await navigate({ to });
    await router.invalidate();
  };
};

/**
 * A policy's actions: publish it while it waits for review, or once Grasp
 * couldn't read it (its rules are then made by hand); and, behind its
 * menu as in the prototype, make a rule from it or remove it.
 */
export const PolicyActions = ({ policy }: { policy: PolicyDocument }) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const leave = useLeaveAndReload();
  const { busy, failure, run } = useCoreAction();
  const [removing, setRemoving] = useState(false);
  const { title } = policy;
  const publish = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await session.policies.publish(policy.id),
        async () => {
          await router.invalidate();
        }
      );
    });
  };
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.policies.removePolicy(policy.id);
      return true;
    });
    if (removed === true) {
      await leave("/policies");
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {policy.status === "review" || policy.status === "failed" ? (
          <Button
            disabled={busy}
            onClick={() => {
              void publish();
            }}
            size="sm"
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            <Trans>Publish</Trans>
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            render={
              <Button
                aria-label={t`More for this policy`}
                size="icon-sm"
                variant="outline"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  void navigate({
                    to: "/policies/rules/new",
                    search: { policy: policy.id },
                  });
                }}
              >
                <PlusIcon />
                <Trans>Make a rule from it</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setRemoving(true);
                }}
                variant="destructive"
              >
                <Trash2Icon />
                <Trans>Remove policy</Trans>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ErrorText>{failure}</ErrorText>
      <RemoveDialog
        description={t`Its rules stay, as rules made by hand. This can't be undone.`}
        onOpenChange={setRemoving}
        onRemove={() => {
          setRemoving(false);
          void remove();
        }}
        open={removing}
        title={t`Remove ${title}?`}
      />
    </div>
  );
};

/** A rule's actions, behind its menu as in the prototype: edit it, or delete it. */
export const RuleActions = ({
  rule,
  policies,
}: {
  rule: PolicyRule;
  policies: readonly PolicyDocument[];
}) => {
  const { t } = useLingui();
  const leave = useLeaveAndReload();
  const { busy, failure, run } = useCoreAction();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { name } = rule;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.policies.removeRule(rule.id, rule.revision);
      return true;
    });
    if (removed === true) {
      await leave("/policies");
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          render={
            <Button
              aria-label={t`More for this rule`}
              size="icon-sm"
              variant="outline"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setEditing(true);
              }}
            >
              <PencilIcon />
              <Trans>Edit rule</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setRemoving(true);
              }}
              variant="destructive"
            >
              <Trash2Icon />
              <Trans>Delete rule</Trans>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ErrorText>{failure}</ErrorText>
      {editing ? (
        <EditRuleDialog
          onOpenChange={setEditing}
          open={editing}
          policies={policies}
          rule={rule}
        />
      ) : null}
      <RemoveDialog
        description={t`Its exceptions go with it. This can't be undone.`}
        onOpenChange={setRemoving}
        onRemove={() => {
          setRemoving(false);
          void remove();
        }}
        open={removing}
        title={t`Delete ${name}?`}
      />
    </div>
  );
};

/** The apps allowed to break `rule`, and for an admin, granting and revoking that. */
export const RuleExceptions = ({
  rule,
  apps,
  exceptions,
  edits,
}: {
  rule: PolicyRule;
  apps: readonly LandscapeApp[];
  exceptions: readonly PolicyException[];
  edits: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [granting, setGranting] = useState(false);
  const own = exceptions.filter(({ ruleId }) => ruleId === rule.id);
  const today = policyToday();
  const revoke = async (appId: string): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.policies.revokeException(rule.id, appId);
        },
        async () => {
          await router.invalidate();
        }
      );
    });
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>
          <Trans>Exceptions</Trans>
        </SectionTitle>
        {edits ? (
          <Button
            disabled={busy || apps.length === 0}
            onClick={() => {
              setGranting(true);
            }}
            size="sm"
            variant="outline"
          >
            <PlusIcon data-icon="inline-start" />
            <Trans>Grant an exception</Trans>
          </Button>
        ) : null}
      </div>
      {own.length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border p-4">
          <Trans>No app is allowed to break this rule.</Trans>
        </p>
      ) : (
        <ul className="bg-card flex flex-col divide-y rounded-xl border">
          {own.map((exception) => {
            const app =
              apps.find(({ id }) => id === exception.appId)?.name ??
              exception.appId;
            const until = formatDay(exception.until);
            const ended = exception.until < today;
            return (
              <li
                className="flex flex-wrap items-start justify-between gap-3 p-4"
                key={exception.appId}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{app}</span>
                  <span className="text-muted-foreground">
                    {exception.reason}
                  </span>
                  <span className="text-muted-foreground">
                    {ended ? (
                      <Trans>Ended on {until}</Trans>
                    ) : (
                      <Trans>Until {until}</Trans>
                    )}
                  </span>
                </div>
                {edits ? (
                  <Button
                    aria-label={t`Revoke the exception for ${app}`}
                    disabled={busy}
                    onClick={() => {
                      void revoke(exception.appId);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Trans>Revoke</Trans>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText>{failure}</ErrorText>
      {granting ? (
        <ExceptionDialog
          apps={apps}
          onOpenChange={setGranting}
          open={granting}
          rule={rule}
        />
      ) : null}
    </section>
  );
};
