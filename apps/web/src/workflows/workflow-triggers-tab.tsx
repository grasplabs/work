import type {
  ConnectorEventType,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { connectorEventActions } from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowTrigger } from "@grasp-os/shared/workflow-triggers";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { TabsContent, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Textarea } from "@grasp-os/ui/components/textarea";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CalendarClockIcon, PlugIcon, ZapIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// An independent workflow's Triggers tab (GRA-1303): what starts it on
// its own, as core lists its triggers (`workflowResources.triggers`):
// every one to its builders and the organization's admins, a person's own
// to anyone else. Its builders add a schedule (a cron expression in a time
// zone, with the input each run starts with) or a connection's event (an
// account's new mail or file, with how the event becomes the run's input),
// for an exact published version. A trigger acts for whoever made it:
// they alone turn it on again or move it to another version; its builders
// and admins turn it off and delete it (deleting asks first). A schedule
// whose starts kept failing stopped, and says so, with Turn on again for
// its owner. Core decides every change again (trigger-resources.ts) and
// what it refuses is said where it was asked; nothing starts until an
// admin grants the trigger `start` on the workflow.

/** The provider whose connections report events of `type`. */
const providerOf = (type: ConnectorEventType): string =>
  type.startsWith("m365.") ? "microsoft" : "google";

const eventTypes = Object.keys(connectorEventActions).filter(
  (type): type is ConnectorEventType =>
    Object.hasOwn(connectorEventActions, type)
);

/** `value` as a connector event type, if it is one. */
const eventTypeOf = (value: unknown): ConnectorEventType | undefined =>
  eventTypes.find((type) => type === value);

/** Each event type, in words. */
const eventLabels = {
  "m365.mail.received": msg`New mail in Microsoft 365`,
  "m365.file.created": msg`A new file in Microsoft 365`,
  "google.mail.received": msg`New mail in Google`,
  "google.file.created": msg`A new file in Google Drive`,
} as const satisfies Record<ConnectorEventType, MessageDescriptor>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field of `config` at `path`, if it is text. */
const textAt = (config: unknown, ...path: string[]): string | undefined => {
  let node: unknown = config;
  for (const key of path) {
    node = isRecord(node) ? node[key] : undefined;
  }
  return typeof node === "string" ? node : undefined;
};

/** What starts a run of `trigger`, in words. */
const TriggerWhat = ({
  trigger,
  connections,
}: {
  trigger: WorkflowTrigger;
  connections: readonly ListedConnection[];
}) => {
  const { t } = useLingui();
  const { config } = trigger;
  if (trigger.kind === "schedule") {
    const cron = textAt(config, "schedule", "cron") ?? "";
    const zone = textAt(config, "schedule", "timeZone") ?? "";
    return (
      <Trans>
        On the schedule <code className="font-mono">{cron}</code>, in {zone}
      </Trans>
    );
  }
  if (trigger.kind === "connector") {
    const type = eventTypeOf(textAt(config, "event"));
    const id = textAt(config, "connection", "connectionId");
    const found = connections.find((each) => each.id === id);
    const account = found?.accountName ?? found?.provider ?? id ?? "";
    if (type === undefined) {
      return <Trans>When {account} reports an event</Trans>;
    }
    const event = t(eventLabels[type]);
    return (
      <Trans>
        {event}, at {account}
      </Trans>
    );
  }
  if (trigger.kind === "system") {
    const type = textAt(config, "event", "type") ?? "";
    return <Trans>When the event {type} is sent</Trans>;
  }
  return <Trans>When its webhook is called</Trans>;
};

/** The kind of trigger's icon. */
const KindIcon = ({ kind }: { kind: WorkflowTrigger["kind"] }) => {
  if (kind === "schedule") {
    return <CalendarClockIcon aria-hidden="true" className="mt-0.5 size-4" />;
  }
  return kind === "connector" ? (
    <PlugIcon aria-hidden="true" className="mt-0.5 size-4" />
  ) : (
    <ZapIcon aria-hidden="true" className="mt-0.5 size-4" />
  );
};

