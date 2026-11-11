import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import {
  defaultFlow,
  flowAgreements,
  flowOpening,
  flowPresets,
  flowProblemOf,
  flowScreens,
  withStepMoved,
} from "@grasp-os/shared/onboarding-flow";
import type {
  FlowAgreement,
  FlowPreset,
  FlowProblem,
  FlowStep,
  OnboardingFlow,
  SetupStepId,
} from "@grasp-os/shared/onboarding-flow";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  SortableItem,
  SortableList,
} from "@grasp-os/ui/components/sortable-list";
import type { SortableWords } from "@grasp-os/ui/components/sortable-list";
import { Switch } from "@grasp-os/ui/components/switch";
import { useId, useState } from "react";

import { CommandFailure, useCommand } from "./commands.tsx";
import { EmptySection, Section, SectionRow } from "./section.tsx";

// An organization's Flow: how much onboarding it goes through, as Grasp's
// staff set it. Whether there is an onboarding at all, the admin's steps
// in order with each on or off, and which of Grasp's own steps are asked
// of this company (the first conversation, and each agreement). Staff
// change a draft on the page: nothing reaches the company's Grasp until
// they save, which gives one command with the whole flow
// (`onboarding.flow`); taking all of it back gives it with none. Beside
// the steps, what the company's admin will go through and how its Grasp
// opens, so the flow is read as the company will meet it.

/** Each of the admin's steps, as staff read it, and what the admin does on it. */
const stepWords: Record<FlowStep, { name: string; about: string }> = {
  welcome: {
    name: "Welcome",
    about: "Stephen says hello; they pick a language",
  },
  ai: {
    name: "Its AI",
    about: "Grasp’s AI, or the company’s own key and model",
  },
  about: { name: "How this works", about: "The story, and a sample interview" },
  company: {
    name: "Who’s who",
    about: "The staff list, or its sign-in’s directory",
  },
  sources: {
    name: "Where the work is written down",
    about: "SharePoint, Drive, Teams and the like",
  },
  documents: { name: "Documents", about: "Whatever explains how they work" },
  pulse: { name: "The tools people use", about: "Pulse on the work laptops" },
  leads: {
    name: "Team leads",
    about: "The HR platform, then who leads which team",
  },
  interviews: {
    name: "Interviews",
    about:
      "Telling the team, Stephen talking to them, what needs the admin, and the way in",
  },
};

/** Each screen the admin sees, by name, for the path beside the steps. */
const screenWords: Record<SetupStepId, string> = {
  welcome: "Welcome",
  ai: "Its AI",
  about: "How this works",
  company: "Who’s who",
  sources: "Where the work is written down",
  documents: "Documents",
  pulse: "The tools people use",
  leads: "Team leads",
  team: "Telling the team",
  listening: "Stephen talks to the team",
  review: "What needs the admin",
  open: "The way in",
};

/** Each agreement Grasp can ask for, as the Steps page names them. */
const agreementWords: Record<FlowAgreement, { name: string; about: string }> = {
  processing: {
    name: "Agreement on handling data",
    about: "The data processing agreement, signed.",
  },
  assessment: {
    name: "The company’s look at the risks",
    about: "Its assessment of the risks to its people, done.",
  },
  council: {
    name: "Works council",
    about: "Agreed, or the company has none.",
  },
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
  go: "When Grasp gives its go, once the interviews told enough.",
  finished: "When its admin finishes the last step.",
  at_once: "At once: everyone signs in straight to the platform.",
};

/** What a screen reader hears as a step is moved. */
const moveWords: SortableWords = {
  instructions:
    "Press space to pick a step up, the arrow keys to move it, space to put it down, escape to leave it where it was.",
  picked: (name, place) => `${name} picked up, at place ${place}.`,
  moved: (name, place) => `${name} moved to place ${place}.`,
  dropped: (name, place) => `${name} put down at place ${place}.`,
  cancelled: (name) => `${name} left where it was.`,
};

/** A switch with what it switches, and what that is, beside it. */
const Switched = ({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Switch
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onChange}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description === undefined ? null : (
          <FieldDescription>{description}</FieldDescription>
        )}
      </div>
    </Field>
  );
};

