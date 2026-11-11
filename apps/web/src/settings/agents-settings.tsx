import type { Agent, AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentWakes } from "./agent-wakes.tsx";
import { SettingsSection } from "./settings-parts.tsx";
import {
  AudienceControl,
  appAudienceOf,
  audienceOf,
  chosenOf,
} from "./stephen-audience.tsx";
import { StephenAvatar } from "./stephen-avatar.tsx";
import { classNames, OpenRow, Row } from "./stephen-settings.tsx";

// Settings › Agents, for admins: the company's agents, each with its own
// name, job and instructions, whom it answers and what it may do. The
// first agent is the one every company starts with; whom it reaches and
// what it may do stays in Settings › Stephen, and this page leads there.
// Every other agent starts reaching nobody and with nothing it may do,
// until an admin says otherwise here. Each layer only narrows the one
// above it: an agent has a class of tools for at most the people the
// company has it for. Core keeps it and holds every agent to it from the
// next message (agent-builder.ts, agent-reach.ts). Every control saves at
// once and reads the page again. The company's own admins change it;
// Grasp staff don't. A first version: it follows Settings › Stephen's
// parts, and has no design of its own yet.

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** What an admin types of an agent. */
interface Typed {
  name: string;
  job: string;
  instructions: string;
}

/** The figure a new agent is drawn with, until an admin can choose one. */
const defaultFace = "stephen";

/** An agent's name, job and instructions, typed and saved together. */
const AgentForm = ({
  initial,
  submit,
  can,
  onSave,
}: {
  initial: Typed;
  submit: string;
  can: boolean;
  onSave: (typed: Typed) => Promise<void>;
}) => {
  const { t } = useLingui();
  const nameId = useId();
  const jobId = useId();
  const instructionsId = useId();
  const [typed, setTyped] = useState<Typed>(initial);
  return (
    <form
      className="flex flex-col gap-4 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          ...typed,
          name: typed.name.trim(),
          job: typed.job.trim(),
        });
      }}
    >
      <Field>
        <FieldLabel htmlFor={nameId}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          disabled={!can}
          id={nameId}
          maxLength={60}
          onChange={(event) => {
            setTyped({ ...typed, name: event.target.value });
          }}
          value={typed.name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={jobId}>
          <Trans>What it is for</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          disabled={!can}
          id={jobId}
          maxLength={200}
          onChange={(event) => {
            setTyped({ ...typed, job: event.target.value });
          }}
          placeholder={t`One line, such as: chases unpaid invoices.`}
          value={typed.job}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={instructionsId}>
          <Trans>Instructions</Trans>
        </FieldLabel>
        <Textarea
          disabled={!can}
          id={instructionsId}
          maxLength={8000}
          onChange={(event) => {
            setTyped({ ...typed, instructions: event.target.value });
          }}
          placeholder={t`What it should know and how it should work. Grasp's own rules always hold over these.`}
          rows={6}
          value={typed.instructions}
        />
      </Field>
      <div className="flex justify-end">
        <Button disabled={!can || typed.name.trim() === ""} type="submit">
          {submit}
        </Button>
      </div>
    </form>
  );
};

/** One agent, opened beside the page. */
const AgentPanel = ({
  agent,
  first,
  settings,
  teams,
  wakes,
  people,
  editable,
  can,
  change,
}: {
  agent: Agent;
  /** Whether the person may change agents at all. */
  editable: boolean;
  /** The company's first agent, whose reach is Settings › Stephen's. */
  first: boolean;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  wakes: readonly AgentWake[];
  people: readonly Member[];
  can: boolean;
  change: Change;
}) => {
  const { t, i18n } = useLingui();
  const { name } = agent;
  const on = agent.state === "on";
  return (
    <>
      <SheetHeader className="mr-8">
        <SheetTitle>{name}</SheetTitle>
        <SheetDescription>{on ? t`On` : t`Paused`}</SheetDescription>
      </SheetHeader>
      <AgentForm
        can={can}
        initial={{
          name: agent.name,
          job: agent.job,
          instructions: agent.instructions,
        }}
        // By the agent alone: what is typed and not yet saved stays while
        // the agent is paused or its reach changes.
        key={agent.id}
        onSave={async (typed) => {
          await change(async (session) => {
            await session.connections.changeAgent(agent.id, {
              ...typed,
              face: agent.face,
              modelRole: agent.modelRole,
            });
          });
        }}
        submit={t`Save`}
      />
      <ul>
        <Row
          description={t`Paused, it answers nobody anywhere.`}
          name={t`${name} is on`}
        >
          <Switch
            aria-label={t`${name} is on`}
            checked={on}
            disabled={!can}
            onCheckedChange={(next) => {
              void change(async (session) => {
                await session.connections.setAgentPaused(agent.id, !next);
              });
            }}
          />
        </Row>
        {first ? (
          <Row
            description={t`Whom the company's first agent reaches, and what it may do, is set in one place.`}
            name={t`Who may use it, and what it may do`}
          >
            <Button
              // A link, drawn as a button.
              nativeButton={false}
              render={<Link to="/settings/stephen" />}
              size="sm"
              variant="outline"
            >
              <Trans>Open its settings</Trans>
            </Button>
          </Row>
        ) : null}
        {settings === undefined ? null : (
          <>
            <Row
              description={t`Nobody yet, until you choose. People outside it can't ask it anything.`}
              name={t`Who may use it`}
            >
              <AudienceControl
                editable={can}
                key={JSON.stringify(settings.audience)}
                label={t`Who may use ${name}`}
                offers={["everyone", "teams", "nobody"]}
                teams={teams}
                value={chosenOf(settings.audience)}
                onSave={async (chosen) => {
                  await change(async (session) => {
                    await session.connections.setAgentReach(
                      agent.id,
                      settings.on,
                      audienceOf(chosen)
                    );
                  });
                }}
              />
            </Row>
            <li className="flex flex-col gap-0.5 border-t px-5 pt-4">
              <span className="font-medium">
                <Trans>What it may do</Trans>
              </span>
              <span className="text-muted-foreground">
                <Trans>
                  Each as the company has it, or for fewer people. Never for
                  more.
                </Trans>
              </span>
            </li>
            {settings.classes.map(({ toolClass, audience }) => {
              const className = i18n._(classNames[toolClass]);
              return (
                <Row key={toolClass} name={className}>
                  <AudienceControl
                    editable={can}
                    key={JSON.stringify(audience)}
                    label={t`${className}, for ${name}`}
                    offers={["same", "teams", "nobody"]}
                    same={t`As the company has it`}
                    teams={teams}
                    value={chosenOf(audience)}
                    onSave={async (chosen) => {
                      await change(async (session) => {
                        await session.connections.setAgentToolClass(
                          agent.id,
                          toolClass,
                          appAudienceOf(chosen)
                        );
                      });
                    }}
                  />
                </Row>
              );
            })}
          </>
        )}
        <AgentWakes
          agent={agent}
          can={can}
          change={change}
          editable={editable}
          people={people}
          wakes={wakes}
        />
      </ul>
    </>
  );
};

