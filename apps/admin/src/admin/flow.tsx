import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import {
  defaultFlow,
  flowAgreements,
  flowOpening,
  flowPresets,
  flowProblemOf,
} from "@grasp-os/shared/onboarding-flow";
import type {
  FlowAgreement,
  FlowPreset,
  FlowProblem,
  FlowStep,
  OnboardingFlow,
} from "@grasp-os/shared/onboarding-flow";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import {
  SortableList,
  SortableListHandle,
  SortableListItem,
} from "@grasp-os/ui/components/sortable-list";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";

const styles = stylex.create({
  // The page's parts, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["8"] },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
  foot: { display: "flex", flexDirection: "column", gap: space["3"] },
  // The switches at a readable width, each label its row's.
  switches: { display: "flex", flexDirection: "column", maxWidth: "36rem" },
  readable: { maxWidth: "36rem" },
  // The presets as wide as their words.
  presets: { width: "fit-content" },
  field: { flexGrow: 1 },
});

// An organization's Flow: how much onboarding it goes through, as Grasp's
// staff set it. Whether there is an onboarding at all, the admin's steps
// in order with each on or off, and which of Grasp's own steps are asked
// of this company (the first conversation, and each agreement). Staff
// change a draft on the page: nothing reaches the company's Grasp until
// they save, which gives one command with the whole flow
// (`onboarding.flow`); taking all of it back gives it with none. No
// onboarding at all is a preset like the others: picking another one
// switches it back on. Beside the save, how the company's Grasp opens.

/** Each of the admin's steps, as staff read it. */
const stepWords: Record<FlowStep, string> = {
  welcome: "Welcome",
  ai: "Its AI",
  about: "How this works",
  company: "Who’s who",
  sources: "Where the work is written down",
  documents: "Documents",
  pulse: "The tools people use",
  leads: "Team leads",
  interviews: "Interviews",
};

/** Each agreement Grasp can ask for, as the Steps page names them. */
const agreementWords: Record<FlowAgreement, string> = {
  processing: "Agreement on handling data",
  assessment: "The company’s look at the risks",
  council: "Works council",
};

/** The flows staff start from, in the order they are offered. */
const presets: { id: FlowPreset; name: string }[] = [
  { id: "full", name: "Full" },
  { id: "short", name: "Short" },
  { id: "setup", name: "Setup only" },
  { id: "none", name: "No onboarding" },
];

/** Why a flow can't be saved, in words. */
const problemWords: Record<FlowProblem, string> = {
  steps: "A step is missing from the list.",
  staff_list:
    "Team leads and the interviews go by the staff list: switch Who’s who on, and keep it above them.",
};

/** How the company's Grasp opens in a flow, in a sentence. */
const openingWords: Record<ReturnType<typeof flowOpening>, string> = {
  go: "Its Grasp opens when Grasp gives its go, once the interviews told enough.",
  finished: "Its Grasp opens when its admin finishes the last step.",
  at_once:
    "Its Grasp opens at once: everyone signs in straight to the platform.",
};

