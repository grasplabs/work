import { appWebhookEvents } from "@grasp-os/shared/app-webhooks";
import type {
  AppWebhook,
  AppWebhookEvent,
} from "@grasp-os/shared/app-webhooks";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { decidesRequests } from "../dashboard/waiting.ts";
import { formatList } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox, CheckboxGroup } from "../grasp/checkbox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Plus, Web } from "../grasp/icons/index.ts";
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
import { Text } from "../grasp/text/index.ts";
import { ShownOnceDialog } from "../shown-once.tsx";
import { useCoreAction } from "../use-core-action.ts";

// An App's webhooks (core's app-webhooks.ts): https addresses its
// builders give it, which Grasp sends its events to, signed with each
// one's secret. The secret is shown once, as the webhook is added. Until an
// admin approves an address, what goes there is IDs and the event only;
// approving is the admin's alone, as approving a page's build is.

const eventNames = {
  form_sent: msg({
    message: "A form is sent",
    context: "a webhook event: someone sent a form on one of the App's pages",
  }),
  published: msg({
    message: "It is published",
    context: "a webhook event: the App was published",
  }),
  changed: msg({
    message: "A new version is published",
    context: "a webhook event: a version of the App went live",
  }),
} as const satisfies Record<AppWebhookEvent, unknown>;

/** A webhook event, as people read it. */
const eventLabel = (event: AppWebhookEvent): string =>
  i18n._(eventNames[event]);

/** Whether `value` is one of the App's webhook events. */
const isEvent = (value: string): value is AppWebhookEvent =>
  appWebhookEvents.some((event) => event === value);

/** Adding a webhook, in a dialog: its address, and the events it is sent. */
const AddWebhook = ({
  app,
  onSecret,
}: {
  app: string;
  onSecret: (secret: string) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<AppWebhookEvent[]>(["form_sent"]);
  const add = async (): Promise<void> => {
    let added = false;
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          const { secret } = await session.apps.webhooks.add(app, {
            url: url.trim(),
            events,
          });
          added = true;
          setUrl("");
          onSecret(secret);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    if (!added) {
      // The dialog stays open, with core's reason in it.
      throw new Error("Not added");
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger icon={Plus} size="sm">
        {t`Add webhook`}
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Add webhook`}</DialogTitle>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <Field>
              <FieldLabel>{t`Address`}</FieldLabel>
              <Input
                autoComplete="off"
                inputMode="url"
                maxLength={2048}
                onValueChange={setUrl}
                placeholder="https://"
                spellCheck={false}
                type="url"
                value={url}
              />
              <FieldDescription>
                {t`An https address on the public internet, with no user name, password or IP address in it.`}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t`Send it when`}</FieldLabel>
              <CheckboxGroup
                onValueChange={(value) => {
                  setEvents(
                    value.flatMap((each) => (isEvent(each) ? [each] : []))
                  );
                }}
                value={events}
              >
                {appWebhookEvents.map((event) => (
                  <Field key={event} orientation="horizontal">
                    <Checkbox value={event} />
                    <FieldContent>
                      <FieldLabel>{eventLabel(event)}</FieldLabel>
                    </FieldContent>
                  </Field>
                ))}
              </CheckboxGroup>
            </Field>
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={add}
            disabled={busy || url.trim() === "" || events.length === 0}
            failedLabel={t`Could not add`}
            variant="ink"
            workingLabel={t`Adding`}
          >
            {t`Add webhook`}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Removing a webhook, once confirmed. */
const RemoveWebhook = ({
  webhook,
  busy,
  onRemove,
}: {
  webhook: AppWebhook;
  busy: boolean;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const { url } = webhook;
  return (
    <AlertDialog>
      <AlertDialogTrigger disabled={busy} size="sm" variant="ghost">
        {t`Remove`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Remove the webhook to ${url}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Grasp stops sending the App's events there. Its secret can't be used again.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction onClick={onRemove} variant="danger">
            {t`Remove`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const { t } = useLingui();
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
  const { dropped } = webhook;
  return (
    <Item size="xs">
      <ItemMedia icon={Web} iconLook="inline" />
      <ItemContent>
        <ItemTitle>{webhook.url}</ItemTitle>
        <ItemDescription>
          {formatList(webhook.events.map((event) => eventLabel(event)))}
        </ItemDescription>
        {dropped === 0 ? null : (
          <Alert live="off" quiet tone="danger">
            {t`${plural(dropped, {
              one: "# event wasn't sent: too many were waiting for this address.",
              other:
                "# events weren't sent: too many were waiting for this address.",
            })}`}
          </Alert>
        )}
        {failure === undefined ? null : (
          <Alert quiet tone="danger">
            {failure}
          </Alert>
        )}
      </ItemContent>
      <ItemActions>
        {webhook.approved === null ? (
          <Badge tone="attention">{t`Waiting for an admin`}</Badge>
        ) : (
          <Badge tone="success">{t`Approved`}</Badge>
        )}
        {approves && webhook.approved === null ? (
          <Button
            disabled={busy}
            onClick={() => {
              act("approve");
            }}
            size="sm"
          >
            {t`Approve`}
          </Button>
        ) : null}
        <RemoveWebhook
          busy={busy}
          onRemove={() => {
            act("remove");
          }}
          webhook={webhook}
        />
      </ItemActions>
    </Item>
  );
};

/** An App's webhooks as core listed them: approved by an admin only. */
export const WebhookList = ({
  identity,
  webhooks,
}: {
  identity: Pick<Identity, "role" | "staff">;
  webhooks: AppWebhook[];
}) => {
  const { t } = useLingui();
  const approves = decidesRequests(identity);
  return webhooks.length === 0 ? (
    <Text size="sm" tone="muted">
      {t`No webhooks yet.`}
    </Text>
  ) : (
    <ItemGroup aria-label={t`Webhooks`} separated>
      {webhooks.map((webhook) => (
        <WebhookRow approves={approves} key={webhook.id} webhook={webhook} />
      ))}
    </ItemGroup>
  );
};

/**
 * An App's webhooks, for its builders and the workspace's admins: added
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
  const { t } = useLingui();
  const [secret, setSecret] = useState<string>();
  return (
    <SectionCard
      actions={<AddWebhook app={app} onSecret={setSecret} />}
      density="compact"
      headingLevel={3}
      info={t`Grasp sends this App's events to each address, signed with its secret. Until an admin approves an address, it gets IDs and the event only, never what someone sent in a form.`}
      title={t`Addresses`}
    >
      {children}
      <ShownOnceDialog
        description={t`Every delivery is signed with it, so the receiver can tell it came from Grasp.`}
        onClose={() => {
          setSecret(undefined);
        }}
        secret={secret}
        title={t`The webhook's secret`}
      />
    </SectionCard>
  );
};
