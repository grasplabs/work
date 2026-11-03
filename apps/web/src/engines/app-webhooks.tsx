import { appWebhookEvents } from "@grasp-os/shared/app-webhooks";
import type {
  AppWebhook,
  AppWebhookEvent,
} from "@grasp-os/shared/app-webhooks";
import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { decidesRequests } from "../dashboard/waiting.ts";
import { ErrorText } from "../error-text.tsx";
import { ShownOnceDialog } from "../shown-once.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A domain's webhooks (core's app-webhooks.ts): https addresses its
// builders give it, which Grasp sends its events to, signed with each
// one's secret. The secret is shown once, as the webhook is added. Until an
// admin approves an address, what goes there is IDs and the event only;
// approving is the admin's alone, as approving a screen's build is.

const eventNames = {
  form_sent: msg({
    message: "A form is sent",
    context: "a webhook event: someone sent a form of the domain's apps",
  }),
  published: msg({
    message: "It is published",
    context: "a webhook event: the domain was published",
  }),
  changed: msg({
    message: "A new version goes live",
    context: "a webhook event: a version of the domain was made current",
  }),
} as const satisfies Record<AppWebhookEvent, unknown>;

/** A webhook event, as people read it. */
const eventLabel = (event: AppWebhookEvent): string =>
  i18n._(eventNames[event]);

/** Adding a webhook: its address, and the events it is sent. */
const AddWebhook = ({
  app,
  onSecret,
}: {
  app: string;
  onSecret: (secret: string) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<AppWebhookEvent[]>(["form_sent"]);
  const handleSubmit = (): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => {
          const { secret } = await session.apps.webhooks.add(app, {
            url: url.trim(),
            events,
          });
          setUrl("");
          onSecret(secret);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <Field>
        <FieldLabel htmlFor="webhook-url">
          <Trans>Address</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          id="webhook-url"
          inputMode="url"
          maxLength={2048}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          placeholder="https://"
          spellCheck={false}
          type="url"
          value={url}
        />
        <FieldDescription>
          <Trans>
            An https address on the public internet, with no user name, password
            or IP address in it.
          </Trans>
        </FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>Send it when</Trans>
        </FieldLegend>
        <ul className="flex flex-col gap-1">
          {appWebhookEvents.map((event) => (
            <li key={event}>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={events.includes(event)}
                  onCheckedChange={(checked) => {
                    const rest = events.filter((one) => one !== event);
                    setEvents(checked ? [...rest, event] : rest);
                  }}
                />
                {eventLabel(event)}
              </label>
            </li>
          ))}
        </ul>
      </FieldSet>
      <ErrorText>{failure}</ErrorText>
      <div>
        <Button
          aria-label={t`Add webhook`}
          disabled={busy || url.trim() === "" || events.length === 0}
          type="submit"
        >
          <Trans>Add webhook</Trans>
        </Button>
      </div>
    </form>
  );
};

/** One webhook: its address, events and approval, and what can be done. */
const WebhookRow = ({
  webhook,
  approves,
}: {
  webhook: AppWebhook;
  approves: boolean;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const act = (change: "approve" | "remove"): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () =>
          await session.apps.webhooks[change](webhook.app, webhook.id),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 truncate font-mono">{webhook.url}</span>
        {webhook.approved === null ? (
          <Badge variant="outline">
            <Trans>Waiting for an admin</Trans>
          </Badge>
        ) : (
          <Badge>
            <Trans>Approved</Trans>
          </Badge>
        )}
        {approves && webhook.approved === null ? (
          <Button
            disabled={busy}
            onClick={() => {
              act("approve");
            }}
            size="sm"
          >
            <Trans>Approve</Trans>
          </Button>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => {
            act("remove");
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Remove</Trans>
        </Button>
      </div>
      <p className="text-muted-foreground">
        {webhook.events.map((event) => eventLabel(event)).join(" · ")}
      </p>
      {webhook.dropped === 0 ? null : (
        <p className="text-destructive">
          <Plural
            one="# event wasn't sent: too many were waiting for this address."
            other="# events weren't sent: too many were waiting for this address."
            value={webhook.dropped}
          />
        </p>
      )}
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/** A domain's webhooks as core listed them: approved by an admin only. */
export const WebhookList = ({
  identity,
  webhooks,
}: {
  identity: Pick<Identity, "role" | "staff">;
  webhooks: AppWebhook[];
}) => {
  const approves = decidesRequests(identity);
  return webhooks.length === 0 ? null : (
    <ul className="divide-y">
      {webhooks.map((webhook) => (
        <WebhookRow approves={approves} key={webhook.id} webhook={webhook} />
      ))}
    </ul>
  );
};

/**
 * A domain's webhooks, for its builders and the workspace's admins: added
 * and removed by either. `children` is the list (`WebhookList`), read
 * apart: a new webhook's secret is kept here, above it, so a list read
 * again after the add, failing or not, never takes the secret with it.
 */
export const AppWebhooks = ({
  app,
  children,
}: {
  app: string;
  children: ReactNode;
}) => {
  const [secret, setSecret] = useState<string>();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        <Trans>
          Grasp sends this domain&apos;s events to each address, signed with its
          secret. Until an admin approves an address, it gets IDs and the event
          only, never what someone sent in a form.
        </Trans>
      </p>
      {children}
      <AddWebhook app={app} onSecret={setSecret} />
      <ShownOnceDialog
        description={
          <Trans>
            Every delivery is signed with it, so the receiver can tell it came
            from Grasp.
          </Trans>
        }
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
        title={<Trans>The webhook&apos;s secret</Trans>}
      />
    </div>
  );
};
