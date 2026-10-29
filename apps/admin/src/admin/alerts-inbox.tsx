/**
 * The Alerts inbox, as Home and Platform show it (src/alert-inbox.ts):
 * every open staff alert, the newest first, with what happened, what to
 * do next, a link to where, and acknowledging and resolving it.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Link, useRouter } from "@tanstack/react-router";

import { acknowledgeAlertFn, resolveAlertFn } from "../alert-inbox.ts";
import type { AlertActionResult, AlertView } from "../alert-inbox.ts";
import type { AlertDelivery } from "../alerts.ts";
import { formatTime } from "../releases/format.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { Panel } from "./panel.tsx";

/** What an action's refusal says. */
const refusals: Readonly<Record<"not_open", string>> = {
  not_open: "Someone at Grasp acted on it first: the list is read again.",
};

/** What became of an alert's delivery, as the inbox says it. */
const deliveryWords: Readonly<Record<AlertDelivery, string>> = {
  sent: "Posted to the alerts channel.",
  sending: "Being posted to the alerts channel.",
  no_channel:
    "Not posted: no alerts channel is set, so it's only here. Add STAFF_ALERTS_WEBHOOK to the stage's 1Password Environment, then run Deploy platform.",
  failed:
    "The alerts channel refused it: the next alert of its kind tries again.",
};

/** The link an alert opens, and what it says. */
const AlertLink = ({ alert }: { alert: AlertView }) => {
  const className = buttonVariants({ variant: "ghost", size: "sm" });
  const { page } = alert;
  switch (page.to) {
    case "setup": {
      return (
        <Link
          className={className}
          params={{ clientId: page.clientId }}
          to="/organizations/$clientId/setup"
        >
          Open its Setup
        </Link>
      );
    }
    case "rollout": {
      return (
        <Link
          className={className}
          params={{ rolloutId: page.rolloutId }}
          to="/platform/rollouts/$rolloutId"
        >
          Open the rollout
        </Link>
      );
    }
    case "releases": {
      return (
        <Link className={className} to="/platform/releases">
          Open Releases
        </Link>
      );
    }
    case "platform": {
      return (
        <Link className={className} to="/platform">
          Open Platform
        </Link>
      );
    }
    default: {
      return page satisfies never;
    }
  }
};

/** Whom an alert is about, as the inbox names it. */
const aboutOf = (alert: AlertView): string => {
  if (alert.clientId !== null) {
    return alert.clientName ?? alert.clientId;
  }
  if (alert.page.to === "rollout") {
    return `Rollout ${alert.page.rolloutId}`;
  }
  return alert.page.to === "releases" && alert.subject !== null
    ? `Release ${alert.subject}`
    : "The platform";
};

/** When it was raised, and how often since. */
const raisedWords = (alert: AlertView): string =>
  alert.times === 1
    ? `Raised ${formatTime(alert.raisedAt)} UTC.`
    : `Raised ${alert.times} times, first ${formatTime(alert.raisedAt)} UTC, last ${formatTime(alert.lastRaisedAt)} UTC.`;

/** One open alert, with acknowledging and resolving it. */
const AlertRow = ({ alert }: { alert: AlertView }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const act = (
    action: (options: {
      data: { alertId: string };
    }) => Promise<AlertActionResult>
  ) => {
    void run(
      async () =>
        await thenRefresh(
          async () => await action({ data: { alertId: alert.id } }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted-foreground text-xs">
            {aboutOf(alert)}
          </span>
          <span className="font-medium">{alert.title}</span>
        </span>
        {alert.acknowledgedBy === null ? null : (
          <Badge variant="secondary">
            {`${alert.acknowledgedBy} is on it`}
          </Badge>
        )}
      </div>
      <p>{alert.words}</p>
      <p className="text-muted-foreground text-xs">
        {`${raisedWords(alert)} ${deliveryWords[alert.delivery]}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <AlertLink alert={alert} />
        {alert.acknowledgedBy === null ? (
          <Button
            disabled={busy}
            onClick={() => {
              act(acknowledgeAlertFn);
            }}
            size="sm"
            variant="outline"
          >
            Acknowledge
          </Button>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => {
            act(resolveAlertFn);
          }}
          size="sm"
          variant="outline"
        >
          Resolve
        </Button>
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </div>
    </li>
  );
};

/**
 * Every open staff alert: none says so, so an empty inbox reads as
 * nothing wrong rather than nothing shown.
 */
export const AlertsInbox = ({ alerts }: { alerts: AlertView[] }) => (
  <Panel
    description={
      alerts.length === 0
        ? "No open alerts: nothing the admin raised waits for someone at Grasp."
        : "What the admin raised for someone at Grasp, the newest first. Acknowledge one you're on; resolve it once fixed, and it's raised again if it happens again."
    }
    title="Alerts"
  >
    {alerts.length === 0 ? null : (
      <ul className="flex flex-col text-sm">
        {alerts.map((alert) => (
          <AlertRow alert={alert} key={alert.id} />
        ))}
      </ul>
    )}
  </Panel>
);
