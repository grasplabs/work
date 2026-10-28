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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { decidesRequests } from "../dashboard/to-do.tsx";
import { ErrorText } from "../error-text.tsx";
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

/** Shows `secret` once, with the way to copy it. */
const SecretDialog = ({
  secret,
  onClose,
}: {
  secret: string | undefined;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (secret === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
      open={secret !== undefined}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>The webhook&apos;s secret</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Every delivery is signed with it, so the receiver can tell it came
              from Grasp. Copy it now: Grasp won&apos;t show it again.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <Input aria-label={t`Secret`} readOnly value={secret ?? ""} />
        <DialogFooter>
          <Button
            onClick={() => {
              void copy();
            }}
            variant="outline"
          >
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

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
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/**
 * A domain's webhooks, for its builders and the workspace's admins: added
 * and removed by either, approved by an admin only.
 */
export const AppWebhooks = ({
  app,
  identity,
  webhooks,
}: {
  app: string;
  identity: Pick<Identity, "role" | "staff">;
  webhooks: AppWebhook[];
}) => {
  const [secret, setSecret] = useState<string>();
  const approves = decidesRequests(identity);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        <Trans>
          Grasp sends this domain&apos;s events to each address, signed with its
          secret. Until an admin approves an address, it gets IDs and the event
          only, never what someone sent in a form.
        </Trans>
      </p>
      {webhooks.length === 0 ? null : (
        <ul className="divide-y">
          {webhooks.map((webhook) => (
            <WebhookRow
              approves={approves}
              key={webhook.id}
              webhook={webhook}
            />
          ))}
        </ul>
      )}
      {identity.staff ? null : <AddWebhook app={app} onSecret={setSecret} />}
      <SecretDialog
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
      />
    </div>
  );
};