/** Where `trigger` stands: stopped, off, or when it next starts a run. */
const TriggerState = ({ trigger }: { trigger: WorkflowTrigger }) => {
  if (trigger.stopped) {
    return (
      <Badge variant="attention">
        <Trans>Stopped</Trans>
      </Badge>
    );
  }
  if (!trigger.enabled) {
    return (
      <Badge variant="outline">
        <Trans context="a trigger that is turned off">Off</Trans>
      </Badge>
    );
  }
  const next =
    trigger.nextAt === null ? undefined : formatDateTime(trigger.nextAt);
  return next === undefined ? (
    <Badge variant="passed">
      <Trans context="a trigger that is turned on">On</Trans>
    </Badge>
  ) : (
    <span className="text-muted-foreground text-xs">
      <Trans>Next run: {next}</Trans>
    </span>
  );
};

/** One trigger: what starts it, its version, where it stands, and what the reader may change. */
const TriggerRow = ({
  trigger,
  connections,
  versions,
  me,
  builder,
  onChanged,
}: {
  trigger: WorkflowTrigger;
  connections: readonly ListedConnection[];
  versions: readonly number[];
  me: string;
  builder: boolean;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const own = trigger.owner === me;
  const manages = own || builder;
  const { workflowVersion } = trigger;

  const change = async (
    action: (
      triggers: Parameters<
        Parameters<typeof run>[0]
      >[0]["workflowResources"]["triggers"]
    ) => Promise<unknown>
  ): Promise<void> => {
    const done = await run(async (session) => {
      await action(session.workflowResources.triggers);
      return true;
    });
    if (done === true) {
      await onChanged();
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <KindIcon kind={trigger.kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium">
            <TriggerWhat connections={connections} trigger={trigger} />
          </span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Trans>Starts version {workflowVersion}</Trans>
            <TriggerState trigger={trigger} />
          </span>
          {trigger.stopped ? (
            <span className="text-muted-foreground text-sm">
              <Trans>
                Its runs kept failing to start, so it starts no more until
                whoever made it turns it on again.
              </Trans>
            </span>
          ) : null}
        </span>
      </div>
      {manages ? (
        <div className="flex flex-wrap items-center gap-2 pl-7">
          {own && (trigger.stopped || !trigger.enabled) ? (
            <Button
              disabled={busy}
              onClick={() => {
                void change(
                  async (triggers) =>
                    await triggers.setEnabled(trigger.id, true)
                );
              }}
              size="sm"
              variant="outline"
            >
              {trigger.stopped ? t`Turn on again` : t`Turn on`}
            </Button>
          ) : null}
          {trigger.enabled && !trigger.stopped ? (
            <Button
              disabled={busy}
              onClick={() => {
                void change(
                  async (triggers) =>
                    await triggers.setEnabled(trigger.id, false)
                );
              }}
              size="sm"
              variant="outline"
            >
              <Trans context="turn a trigger off">Turn off</Trans>
            </Button>
          ) : null}
          {own && builder && versions.length > 1 ? (
            <NativeSelect
              aria-label={t`Version it starts`}
              disabled={busy}
              onChange={(event) => {
                const next = Number(event.target.value);
                void change(
                  async (triggers) =>
                    await triggers.setVersion(trigger.id, next)
                );
              }}
              size="sm"
              value={String(workflowVersion)}
            >
              {versions.map((version) => (
                <NativeSelectOption key={version} value={String(version)}>
                  {t`Version ${version}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger
              disabled={busy}
              render={<Button size="sm" variant="ghost" />}
            >
              <Trans context="delete a trigger">Delete</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Delete this trigger?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    It starts no more runs. Runs it already started go on. This
                    can&apos;t be undone.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void change(async (triggers) => {
                      await triggers.delete(trigger.id);
                    });
                  }}
                  variant="destructive"
                >
                  <Trans>Delete the trigger</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/** JSON typed into a field, or why it isn't. */
const jsonOf = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
};

/** The person's own time zone, as the browser has it. */
const ownTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A new trigger, for a builder: a schedule or a connection's event, for one version. */
const AddTrigger = ({
  workflow,
  versions,
  connections,
  onAdded,
}: {
  workflow: string;
  versions: readonly number[];
  connections: readonly ListedConnection[];
  onAdded: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [kind, setKind] = useState<"schedule" | "connector">("schedule");
  const [chosen, setChosen] = useState(versions.at(-1) ?? 1);
  const [cron, setCron] = useState("");
  const [timeZone, setTimeZone] = useState(ownTimeZone);
  const [input, setInput] = useState("{}");
  const [event, setEvent] = useState<ConnectorEventType>("m365.mail.received");
  const [connection, setConnection] = useState("");
  const [resource, setResource] = useState("");
  const [mapping, setMapping] = useState("{}");
  const reporting = connections.filter(
    (each) =>
      each.source === "native" &&
      each.status === "active" &&
      each.provider === providerOf(event)
  );

  const configOf = (): unknown => {
    if (kind === "schedule") {
      const parsed = jsonOf(input);
      if (!parsed.ok) {
        setProblem(t`The input isn't JSON.`);
        return undefined;
      }
      return {
        schedule: { cron: cron.trim(), timeZone: timeZone.trim() },
        input: parsed.value,
        missedOccurrences: "coalesce",
      };
    }
    const fields = jsonOf(mapping);
    if (!fields.ok) {
      setProblem(t`The input fields aren't JSON.`);
      return undefined;
    }
    if (connection === "") {
      setProblem(t`Choose a connection.`);
      return undefined;
    }
    return {
      connection: {
        connectionId: connection,
        ...(resource.trim() === "" ? {} : { resource: resource.trim() }),
      },
      event,
      input: { fields: fields.value, defaults: {} },
    };
  };

  const add = async (): Promise<void> => {
    setProblem(undefined);
    const config = configOf();
    if (config === undefined) {
      return;
    }
    const created = await run(
      async (session) =>
        await session.workflowResources.triggers.create({
          kind,
          workflowId: workflow,
          version: chosen,
          config,
        })
    );
    if (created !== undefined) {
      setCron("");
      setInput("{}");
      setMapping("{}");
      await onAdded();
    }
  };

  return (
    <form
      className="bg-card flex flex-col gap-4 rounded-xl border p-4"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void add();
      }}
    >
      <h3 className="font-medium">
        <Trans>Add a trigger</Trans>
      </h3>
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-kind`}>
            <Trans>What starts it</Trans>
          </Label>
          <NativeSelect
            id={`${ids}-kind`}
            onChange={(changed) => {
              setKind(
                changed.target.value === "connector" ? "connector" : "schedule"
              );
            }}
            value={kind}
          >
            <NativeSelectOption value="schedule">{t`A schedule`}</NativeSelectOption>
            <NativeSelectOption value="connector">
              {t`An event at a connection`}
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-version`}>
            <Trans>Version it starts</Trans>
          </Label>
          <NativeSelect
            id={`${ids}-version`}
            onChange={(changed) => {
              setChosen(Number(changed.target.value));
            }}
            value={String(chosen)}
          >
            {versions.map((version) => (
              <NativeSelectOption key={version} value={String(version)}>
                {t`Version ${version}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {kind === "schedule" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-cron`}>
                <Trans>When, as a cron expression</Trans>
              </Label>
              <Input
                id={`${ids}-cron`}
                onChange={(changed) => {
                  setCron(changed.target.value);
                }}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                value={cron}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-zone`}>
                <Trans>Time zone</Trans>
              </Label>
              <Input
                id={`${ids}-zone`}
                onChange={(changed) => {
                  setTimeZone(changed.target.value);
                }}
                spellCheck={false}
                value={timeZone}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-input`}>
              <Trans>The input each run starts with, as JSON</Trans>
            </Label>
            <Textarea
              id={`${ids}-input`}
              onChange={(changed) => {
                setInput(changed.target.value);
              }}
              spellCheck={false}
              value={input}
              variant="code"
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-event`}>
                <Trans>Event</Trans>
              </Label>
              <NativeSelect
                id={`${ids}-event`}
                onChange={(changed) => {
                  const type = eventTypeOf(changed.target.value);
                  if (type !== undefined) {
                    setEvent(type);
                    setConnection("");
                  }
                }}
                value={event}
              >
                {eventTypes.map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {t(eventLabels[type])}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-connection`}>
                <Trans>Connection</Trans>
              </Label>
              <NativeSelect
                id={`${ids}-connection`}
                onChange={(changed) => {
                  setConnection(changed.target.value);
                }}
                value={connection}
              >
                <NativeSelectOption value="">{t`Choose…`}</NativeSelectOption>
                {reporting.map((each) => (
                  <NativeSelectOption key={each.id} value={each.id}>
                    {each.accountName ?? each.provider}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-resource`}>
                <Trans>Mailbox or drive, if not the account&apos;s own</Trans>
              </Label>
              <Input
                id={`${ids}-resource`}
                onChange={(changed) => {
                  setResource(changed.target.value);
                }}
                spellCheck={false}
                value={resource}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-mapping`}>
              <Trans>
                The run&apos;s input fields, each from the event as a JSON
                Pointer, as JSON
              </Trans>
            </Label>
            <Textarea
              id={`${ids}-mapping`}
              onChange={(changed) => {
                setMapping(changed.target.value);
              }}
              placeholder='{ "subject": "/payload/subject" }'
              spellCheck={false}
              value={mapping}
              variant="code"
            />
          </div>
        </div>
      )}
      <ErrorText>{problem ?? failure}</ErrorText>
      <div>
        <Button disabled={busy} size="sm" type="submit">
          <Trans>Add the trigger</Trans>
        </Button>
      </div>
    </form>
  );
};

/** What the tab read from core. */
interface Read {
  triggers: WorkflowTrigger[];
  versions: number[];
  connections: ListedConnection[];
}

/** The tab's own trigger, beside the page's others. */
export const TriggersTabTrigger = () => (
  <TabsTrigger value="triggers">
    <Trans context="tab of a workflow">Triggers</Trans>
  </TabsTrigger>
);

/** Workflow `workflow`'s triggers, read once as it mounts; a change asks for `onChanged`. */
const TriggersRead = ({
  workflow,
  me,
  builder,
  onChanged,
}: {
  workflow: string;
  me: string;
  builder: boolean;
  onChanged: () => void;
}) => {
  const core = useCore();
  const [read, setRead] = useState<Read>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let stopped = false;
    const readAll = async (): Promise<void> => {
      try {
        const [triggers, versions, connections] = await core.withSession(
          async (session) =>
            await Promise.all([
              session.workflowResources.triggers.list(workflow),
              builder
                ? session.workflowResources.versions(workflow)
                : Promise.resolve([]),
              session.connections.list(),
            ])
        );
        if (!stopped) {
          setRead({
            triggers,
            versions: versions
              .map(({ version }) => version)
              .toSorted((a, b) => a - b),
            connections,
          });
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
        }
      }
    };
    void readAll();
    return () => {
      stopped = true;
    };
  }, [builder, core, workflow]);

  const changed = async (): Promise<void> => {
    onChanged();
    await Promise.resolve();
  };

  if (failure !== undefined) {
    return <ErrorText>{failure}</ErrorText>;
  }
  if (read === undefined) {
    return null;
  }
  return (
    <>
      {read.triggers.length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
          <Trans>Nothing starts it on its own yet.</Trans>
        </p>
      ) : (
        <ul className="bg-card flex flex-col divide-y rounded-xl border">
          {read.triggers.map((trigger) => (
            <TriggerRow
              builder={builder}
              connections={read.connections}
              key={trigger.id}
              me={me}
              onChanged={changed}
              trigger={trigger}
              versions={read.versions}
            />
          ))}
        </ul>
      )}
      {builder && read.versions.length > 0 ? (
        <AddTrigger
          connections={read.connections}
          onAdded={changed}
          versions={read.versions}
          workflow={workflow}
        />
      ) : null}
    </>
  );
};

/** The tab: workflow `workflow`'s triggers, for `me`, who builds it when `builder`. */
export const TriggersTabContent = ({
  workflow,
  me,
  builder,
}: {
  workflow: string;
  me: string;
  builder: boolean;
}) => {
  // One more each time a change asks for the triggers to be read again.
  const [generation, setGeneration] = useState(0);
  return (
    <TabsContent value="triggers">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-6 pb-8">
        <p className="text-muted-foreground">
          <Trans>
            A trigger starts a run on its own, as whoever made it. It starts
            nothing until an admin allows it to start this workflow.
          </Trans>
        </p>
        <TriggersRead
          builder={builder}
          // Read again, as core has them now, after each change.
          key={generation}
          me={me}
          onChanged={() => {
            setGeneration(generation + 1);
          }}
          workflow={workflow}
        />
      </div>
    </TabsContent>
  );
};
