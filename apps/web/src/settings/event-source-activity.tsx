import type {
  EventSource,
  EventSourceDelivery,
  EventSourceDeliveryPage,
  EventSourceRefusals,
  EventSourceTestResult,
  EventSourceTrigger,
} from "@grasp-os/shared/event-sources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CodeBlock } from "@grasp-os/ui/components/code-block";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { Failure } from "./section.tsx";

// What a source received, in its inspector in Settings › Incoming events
// (core's workflows/source-deliveries.ts): when its last event came and
// how many it accepted and refused in the last 24 hours, always; and, once
// opened, why it refused them, its recent deliveries, each payload read on
// its own (core audits that read, so nothing reads one unasked), and a
// test event that says which triggers it matches and starts nothing.

const styles = stylex.create({
  activity: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    padding: space[3],
  },
  summary: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[2],
    rowGap: space[1],
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: space[1],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  delivery: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    paddingBlock: space[1],
  },
  test: { display: "flex", flexDirection: "column", gap: space[2] },
});

/** What an opened source shows: its refusals and its deliveries so far. */
interface Received {
  refusals: readonly EventSourceRefusals[];
  deliveries: readonly EventSourceDelivery[];
  next: string | null;
}

/** Why a source refused deliveries, a line for each reason. */
const Refusals = ({
  refusals,
}: {
  refusals: readonly EventSourceRefusals[];
}) => {
  const { t } = useLingui();
  const lines = refusals.map(({ reason, lastWeek: count }) => {
    switch (reason) {
      case "revoked": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: its secret was revoked.", other: "# deliveries refused in the last seven days: its secret was revoked." })}`;
      }
      case "headers": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: its signing headers were missing or more than five minutes old.", other: "# deliveries refused in the last seven days: their signing headers were missing or more than five minutes old." })}`;
      }
      case "signature": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: it wasn't signed with this source's secret.", other: "# deliveries refused in the last seven days: they weren't signed with this source's secret." })}`;
      }
      case "rotated": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: the secret changed as it arrived.", other: "# deliveries refused in the last seven days: the secret changed as they arrived." })}`;
      }
      case "too_large": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: it was larger than 64 KiB.", other: "# deliveries refused in the last seven days: they were larger than 64 KiB." })}`;
      }
      case "body": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: it was signed, but its body wasn't a JSON object with a type and data.", other: "# deliveries refused in the last seven days: they were signed, but their bodies weren't JSON objects with a type and data." })}`;
      }
      case "conflict": {
        return t`${plural(count, { one: "# delivery refused in the last seven days: its webhook-id came before with another event.", other: "# deliveries refused in the last seven days: their webhook-id came before with another event." })}`;
      }
      case "busy": {
        return t`${plural(count, { one: "# delivery told to try again in the last seven days: a workflow it starts or a run waiting for it couldn't take it then.", other: "# deliveries told to try again in the last seven days: a workflow they start or a run waiting for them couldn't take them then." })}`;
      }
      default: {
        return reason satisfies never;
      }
    }
  });
  return (
    <ul {...stylex.props(styles.lines)}>
      {refusals.map(({ reason }, index) => (
        <li key={reason}>
          <Text as="span" size="sm">
            {lines[index] ?? ""}
          </Text>
        </li>
      ))}
    </ul>
  );
};

/** One delivery: when, its type, what it started, and a way to its payload. */
const DeliveryRow = ({
  delivery,
  busy,
  onPayload,
}: {
  delivery: EventSourceDelivery;
  busy: boolean;
  onPayload: () => void;
}) => {
  const { t } = useLingui();
  const { triggersStarted: started, type } = delivery;
  return (
    <li {...stylex.props(styles.delivery)}>
      <Text as="span" color="muted" size="sm">
        {formatDateTime(delivery.receivedAt)}
      </Text>
      <code>{type}</code>
      {delivery.test ? (
        <Badge size="sm" variant="secondary">
          {t`Test`}
        </Badge>
      ) : (
        <Text as="span" color="muted" size="sm">
          {t`${plural(started, { one: "Started # workflow", other: "Started # workflows" })}`}
        </Text>
      )}
      {delivery.payloadHeld ? (
        <Button
          aria-label={t`Show the payload of ${type}`}
          disabled={busy}
          onClick={onPayload}
          size="xs"
          variant="ghost"
        >
          {t`Show payload`}
        </Button>
      ) : (
        <Text as="span" color="muted" size="xs">
          {t`Payload no longer kept`}
        </Text>
      )}
    </li>
  );
};

