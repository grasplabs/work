import { Badge } from "@grasp-os/app-kit/components/badge";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/app-kit/components/dialog";
import { Input } from "@grasp-os/app-kit/components/input";
import { Label } from "@grasp-os/app-kit/components/label";
import { Textarea } from "@grasp-os/app-kit/components/textarea";
import type {
  EventSource,
  EventSourceDelivery,
  EventSourceDeliveryPage,
  EventSourceRefusals,
  EventSourceTestResult,
  EventSourceTrigger,
} from "@grasp-os/shared/event-sources";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// What a source received, under its row in Settings › Webhooks (core's
// workflows/source-deliveries.ts): when its last event came and how many
// it accepted and refused in the last 24 hours, always; and, once opened,
// why it refused them, its recent deliveries, each payload read on its own
// (core audits that read, so nothing reads one unasked), and a test event
// that says which triggers it matches and starts nothing.

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
    <ul className="flex flex-col gap-1 text-sm">
      {refusals.map(({ reason }, index) => (
        <li key={reason}>{lines[index]}</li>
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
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span className="text-muted-foreground">
        {formatDateTime(delivery.receivedAt)}
      </span>
      <code className="font-mono">{type}</code>
      {delivery.test ? (
        <Badge variant="outline">
          <Trans>Test</Trans>
        </Badge>
      ) : (
        <span className="text-muted-foreground">
          {t`${plural(started, { one: "Started # workflow", other: "Started # workflows" })}`}
        </span>
      )}
      {delivery.payloadHeld ? (
        <Button
          aria-label={t`Show the payload of ${type}`}
          disabled={busy}
          onClick={onPayload}
          size="sm"
          variant="ghost"
        >
          <Trans>Show payload</Trans>
        </Button>
      ) : (
        <span className="text-muted-foreground text-xs">
          <Trans>Payload no longer kept</Trans>
        </span>
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
        <span>{t`An event from the sender would start ${name} now, if its data is an input the workflow takes.`}</span>
      );
    }
    case "requested": {
      return (
        <span className="text-status-attention">{t`An event from the sender would not start ${name}: its trigger still waits for an admin's approval.`}</span>
      );
    }
    case "revoked": {
      return (
        <span className="text-status-attention">{t`An event from the sender would not start ${name}: its trigger's approval was taken back.`}</span>
      );
    }
    case null: {
      return (
        <span className="text-status-attention">{t`An event from the sender would not start ${name}: its trigger has no approval.`}</span>
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
  const ids = useId();
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
      className="flex flex-col gap-2"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void send();
      }}
    >
      <Label htmlFor={`${ids}-type`}>
        <Trans>Event type of a test event</Trans>
      </Label>
      <Input
        id={`${ids}-type`}
        onChange={(changed) => {
          setType(changed.target.value);
        }}
        placeholder="payment.paid"
        required
        value={type}
      />
      <Label htmlFor={`${ids}-data`}>
        <Trans>Its data, as JSON</Trans>
      </Label>
      <Textarea
        id={`${ids}-data`}
        onChange={(changed) => {
          setData(changed.target.value);
        }}
        value={data}
      />
      <div>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          <Trans>Send a test event</Trans>
        </Button>
      </div>
      {result === undefined ? null : (
        <output className="flex flex-col gap-1 text-sm">
          <span>
            {count === 0
              ? t`No trigger matches this type. A test event starts no workflow.`
              : t`${plural(count, { one: "# trigger matches this type. A test event starts no workflow.", other: "# triggers match this type. A test event starts no workflow." })}`}
          </span>
          {matched.map((trigger) => (
            <MatchedTrigger key={trigger.id} trigger={trigger} />
          ))}
        </output>
      )}
      <ErrorText>{notJson ? t`The data isn't JSON.` : failure}</ErrorText>
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
}) => (
  <div className="flex flex-col gap-3">
    {received === undefined ? null : (
      <>
        <Refusals refusals={received.refusals} />
        {received.deliveries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <Trans>No event accepted in the last seven days.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
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
              size="sm"
              variant="outline"
            >
              <Trans>Show older events</Trans>
            </Button>
          </div>
        )}
      </>
    )}
    <ErrorText>{failure}</ErrorText>
    <TestEvent onSent={onSent} source={source} />
  </div>
);

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
  const { acceptedLastDay: accepted, refusedLastDay: refused } = activity;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {last === undefined ? (
            <Trans>No event in the last seven days.</Trans>
          ) : (
            <Trans>Last event {last}.</Trans>
          )}
        </span>
        <span className="text-muted-foreground">
          {t`${plural(accepted, { one: "# event accepted in the last 24 hours.", other: "# events accepted in the last 24 hours." })}`}
        </span>
        {refused === 0 ? null : (
          <Badge variant="attention">
            {t`${plural(refused, { one: "# refused in the last 24 hours", other: "# refused in the last 24 hours" })}`}
          </Badge>
        )}
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
          size="sm"
          variant="ghost"
        >
          {open ? <Trans>Hide events</Trans> : <Trans>Show events</Trans>}
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
            <DialogTitle>
              <Trans>Payload</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Kept for 24 hours after the event came. Opening it is recorded
                in the audit trail.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          {payload === null ? (
            <p className="text-muted-foreground text-sm">
              <Trans>This payload is no longer kept.</Trans>
            </p>
          ) : (
            <pre className="max-h-96 overflow-auto font-mono text-sm">
              {payload}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
