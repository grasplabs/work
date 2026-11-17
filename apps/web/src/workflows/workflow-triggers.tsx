import type {
  ConnectorEventType,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import type { EventSource } from "@grasp-os/shared/event-sources";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
import type { WorkflowTrigger } from "@grasp-os/shared/workflow-triggers";
import {
  triggerEventsRequest,
  triggerStartRequest,
} from "@grasp-os/shared/workflow-triggers";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import type { BadgeTone } from "../grasp/badge/index.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Form, FormRow } from "../grasp/form/index.ts";
import {
  CalendarIcon,
  Cable,
  Link,
  Mail,
  Plus,
  Trash,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { inputSketchOf } from "./start-input.ts";
import { ExpectedInput } from "./start-run.tsx";
import {
  eventLabels,
  eventTypeOf,
  eventTypes,
  summaryOf,
  triggerDescription,
} from "./trigger-description.ts";

// An independent workflow's Triggers, in its Settings (GRA-1303): what starts it on
// its own, as core lists its triggers (`workflowResources.triggers`):
// every one to its builders and the organization's admins, a person's own
// to anyone else. Its builders add a schedule (a cron expression in a time
// zone, with the input each run starts with) or a connection's event (an
// account's new mail or file, with how the event becomes the run's input)
// or an email to an address of its own (a name they choose, as an App's
// email trigger has, or a random one when they leave it empty, with how
// the message becomes the run's input, shown by the part of its address
// before the @), for an exact published version. A trigger acts for whoever made it:
// they alone turn it on again or move it to another version; its builders
// and admins turn it off and delete it (deleting asks first). A schedule
// whose starts kept failing stopped, and says so, with Turn on again for
// its owner. Core decides every change again (trigger-resources.ts) and
// what it refuses is said where it was asked; nothing starts until an
// admin grants the trigger `start` on the workflow, and a connector
// trigger hears nothing until one grants it its event's read on its
// connection; core asks for both as the trigger is created. Each trigger
// says while it waits for either, and once refused offers to ask again
// for whatever was refused. One compact card, a row per trigger with its
// provider's mark where it has one; a new trigger is added in a dialog.
//
// A webhook trigger (GRA-1560) starts on the events of one of the
// workspace's event sources, of one type, chosen by name: an admin makes
// the sources, with their URLs and secrets, in Settings › Incoming events.

/** The provider whose connections report events of `type`. */
const providerOf = (type: ConnectorEventType): string =>
  type.startsWith("m365.") ? "microsoft" : "google";

/** What starts a run of `trigger`, in words. */
const TriggerWhat = ({
  trigger,
  connections,
}: {
  trigger: WorkflowTrigger;
  connections: readonly ListedConnection[];
}) => {
  const summary = summaryOf(trigger);
  const found = connections.find(
    (each) => each.id === summary.connection?.connectionId
  );
  return triggerDescription(summary, {
    accountName: found?.accountName ?? found?.provider,
    address: trigger.address,
  });
};

const styles = stylex.create({
  triggers: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  // Under a row's title: its version and state, and what it waits for.
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space2,
    paddingTop: grasp.space1,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space1,
  },
});

/** Whether a name is a brand's key. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);

/**
 * The brand of what `trigger` listens to: a connection's provider, or a
 * webhook source named after a brand Grasp has a mark for ("Stripe").
 */
const brandOf = (trigger: WorkflowTrigger): Brand | undefined => {
  const { event, source } = summaryOf(trigger);
  const type = event === null ? undefined : eventTypeOf(event);
  if (trigger.kind === "connector" && type !== undefined) {
    const provider = providerOf(type);
    return isBrand(provider) ? provider : undefined;
  }
  const name = source?.name.trim().toLowerCase() ?? "";
  return trigger.kind === "webhook" && isBrand(name) ? name : undefined;
};

/** The kind of trigger's icon, where no brand stands for it. */
const kindIcons: Record<WorkflowTrigger["kind"], IconData> = {
  schedule: CalendarIcon,
  email: Mail,
  webhook: Link,
  connector: Cable,
};

/** A trigger's mark: its brand's, else its kind's icon. */
const TriggerMark = ({ trigger }: { trigger: WorkflowTrigger }) => {
  const brand = brandOf(trigger);
  if (brand === undefined) {
    return <ItemMedia icon={kindIcons[trigger.kind]} iconLook="inline" />;
  }
  return (
    <ItemMedia>
      <BrandIcon brand={brand} decorative size="md" tile={false} />
    </ItemMedia>
  );
};

/**
 * Where `trigger` stands: off, stopped, or when it next starts a run. Off
 * wins: a stopped trigger someone turned off says so, not that it stopped.
 */
const TriggerState = ({ trigger }: { trigger: WorkflowTrigger }) => {
  const { t } = useLingui();
  if (!trigger.enabled) {
    return (
      <Badge size="sm">
        {t({ message: "Off", context: "a trigger that is turned off" })}
      </Badge>
    );
  }
  if (trigger.stopped) {
    return (
      <Badge size="sm" tone="attention">
        {t`Stopped`}
      </Badge>
    );
  }
  const next =
    trigger.nextAt === null ? undefined : formatDateTime(trigger.nextAt);
  return next === undefined ? (
    <Badge size="sm" tone="success">
      {t({ message: "On", context: "a trigger that is turned on" })}
    </Badge>
  ) : (
    t`Next run: ${next}`
  );
};

/** A permission a trigger asks an admin for, and where it stands. */
interface Asked {
  what: "start" | "events";
  status: WorkflowTrigger["start"];
}

/** What waiting for, being refused or never asking for `what` means, in words. */
const askedTexts = {
  start: {
    requested: msg`It starts nothing until an admin allows it to start this workflow.`,
    revoked: msg`An admin refused or took back its start: it starts nothing.`,
    never: msg`No admin has been asked to let it start this workflow: it starts nothing until one allows it.`,
  },
  events: {
    requested: msg`It hears nothing until an admin allows it to read these events on its connection.`,
    revoked: msg`An admin refused or took back its reading of these events: it hears nothing.`,
    never: msg`No admin has been asked to let it read these events on its connection: it hears nothing until one allows it.`,
  },
} as const satisfies Record<
  Asked["what"],
  Record<"requested" | "revoked" | "never", MessageDescriptor>
>;

/** Each status of a permission not granted, as its badge says it. */
const askedBadge = (
  status: Asked["status"]
): { tone: BadgeTone; words: MessageDescriptor } => {
  if (status === "requested") {
    return { tone: "attention", words: msg`Waiting for an admin` };
  }
  // Never asked (a trigger made before triggers asked as they were
  // created): nobody refused it, so it isn't said to be refused.
  if (status === null) {
    return { tone: "attention", words: msg`Not requested yet` };
  }
  return { tone: "danger", words: msg`Not allowed` };
};

/** Where one of a trigger's permissions that isn't granted stands. */
const AskedLine = ({ what, status }: Asked) => {
  const { t } = useLingui();
  const { tone, words } = askedBadge(status);
  let text: MessageDescriptor = askedTexts[what].revoked;
  if (status === "requested") {
    text = askedTexts[what].requested;
  } else if (status === null) {
    text = askedTexts[what].never;
  }
  return (
    <span {...stylex.props(styles.line)}>
      <Badge size="sm" tone={tone}>
        {t(words)}
      </Badge>
      <Text element="span" size="sm" tone="muted">
        {t(text)}
      </Text>
    </span>
  );
};

/**
 * What `trigger` asks an admin for as it is created: to start its
 * workflow, and for a connector trigger to read its event on its
 * connection. Each it holds says nothing; each else says that it waits,
 * was refused or taken back, or was never asked. Whoever manages it may
 * ask again for each refused or never asked, at once (`onAsk`).
 */
const TriggerAccess = ({
  asked,
  manages,
  busy,
  onAsk,
}: {
  asked: readonly Asked[];
  manages: boolean;
  busy: boolean;
  onAsk: () => void;
}) => {
  const { t } = useLingui();
  const open = asked.filter(({ status }) => status !== "active");
  if (open.length === 0) {
    return null;
  }
  const refused = open.some(({ status }) => status === "revoked");
  const askable = open.some(
    ({ status }) => status === "revoked" || status === null
  );
  return (
    <>
      {open.map(({ what, status }) => (
        <AskedLine key={what} status={status} what={what} />
      ))}
      {manages && askable ? (
        <Button disabled={busy} onClick={onAsk} size="xs" variant="quiet">
          {refused
            ? t`Request again`
            : t({
                message: "Request",
                context: "ask an admin to let a trigger start",
              })}
        </Button>
      ) : null}
    </>
  );
};

/** What `trigger` asks an admin for, and where each stands. */
const askedOf = (trigger: WorkflowTrigger): Asked[] => [
  { what: "start", status: trigger.start },
  ...(trigger.kind === "connector"
    ? [{ what: "events" as const, status: trigger.events }]
    : []),
];

/**
 * The requests that ask again for what `trigger` was refused or never
 * asked for, under the names it asked with as it was created: a refused
 * or revoked one no longer holds them.
 */
const requestsAgain = (trigger: WorkflowTrigger): PermissionRequest[] =>
  askedOf(trigger).flatMap(({ what, status }) => {
    if (status !== "revoked" && status !== null) {
      return [];
    }
    if (what === "start") {
      return [triggerStartRequest(trigger.id, trigger.workflowId)];
    }
    const { connection, event } = summaryOf(trigger);
    const request =
      connection === null || event === null
        ? undefined
        : triggerEventsRequest(
            trigger.id,
            {
              connectionId: connection.connectionId,
              resource: connection.resource ?? undefined,
            },
            event
          );
    return request === undefined ? [] : [request];
  });

/** What a row's change asks of core's triggers. */
type TriggersApi = Parameters<
  Parameters<ReturnType<typeof useCoreAction>["run"]>[0]
>[0]["workflowResources"]["triggers"];

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

  // Whether core made the change; read again whatever came of it, as a
  // change core made can still fail as it reads the trigger back.
  const change = async (
    action: (triggers: TriggersApi) => Promise<unknown>
  ): Promise<boolean> => {
    const done = await run(async (session) => {
      await action(session.workflowResources.triggers);
      return true;
    });
    await onChanged();
    return done === true;
  };

  const askAgain = async (): Promise<void> => {
    await run(async (session) => {
      for (const request of requestsAgain(trigger)) {
        // oxlint-disable-next-line no-await-in-loop -- one request after another, as an admin sees them
        await session.permissions.request(request);
      }
    });
    await onChanged();
  };

  const deleted = async (): Promise<void> => {
    const done = await change(async (triggers) => {
      await triggers.delete(trigger.id);
    });
    if (!done) {
      // The dialog stays open; why is said in the row.
      throw new Error("It wasn't deleted.");
    }
  };

  return (
    <Item size="sm">
      <TriggerMark trigger={trigger} />
      <ItemContent>
        <ItemTitle>
          <TriggerWhat connections={connections} trigger={trigger} />
        </ItemTitle>
        <ItemDescription>
          {/* Each in its own box: two runs of text side by side would
              merge into one and lose the gap between them. */}
          <span {...stylex.props(styles.line)}>
            <span>{t`Starts version ${workflowVersion}`}</span>
            <span aria-hidden="true">·</span>
            <span>
              <TriggerState trigger={trigger} />
            </span>
          </span>
        </ItemDescription>
        <div {...stylex.props(styles.lines)}>
          {trigger.stopped ? (
            <Text element="span" size="sm" tone="muted">
              {t`Its runs kept failing to start, so it starts no more until whoever made it turns it on again.`}
            </Text>
          ) : null}
          {trigger.source?.deleted === true ? (
            <Text element="span" size="sm" tone="muted">
              {t`Its source was deleted, so it starts nothing: delete it, or add a trigger on another source.`}
            </Text>
          ) : null}
          <TriggerAccess
            asked={askedOf(trigger)}
            busy={busy}
            manages={manages}
            onAsk={() => {
              void askAgain();
            }}
          />
          <ErrorText>{failure}</ErrorText>
        </div>
      </ItemContent>
      {manages ? (
        <ItemActions>
          <div {...stylex.props(styles.actions)}>
            {/* Turning it on runs it as its owner, so core asks them to
                build the workflow still; turning off and deleting don't. */}
            {own && builder && (trigger.stopped || !trigger.enabled) ? (
              <Button
                disabled={busy}
                onClick={() => {
                  void change(
                    async (triggers) =>
                      await triggers.setEnabled(trigger.id, true)
                  );
                }}
                size="sm"
                variant="quiet"
              >
                {trigger.stopped ? t`Turn on again` : t`Turn on`}
              </Button>
            ) : null}
            {/* A stopped trigger is still on in core: turned off, it stays
                off once someone turns it on again elsewhere. */}
            {trigger.enabled ? (
              <Button
                disabled={busy}
                onClick={() => {
                  void change(
                    async (triggers) =>
                      await triggers.setEnabled(trigger.id, false)
                  );
                }}
                size="sm"
                variant="quiet"
              >
                {t({ message: "Turn off", context: "turn a trigger off" })}
              </Button>
            ) : null}
            {own && builder && versions.length > 1 ? (
              <Select
                disabled={busy}
                items={versions.map((version) => ({
                  value: String(version),
                  label: t`Version ${version}`,
                }))}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (value !== null && next !== workflowVersion) {
                    void change(
                      async (triggers) =>
                        await triggers.setVersion(trigger.id, next)
                    );
                  }
                }}
                value={String(workflowVersion)}
              >
                <SelectTrigger
                  aria-label={t`Version it starts`}
                  size="sm"
                  variant="text"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger
                disabled={busy}
                icon={Trash}
                size="sm"
                variant="ghost"
              >
                {t({ message: "Delete", context: "delete a trigger" })}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>{t`Delete this trigger?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`It starts no more runs. Runs it already started go on. This can't be undone.`}
                </AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                  <AlertDialogAction
                    action={deleted}
                    failedLabel={t`Not deleted`}
                    variant="danger"
                  >
                    {t`Delete the trigger`}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </ItemActions>
      ) : null}
    </Item>
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

/** The kinds of trigger a builder adds here. */
const addedKinds = ["schedule", "connector", "email", "webhook"] as const;

type AddedKind = (typeof addedKinds)[number];

/** The kinds of trigger a builder adds here, in words. */
const kindLabels = {
  schedule: msg`A schedule`,
  connector: msg`An event at a connection`,
  email: msg`An email to its own address`,
  webhook: msg`An event from a webhook source`,
} as const satisfies Record<AddedKind, MessageDescriptor>;

/**
 * The input's shape, for the version new runs run, to start a schedule's
 * JSON from; undefined when it can't be read, and the JSON starts empty.
 */
const startFormOf = async (
  core: CoreConnection,
  workflow: string
): Promise<WorkflowStartForm | undefined> => {
  try {
    return await core.withSession(
      async (session) => await session.workflowResources.startForm(workflow)
    );
  } catch {
    return undefined;
  }
};

/**
 * A new trigger, for a builder, in a dialog: a schedule, a connection's
 * event, an email or an event from a webhook source, for one version.
 * What is typed stays while the list behind it is read again, and when
 * the dialog closes without adding.
 */
const AddTrigger = ({
  workflow,
  versions,
  connections,
  sources,
  onAdded,
}: {
  workflow: string;
  versions: readonly number[];
  connections: readonly ListedConnection[];
  sources: readonly EventSource[];
  onAdded: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [shape, setShape] = useState<WorkflowStartForm>();
  const [problem, setProblem] = useState<string>();
  const [kind, setKind] = useState<AddedKind>("schedule");
  const [chosen, setChosen] = useState(versions.at(-1) ?? 1);
  const [cron, setCron] = useState("");
  const [timeZone, setTimeZone] = useState(ownTimeZone);
  const [input, setInput] = useState("{}");
  const [event, setEvent] = useState<ConnectorEventType>("m365.mail.received");
  const [connection, setConnection] = useState("");
  const [resource, setResource] = useState("");
  const [mapping, setMapping] = useState("{}");
  const [address, setAddress] = useState("");
  const [source, setSource] = useState("");
  const [sourceType, setSourceType] = useState("");
  // The shape is known for the version new runs run, so only for it.
  const sketch =
    shape !== undefined && shape.version === chosen
      ? inputSketchOf(shape.args)
      : undefined;
  /** Opens the dialog, and starts an input not typed yet from the shape. */
  const opened = async (): Promise<void> => {
    setOpen(true);
    const given = await startFormOf(core, workflow);
    setShape(given);
    const next = given === undefined ? undefined : inputSketchOf(given.args);
    if (next !== undefined && given?.version === chosen) {
      setInput((typed) => (typed === "{}" ? next.json : typed));
    }
  };
  const reporting = connections.filter(
    (each) =>
      each.source === "native" &&
      each.status === "active" &&
      each.provider === providerOf(event)
  );

  const configOf = (): unknown => {
    // Each event's data is its run's input, as is.
    if (kind === "webhook") {
      if (source === "") {
        setProblem(t`Choose a source.`);
        return undefined;
      }
      return { source, type: sourceType.trim() };
    }
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
    if (kind === "email") {
      // Without a name, core gives it a random address of its own.
      const name = address.trim();
      return {
        input: { fields: fields.value, defaults: {} },
        ...(name === "" ? {} : { address: name }),
      };
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
      setInput(sketch?.json ?? "{}");
      setMapping("{}");
      setAddress("");
      setSourceType("");
      setOpen(false);
    }
    // Read again however it ended, as the rows' own changes are: a trigger
    // core saved before its answer was lost shows, rather than being added
    // twice on a retry.
    await onAdded();
  };

  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          void opened();
        }}
        size="sm"
      >
        {t`Add a trigger`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Add a trigger`}</DialogTitle>
          <DialogBody>
            <Form
              id={formId}
              onSubmit={(submitted) => {
                submitted.preventDefault();
                void add();
              }}
            >
              <FormRow>
                <Field>
                  <FieldLabel>{t`What starts it`}</FieldLabel>
                  <Select
                    items={addedKinds.map((each) => ({
                      value: each,
                      label: t(kindLabels[each]),
                    }))}
                    onValueChange={(value) => {
                      setKind(
                        addedKinds.find((each) => each === value) ?? "schedule"
                      );
                    }}
                    value={kind}
                  />
                </Field>
                <Field>
                  <FieldLabel>{t`Version it starts`}</FieldLabel>
                  <Select
                    items={versions.map((version) => ({
                      value: String(version),
                      label: t`Version ${version}`,
                    }))}
                    onValueChange={(value) => {
                      setChosen(Number(value));
                    }}
                    value={String(chosen)}
                  />
                </Field>
              </FormRow>
              {kind === "schedule" ? (
                <>
                  <FormRow>
                    <Field>
                      <FieldLabel>{t`When, as a cron expression`}</FieldLabel>
                      <Input
                        onValueChange={setCron}
                        placeholder="0 9 * * 1-5"
                        spellCheck={false}
                        value={cron}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{t`Time zone`}</FieldLabel>
                      <Input
                        onValueChange={setTimeZone}
                        spellCheck={false}
                        value={timeZone}
                      />
                    </Field>
                  </FormRow>
                  <Field>
                    <FieldLabel>
                      {t`The input each run starts with, as JSON`}
                    </FieldLabel>
                    <Textarea
                      onValueChange={setInput}
                      spellCheck={false}
                      value={input}
                    />
                    {sketch === undefined ? null : (
                      <ExpectedInput keys={sketch.keys} />
                    )}
                  </Field>
                </>
              ) : null}
              {kind === "email" ? (
                <>
                  <Field>
                    <FieldLabel>{t`Address, the part before the @`}</FieldLabel>
                    <Input
                      autoCapitalize="none"
                      onValueChange={setAddress}
                      placeholder="invoices"
                      spellCheck={false}
                      value={address}
                    />
                    <FieldDescription>
                      {t`Lower case letters, digits, dots, dashes, underscores and plus signs. Leave it empty for a random address of its own, which is harder to guess.`}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel>
                      {t`The run's input fields, each from the message as a JSON Pointer, as JSON`}
                    </FieldLabel>
                    <Textarea
                      onValueChange={setMapping}
                      placeholder='{ "subject": "/subject", "from": "/from/address", "attachments": "/attachments" }'
                      spellCheck={false}
                      value={mapping}
                    />
                  </Field>
                </>
              ) : null}
              {kind === "connector" ? (
                <>
                  <FormRow>
                    <Field>
                      <FieldLabel>{t`Event`}</FieldLabel>
                      <Select
                        items={eventTypes.map((type) => ({
                          value: type,
                          label: t(eventLabels[type]),
                        }))}
                        onValueChange={(value) => {
                          const type = eventTypeOf(value ?? "");
                          if (type !== undefined) {
                            setEvent(type);
                            setConnection("");
                          }
                        }}
                        value={event}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{t`Connection`}</FieldLabel>
                      <Select
                        items={reporting.map((each) => ({
                          value: each.id,
                          label: each.accountName ?? each.provider,
                        }))}
                        onValueChange={(value) => {
                          setConnection(value ?? "");
                        }}
                        value={connection === "" ? null : connection}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t`Choose…`} />
                        </SelectTrigger>
                        <SelectContent />
                      </Select>
                    </Field>
                  </FormRow>
                  <Field>
                    <FieldLabel>
                      {t`Mailbox or drive, if not the account's own`}
                    </FieldLabel>
                    <Input
                      onValueChange={setResource}
                      spellCheck={false}
                      value={resource}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>
                      {t`The run's input fields, each from the event as a JSON Pointer, as JSON`}
                    </FieldLabel>
                    <Textarea
                      onValueChange={setMapping}
                      placeholder='{ "subject": "/payload/subject" }'
                      spellCheck={false}
                      value={mapping}
                    />
                  </Field>
                </>
              ) : null}
              {kind === "webhook" ? (
                <>
                  <FormRow>
                    <Field>
                      <FieldLabel>{t`Source`}</FieldLabel>
                      <Select
                        items={sources.map((each) => ({
                          value: each.id,
                          label: each.name,
                        }))}
                        onValueChange={(value) => {
                          setSource(value ?? "");
                        }}
                        value={source === "" ? null : source}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t`Choose…`} />
                        </SelectTrigger>
                        <SelectContent />
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>{t`Event type`}</FieldLabel>
                      <Input
                        onValueChange={setSourceType}
                        placeholder="payment.paid"
                        spellCheck={false}
                        value={sourceType}
                      />
                    </Field>
                  </FormRow>
                  <Text size="sm" tone="muted">
                    {sources.length === 0
                      ? t`No webhook source yet: an admin adds one in Settings, with the URL and secret its sender uses.`
                      : t`Each event of this type from the source starts a run, with its data as the input.`}
                  </Text>
                </>
              ) : null}
              <ErrorText>{problem ?? failure}</ErrorText>
            </Form>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button disabled={busy} form={formId} type="submit" variant="ink">
              {t`Add the trigger`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** What the tab read from core. */
interface Read {
  triggers: WorkflowTrigger[];
  versions: number[];
  connections: ListedConnection[];
  /** The workspace's webhook sources, for a builder to add a trigger on. */
  sources: EventSource[];
  /** Why the connections couldn't be read: its rows name a connection by its id then. */
  connectionsFailure?: string;
}

/**
 * The connections Connect lists, asked only for the accounts' names: when
 * it can't answer, none, and why, so the triggers still show, by
 * connection id.
 */
const accountsOf = async (
  list: () => Promise<ListedConnection[]>
): Promise<Pick<Read, "connections" | "connectionsFailure">> => {
  try {
    return { connections: await list() };
  } catch (error) {
    return { connections: [], connectionsFailure: failureText(error) };
  }
};

/**
 * Workflow `workflow`'s triggers, read as it mounts and again for each
 * `generation`, which a change asks for with `onChanged`. The list shown
 * stays until the next read is in, so the Add dialog keeps what was typed.
 */
const TriggersRead = ({
  workflow,
  me,
  builder,
  generation,
  onChanged,
}: {
  workflow: string;
  me: string;
  builder: boolean;
  generation: number;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [read, setRead] = useState<Read>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let stopped = false;
    const readAll = async (): Promise<void> => {
      try {
        const [triggers, versions, sources, accounts] = await core.withSession(
          async (session) =>
            await Promise.all([
              session.workflowResources.triggers.list(workflow),
              builder
                ? session.workflowResources.versions(workflow)
                : Promise.resolve([]),
              builder
                ? session.workflowResources.sources.list()
                : Promise.resolve([]),
              accountsOf(async () => await session.connections.list()),
            ])
        );
        if (!stopped) {
          setFailure(undefined);
          setRead({
            triggers,
            versions: versions
              .map(({ version }) => version)
              .toSorted((a, b) => a - b),
            sources,
            ...accounts,
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `generation` says when to read again
  }, [builder, core, generation, workflow]);

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
      <ErrorText>{read.connectionsFailure}</ErrorText>
      <SectionCard
        aria-label={t`Triggers`}
        density="compact"
        flush
        {...(builder && read.versions.length > 0
          ? {
              footer: (
                <AddTrigger
                  connections={read.connections}
                  onAdded={changed}
                  sources={read.sources}
                  versions={read.versions}
                  workflow={workflow}
                />
              ),
            }
          : {})}
      >
        {read.triggers.length === 0 ? (
          <Empty size="inline">{t`Nothing starts it on its own yet.`}</Empty>
        ) : (
          <ItemGroup separated>
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
          </ItemGroup>
        )}
      </SectionCard>
    </>
  );
};

/** Workflow `workflow`'s triggers, in its Settings, for `me`, who builds it when `builder`. */
export const WorkflowTriggers = ({
  workflow,
  me,
  builder,
}: {
  workflow: string;
  me: string;
  builder: boolean;
}) => {
  const { t } = useLingui();
  // One more each time a change asks for the triggers to be read again.
  const [generation, setGeneration] = useState(0);
  return (
    <div {...stylex.props(styles.triggers)}>
      <Text size="sm" tone="muted">
        {t`A trigger starts a run on its own, as whoever made it. Adding one asks an admin to allow it to start this workflow, and one on a connection to read its events there: it starts nothing until they do.`}
      </Text>
      <TriggersRead
        builder={builder}
        // Read again, as core has them now, after each change.
        generation={generation}
        me={me}
        onChanged={() => {
          setGeneration((current) => current + 1);
        }}
        workflow={workflow}
      />
    </div>
  );
};