/** A setting turned on or off: its words, and the switch at the row's end. */
const Switched = ({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <Field disabled={disabled} orientation="horizontal" style={styles.field}>
    <FieldLabel>{label}</FieldLabel>
    <Switch checked={checked} onCheckedChange={onChange} />
  </Field>
);

/** The admin's steps: each on or off, and moved by its handle, by hand or from the keyboard. */
const Steps = ({
  flow,
  disabled,
  onChange,
}: {
  flow: OnboardingFlow;
  disabled: boolean;
  onChange: (flow: OnboardingFlow) => void;
}) => (
  <SortableList
    aria-label="The admin’s steps, in order"
    disabled={disabled}
    onValueChange={(order) => {
      onChange({
        ...flow,
        steps: order.flatMap((id) =>
          flow.steps.filter((step) => step.id === id)
        ),
      });
    }}
    style={styles.readable}
    value={flow.steps.map(({ id }) => id)}
  >
    {flow.steps.map((step) => {
      const name = stepWords[step.id];
      return (
        <SortableListItem key={step.id} textValue={name} value={step.id}>
          <SortableListHandle aria-label={`Move ${name}`} />
          <Switched
            checked={step.on}
            disabled={disabled}
            label={name}
            onChange={(on) => {
              onChange({
                ...flow,
                steps: flow.steps.map((each) =>
                  each.id === step.id ? { ...each, on } : each
                ),
              });
            }}
          />
        </SortableListItem>
      );
    })}
  </SortableList>
);

/** The preset `flow` is, as it stands; none once it was changed by hand. */
const presetOf = (flow: OnboardingFlow): FlowPreset | undefined =>
  presets.find(
    ({ id }) => JSON.stringify(flowPresets[id]) === JSON.stringify(flow)
  )?.id;

/**
 * An organization's Flow, on what its Grasp says it is now (`flow`; none
 * from a Grasp that keeps no flow yet, which can't take one either).
 */
export const OrgFlow = ({
  clientId,
  flow: kept,
}: {
  clientId: string;
  flow: AdminSnapshot["flow"];
}) => {
  const saved = kept?.flow ?? defaultFlow;
  const { busy, failure, give } = useCommand(clientId);
  // What staff changed and haven't saved; none while the page shows what is kept.
  const [draft, setDraft] = useState<OnboardingFlow | null>(null);
  if (kept === undefined) {
    return (
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyTitle>No flow kept yet</EmptyTitle>
          <EmptyDescription>
            This company’s Grasp keeps no flow yet: it goes through the whole
            onboarding. Update its Grasp from Setup to set one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const flow = draft ?? saved;
  const preset = presetOf(flow);
  const problem = flow.on ? flowProblemOf(flow.steps) : null;
  const changed =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async (next: OnboardingFlow | null) => {
    if (await give({ type: "onboarding.flow", payload: { flow: next } })) {
      setDraft(null);
    }
  };
  return (
    <div {...stylex.props(styles.parts)}>
      <Part aria-labelledby="how-much">
        <SectionHeader
          description={
            flow.on
              ? "Start from one of these, then change the steps below."
              : "No onboarding: pick another to switch the steps back on."
          }
          id="how-much"
          title="How much onboarding"
          variant="group"
        />
        <ToggleGroup
          aria-label="How much onboarding"
          disabled={busy}
          onValueChange={(next) => {
            const chosen = presets.find(({ id }) => id === next[0]);
            if (chosen !== undefined) {
              setDraft(flowPresets[chosen.id]);
            }
          }}
          size="sm"
          style={styles.presets}
          value={preset === undefined ? [] : [preset]}
        >
          {presets.map(({ id, name }) => (
            <ToggleGroupItem key={id} value={id}>
              {name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Part>
      <Part aria-labelledby="admin-steps">
        <SectionHeader
          description="What the company’s admin goes through, in this order."
          id="admin-steps"
          title="The admin’s steps"
          variant="group"
        />
        <Steps disabled={busy || !flow.on} flow={flow} onChange={setDraft} />
      </Part>
      <Part aria-labelledby="grasp-steps">
        <SectionHeader
          description="Interview links wait for each agreement that is on."
          id="grasp-steps"
          title="Grasp’s steps"
          variant="group"
        />
        <div {...stylex.props(styles.switches)}>
          <Switched
            checked={flow.grasp.kickoff}
            disabled={busy || !flow.on}
            label="The first conversation"
            onChange={(kickoff) => {
              setDraft({ ...flow, grasp: { ...flow.grasp, kickoff } });
            }}
          />
          {flowAgreements.map((agreement) => (
            <Switched
              checked={flow.grasp.agreements[agreement]}
              disabled={busy || !flow.on}
              key={agreement}
              label={agreementWords[agreement]}
              onChange={(on) => {
                setDraft({
                  ...flow,
                  grasp: {
                    ...flow.grasp,
                    agreements: { ...flow.grasp.agreements, [agreement]: on },
                  },
                });
              }}
            />
          ))}
        </div>
      </Part>
      <div {...stylex.props(styles.foot)}>
        {problem === null ? null : (
          <Alert live="polite" variant="warning">
            <AlertDescription>{problemWords[problem]}</AlertDescription>
          </Alert>
        )}
        <CommandFailure failure={failure} />
        <div {...stylex.props(styles.row)}>
          <Button
            disabled={busy || !changed || problem !== null}
            onClick={() => {
              void save(flow);
            }}
          >
            Save flow
          </Button>
          {changed ? (
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(null);
              }}
              variant="outline"
            >
              Leave it as it was
            </Button>
          ) : null}
          {kept.changed && !changed ? (
            <Button
              disabled={busy}
              onClick={() => {
                void save(null);
              }}
              variant="outline"
            >
              Take the whole onboarding back
            </Button>
          ) : null}
          <Text color="muted" size="sm">
            {changed
              ? "Not saved yet: nothing has reached the company’s Grasp."
              : "This is what the company’s Grasp keeps."}
          </Text>
        </div>
        <Text color="muted" size="sm">
          {openingWords[flowOpening(flow)]}
        </Text>
      </div>
    </div>
  );
};