/**
 * A trigger a test event matched: whether an event from the sender would
 * start its workflow now, or what holds it. Only a trigger whose `start`
 * an admin granted starts anything (core's workflows/source-events.ts).
 */
const MatchedTrigger = ({ trigger }: { trigger: EventSourceTrigger }) => {
  const { t } = useLingui();
  const { name } = trigger.workflow;
  switch (trigger.start) {
    case "active": {
      return (
        <Text
          as="span"
          size="sm"
        >{t`An event from the sender would start ${name} now, if its data is an input the workflow takes.`}</Text>
      );
    }
    case "requested": {
      return (
        <Text
          as="span"
          size="sm"
        >{t`An event from the sender would not start ${name}: its trigger still waits for an admin's approval.`}</Text>
      );
    }
    case "revoked": {
      return (
        <Text
          as="span"
          size="sm"
        >{t`An event from the sender would not start ${name}: its trigger's approval was taken back.`}</Text>
      );
    }
    case null: {
      return (
        <Text
          as="span"
          size="sm"
        >{t`An event from the sender would not start ${name}: its trigger has no approval.`}</Text>
      );
    }
    default: {
      return trigger.start satisfies never;
    }
  }
};

/** A test event for `source`: its type and data, and what it matched. */
const TestEvent = ({
  source,
  onSent,
}: {
  source: EventSource;
  onSent: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [type, setType] = useState("");
  const [data, setData] = useState("{}");
  const [notJson, setNotJson] = useState(false);
  const [result, setResult] = useState<EventSourceTestResult>();
  const send = async (): Promise<void> => {
    setResult(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      setNotJson(true);
      return;
    }
    setNotJson(false);
    const sent = await run(
      async (session) =>
        await session.workflowResources.sources.sendTest(source.id, {
          type: type.trim(),
          data: parsed,
        })
    );
    if (sent !== undefined) {
      setResult(sent);
      await onSent();
    }
  };
  const matched = result?.matched ?? [];
  const count = matched.length;
  return (
    <form
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void send();
      }}
      {...stylex.props(styles.test)}
    >
      <Field>
        <FieldLabel>{t`Event type of a test event`}</FieldLabel>
        <Input
          onValueChange={setType}
          placeholder="payment.paid"
          required
          value={type}
        />
        <FieldError match="valueMissing">{t`Enter an event type.`}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t`Its data, as JSON`}</FieldLabel>
        <Textarea onValueChange={setData} value={data} />
      </Field>
      <div>
        <Button disabled={busy} size="sm" type="submit" variant="secondary">
          {t`Send a test event`}
        </Button>
      </div>
      {result === undefined ? null : (
        <output {...stylex.props(styles.lines)}>
          <Text as="span" size="sm">
            {count === 0
              ? t`No trigger matches this type. A test event starts no workflow.`
              : t`${plural(count, { one: "# trigger matches this type. A test event starts no workflow.", other: "# triggers match this type. A test event starts no workflow." })}`}
          </Text>
          {matched.map((trigger) => (
            <MatchedTrigger key={trigger.id} trigger={trigger} />
          ))}
        </output>
      )}
      <Failure>{notJson ? t`The data isn't JSON.` : failure}</Failure>
    </form>
  );
};

/** What an opened source received: refusals, deliveries, a test event. */
const ReceivedList = ({
  source,
  received,
  busy,
  failure,
  onMore,
  onPayload,
  onSent,
}: {
  source: EventSource;
  received: Received | undefined;
  busy: boolean;
  failure: string | undefined;
  onMore: (from: string) => void;
  onPayload: (delivery: EventSourceDelivery) => void;
  onSent: () => Promise<void>;
}) => {
  const { t } = useLingui();
  return (
    <>
      {received === undefined ? null : (
        <>
          <Refusals refusals={received.refusals} />
          {received.deliveries.length === 0 ? (
            <Text color="muted" size="sm">
              {t`No event accepted in the last seven days.`}
            </Text>
          ) : (
            <ul {...stylex.props(styles.lines)}>
              {received.deliveries.map((delivery) => (
                <DeliveryRow
                  busy={busy}
                  delivery={delivery}
                  key={delivery.id}
                  onPayload={() => {
                    onPayload(delivery);
                  }}
                />
              ))}
            </ul>
          )}
          {received.next === null ? null : (
            <div>
              <Button
                disabled={busy}
                onClick={() => {
                  onMore(received.next ?? "");
                }}
                size="xs"
                variant="ghost"
              >
                {t`Show older events`}
              </Button>
            </div>
          )}
        </>
      )}
      <Failure>{failure}</Failure>
      <TestEvent onSent={onSent} source={source} />
    </>
  );
};

