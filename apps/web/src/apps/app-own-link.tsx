import { appLinkMaxLength, appLinkSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { useCoreAction } from "../use-core-action.ts";

// An App's own link, as the prototype's publish dialog gives one
// (`components/apps/publish-dialog.tsx`): the last part of an address under
// the workspace's, which opens the App for the workspace's members who may
// use it, while it is published. Core keeps each link once and refuses the
// workspace's own pages (app-own-links.ts); its builders set it here.

/** A link made of `name`: lower case, its words joined by single dashes. */
export const suggestedLink = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .slice(0, appLinkMaxLength)
    .replaceAll(/^-+|-+$/gu, "");

/** The address `link` opens, under the workspace's own. */
export const linkAddress = (link: string): string =>
  new URL(`/${link}`, window.location.origin).href;

/**
 * Sets the App's link, or takes it off, for one of its builders; core's
 * refusal (another App has it, say) shows in the dialog.
 */
export const AppLinkDialog = ({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [typed, setTyped] = useState<string>();
  const link = typed ?? app.link ?? suggestedLink(app.name);
  const valid = appLinkSchema.safeParse(link).success;
  const save = (wanted: string | null): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.apps.setLink(app.id, wanted);
          setTyped(undefined);
          onOpenChange(false);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const handleOpenChange = (next: boolean): void => {
    setTyped(undefined);
    onOpenChange(next);
  };
  const formId = useId();
  const { name } = app;
  const wrong = link !== "" && !valid;
  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Link to ${name}`}</DialogTitle>
        <DialogDescription>
          {t`Opens the App for the workspace's members who may use it, while it is published.`}
        </DialogDescription>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && valid && link !== app.link) {
                save(link);
              }
            }}
          >
            <Field invalid={wrong}>
              <FieldLabel>{t`Link`}</FieldLabel>
              <InputGroup>
                <InputGroupText>{`${window.location.host}/`}</InputGroupText>
                <InputGroupInput
                  autoComplete="off"
                  maxLength={appLinkMaxLength}
                  onValueChange={setTyped}
                  placeholder={t`sales-pipeline`}
                  spellCheck={false}
                  value={link}
                />
              </InputGroup>
              {wrong ? (
                <FieldError match>
                  {t`Lower-case letters and digits, with single dashes between them; not the name of one of the workspace's pages.`}
                </FieldError>
              ) : null}
            </Field>
            {failure === undefined ? null : (
              <Alert title={failure} variant="danger" />
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          {app.link === null ? (
            <DialogAction>{t`Cancel`}</DialogAction>
          ) : (
            <Button
              disabled={busy}
              onClick={() => {
                save(null);
              }}
              variant="quiet"
            >
              {t`Remove link`}
            </Button>
          )}
          <Button
            disabled={busy || !valid || link === app.link}
            form={formId}
            type="submit"
            variant="ink"
          >
            {t`Save link`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