/** The admin's steps: each on or off, and moved by hand or from the keyboard. */
const Steps = ({
  flow,
  disabled,
  onChange,
}: {
  flow: OnboardingFlow;
  disabled: boolean;
  onChange: (flow: OnboardingFlow) => void;
}) => (
  <div className="px-5 pb-5">
    <SortableList
      aria-label="The admin’s steps, in order"
      disabled={disabled}
      items={flow.steps.map(({ id }) => ({ id, name: stepWords[id].name }))}
      onMove={(id, to) => {
        const step = flow.steps.find((each) => each.id === id);
        if (step !== undefined) {
          onChange(withStepMoved(flow, step.id, to));
        }
      }}
      words={moveWords}
    >
      {flow.steps.map((step) => {
        const { name, about } = stepWords[step.id];
        return (
          <SortableItem handleLabel={`Move ${name}`} id={step.id} key={step.id}>
            <div className="min-w-0 flex-1 py-2">
              <Switched
                checked={step.on}
                description={about}
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
            </div>
          </SortableItem>
        );
      })}
    </SortableList>
  </div>
);

/** What the company's admin goes through in `flow`, and how its Grasp opens. */
const Path = ({ flow }: { flow: OnboardingFlow }) => {
  const screens = flowScreens(flow);
  return (
    <Section
      description="As the company will meet it, once this flow is saved."
      title="What its admin goes through"
    >
      <SectionRow label="The screens, in order">
        {screens.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ol className="flex flex-col gap-0.5 sm:text-right">
            {screens.map((screen) => (
              <li key={screen}>{screenWords[screen]}</li>
            ))}
          </ol>
        )}
      </SectionRow>
      <SectionRow label="Its Grasp opens">
        <span className="sm:text-right">{openingWords[flowOpening(flow)]}</span>
      </SectionRow>
    </Section>
  );
};

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
      <EmptySection>
        This company’s Grasp keeps no flow yet: it goes through the whole
        onboarding. Update its Grasp from Setup to set one.
      </EmptySection>
    );
  }
  const flow = draft ?? saved;
  const problem = flow.on ? flowProblemOf(flow.steps) : null;
  const changed =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async (next: OnboardingFlow | null) => {
    if (await give({ type: "onboarding.flow", payload: { flow: next } })) {
      setDraft(null);
    }
  };
  return (
    <>
      <Section
        action={
          <div className="flex flex-wrap gap-2">
            {presets.map(({ id, name }) => (
              <Button
                disabled={busy}
                key={id}
                onClick={() => {
                  setDraft(flowPresets[id]);
                }}
                size="sm"
                variant="outline"
              >
                {name}
              </Button>
            ))}
          </div>
        }
        description="How much onboarding this company goes through. Start from one of these, then change it below."
        title="The onboarding"
      >
        <SectionRow
          description="Off: everyone signs in straight to the platform, and nobody is sent to the onboarding."
          label="This company goes through an onboarding"
        >
          <Switch
            aria-label="This company goes through an onboarding"
            checked={flow.on}
            disabled={busy}
            onCheckedChange={(on) => {
              setDraft({ ...flow, on });
            }}
          />
        </SectionRow>
      </Section>
      <Section
        description="Each can be switched off, and moved by its handle or from the keyboard. Who’s who stays above Team leads and Interviews, and the interviews’ screens always come last."
        title="The admin’s steps"
      >
        <Steps disabled={busy || !flow.on} flow={flow} onChange={setDraft} />
      </Section>
      <Section
        description="What Grasp does itself for this company, before its people are asked anything."
        title="Grasp’s steps"
      >
        <div className="flex flex-col gap-4 px-5 pb-5">
          <Switched
            checked={flow.grasp.kickoff}
            description="The first conversation with its sponsor, brought in as a transcript."
            disabled={busy || !flow.on}
            label="The first conversation"
            onChange={(kickoff) => {
              setDraft({ ...flow, grasp: { ...flow.grasp, kickoff } });
            }}
          />
          {flowAgreements.map((agreement) => (
            <Switched
              checked={flow.grasp.agreements[agreement]}
              description={`${agreementWords[agreement].about} Interview links wait for it while it is on.`}
              disabled={busy || !flow.on}
              key={agreement}
              label={agreementWords[agreement].name}
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
      </Section>
      <Path flow={flow} />
      <div className="flex flex-col gap-2">
        {problem === null ? null : (
          <output className="text-status-attention">
            {problemWords[problem]}
          </output>
        )}
        <CommandFailure failure={failure} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy || !changed || problem !== null}
            onClick={() => {
              void save(flow);
            }}
            variant="highlight"
          >
            Save flow
          </Button>
          {changed ? (
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(null);
              }}
              variant="ghost"
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
          <span className="text-muted-foreground">
            {changed
              ? "Not saved yet: nothing has reached the company’s Grasp."
              : "This is what the company’s Grasp keeps."}
          </span>
        </div>
      </div>
    </>
  );
};