/**
 * How many deliveries `source` refused in the last 24 hours, for its row
 * in the list: something to look at; nothing while it refused none.
 */
export const RefusedBadge = ({ source }: { source: EventSource }) => {
  const { t } = useLingui();
  const refused = source.activity?.refusedLastDay ?? 0;
  if (refused === 0) {
    return null;
  }
  return (
    <Badge size="sm" variant="warning">
      {t`${plural(refused, { one: "# refused in the last 24 hours", other: "# refused in the last 24 hours" })}`}
    </Badge>
  );
};

/**
 * What `source` received lately, for its admin: a line always, and its
 * refusals, deliveries and a test event once opened, read as it is
 * opened.
 */
export const SourceActivity = ({ source }: { source: EventSource }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [received, setReceived] = useState<Received>();
  // A payload as shown: its JSON, or null for one core no longer holds.
  const [payload, setPayload] = useState<string | null>();
  const { activity, name } = source;
  if (activity === null) {
    return null;
  }

  /** Reads the refusals and the newest deliveries afresh. */
  const read = async (): Promise<void> => {
    const answered = await run(async (session) => {
      const { sources } = session.workflowResources;
      const [refusals, page] = await Promise.all([
        sources.refusals(source.id),
        sources.deliveries(source.id),
      ]);
      return { refusals, ...page };
    });
    if (answered !== undefined) {
      setReceived(answered);
    }
  };

  const more = async (from: string): Promise<void> => {
    const page: EventSourceDeliveryPage | undefined = await run(
      async (session) =>
        await session.workflowResources.sources.deliveries(source.id, from)
    );
    if (page !== undefined) {
      setReceived((before) =>
        before === undefined
          ? before
          : {
              ...before,
              deliveries: [...before.deliveries, ...page.deliveries],
              next: page.next,
            }
      );
    }
  };

  const show = async (delivery: EventSourceDelivery): Promise<void> => {
    const answered = await run(
      async (session) =>
        await session.workflowResources.sources.delivery(source.id, delivery.id)
    );
    if (answered !== undefined) {
      setPayload(
        answered.payloadHeld ? JSON.stringify(answered.payload, null, 2) : null
      );
    }
  };

  const last =
    activity.lastEventAt === null
      ? undefined
      : formatDateTime(activity.lastEventAt);
  const { acceptedLastDay: accepted } = activity;
  return (
    <div {...stylex.props(styles.activity)}>
      <div {...stylex.props(styles.summary)}>
        <Text as="span" size="sm">
          {last === undefined ? (
            <Trans>No event in the last seven days.</Trans>
          ) : (
            <Trans>Last event {last}.</Trans>
          )}
        </Text>
        <Text as="span" color="muted" size="sm">
          {t`${plural(accepted, { one: "# event accepted in the last 24 hours.", other: "# events accepted in the last 24 hours." })}`}
        </Text>
        <RefusedBadge source={source} />
      </div>
      <div>
        <Button
          aria-expanded={open}
          aria-label={
            open ? t`Hide what ${name} received` : t`Show what ${name} received`
          }
          onClick={() => {
            setOpen(!open);
            if (!open) {
              void read();
            }
          }}
          size="xs"
          variant="ghost"
        >
          {open ? t`Hide events` : t`Show events`}
        </Button>
      </div>
      {open ? (
        <ReceivedList
          busy={busy}
          failure={failure}
          onMore={(from) => {
            void more(from);
          }}
          onPayload={(delivery) => {
            void show(delivery);
          }}
          onSent={async () => {
            await read();
            await router.invalidate({ sync: true });
          }}
          received={received}
          source={source}
        />
      ) : null}
      <Dialog
        onOpenChange={(shown) => {
          if (!shown) {
            setPayload(undefined);
          }
        }}
        open={payload !== undefined}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Payload`}</DialogTitle>
            <DialogDescription>
              {t`Kept for 24 hours after the event came. Opening it is recorded in the audit trail.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {payload === null || payload === undefined ? (
              <Text color="muted" size="sm">
                {t`This payload is no longer kept.`}
              </Text>
            ) : (
              <CodeBlock language="json">{payload}</CodeBlock>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
};