/** An agent that never works on its own. */
const noWakes: readonly AgentWake[] = [];

/** What is open beside the page: an agent, or the form for a new one. */
type Opened = { kind: "agent"; id: string } | { kind: "new" } | null;

export const AgentsSettings = ({
  agents,
  settings,
  teams,
  wakes,
  people,
  editable,
}: {
  /** Every agent, the company's first one first. */
  agents: Agent[];
  /** Each other agent's reach and classes, by its ID. */
  settings: Readonly<Record<string, AgentSettings>>;
  teams: StephenReach["teams"];
  /** Each agent's wake-ups, by its ID. */
  wakes: Readonly<Record<string, readonly AgentWake[]>>;
  /** The company's people, whom a wake-up can work for. */
  people: readonly Member[];
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [opened, setOpened] = useState<Opened>(null);
  const change: Change = async (action) => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const can = editable && !busy;
  const [first] = agents;
  const open = agents.find(
    ({ id }) => opened?.kind === "agent" && opened.id === id
  );
  return (
    <>
      <SettingsSection
        action={
          editable ? (
            <Button
              disabled={!can}
              onClick={() => {
                setOpened({ kind: "new" });
              }}
              size="sm"
            >
              <Trans>New agent</Trans>
            </Button>
          ) : undefined
        }
        description={t`Each agent has its own name and job, answers only the people you choose, and does only what you let it. A new agent starts with nobody and nothing.`}
        title={t`Agents`}
      >
        <ul className="border-t">
          {agents.map((agent) => (
            <OpenRow
              key={agent.id}
              line={
                agent.state === "on" ? agent.job : t`Paused · answers nobody`
              }
              logo={<StephenAvatar />}
              name={agent.name}
              onOpen={() => {
                setOpened({ kind: "agent", id: agent.id });
              }}
              state={agent.state === "on" ? "on" : "off"}
            />
          ))}
        </ul>
      </SettingsSection>
      {/* Under the list only while nothing is open over it. */}
      {opened === null ? <ErrorText>{failure}</ErrorText> : null}
      <Sheet
        onOpenChange={(next) => {
          if (!next) {
            setOpened(null);
          }
        }}
        open={open !== undefined || opened?.kind === "new"}
      >
        <SheetContent
          className="overflow-y-auto"
          closeLabel={t`Close`}
          size="wide"
        >
          {open === undefined ? null : (
            <AgentPanel
              agent={open}
              can={can}
              change={change}
              editable={editable}
              first={open.id === first?.id}
              people={people}
              settings={settings[open.id]}
              teams={teams}
              wakes={wakes[open.id] ?? noWakes}
            />
          )}
          {opened?.kind === "new" ? (
            <>
              <SheetHeader className="mr-8">
                <SheetTitle>
                  <Trans>New agent</Trans>
                </SheetTitle>
                <SheetDescription>
                  <Trans>
                    It starts on, reaching nobody and with nothing it may do.
                    Say whom it answers once it is made.
                  </Trans>
                </SheetDescription>
              </SheetHeader>
              <AgentForm
                can={can}
                initial={{ name: "", job: "", instructions: "" }}
                onSave={async (typed) => {
                  await run(async (session) => {
                    const made = await session.connections.makeAgent({
                      ...typed,
                      face: defaultFace,
                      modelRole: null,
                    });
                    await router.invalidate({ sync: true });
                    setOpened({ kind: "agent", id: made.id });
                  });
                }}
                submit={t`Make agent`}
              />
            </>
          ) : null}
          {/* Why a change wasn't taken, where it was made: the page under
              the sheet is covered while it is open. */}
          {failure === undefined ? null : (
            <div className="bg-background sticky bottom-0 border-t px-5 py-3">
              <ErrorText>{failure}</ErrorText>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
};
