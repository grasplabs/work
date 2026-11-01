import { appLinkMaxLength, appLinkSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { Button } from "@grasp-os/ui/components/button";
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
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@grasp-os/ui/components/input-group";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
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
  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Link to {app.name}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Opens the domain for the workspace&apos;s members who may use it,
              while it is published.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save(link);
          }}
        >
          <Field data-invalid={link !== "" && !valid}>
            <FieldLabel htmlFor="app-link">
              <Trans>Link</Trans>
            </FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>{`${window.location.host}/`}</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                aria-invalid={link !== "" && !valid}
                autoComplete="off"
                id="app-link"
                maxLength={appLinkMaxLength}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
                placeholder={t`sales-pipeline`}
                spellCheck={false}
                value={link}
              />
            </InputGroup>
            {link !== "" && !valid ? (
              <FieldError>
                <Trans>
                  Lower-case letters and digits, with single dashes between
                  them; not the name of one of the workspace&apos;s pages.
                </Trans>
              </FieldError>
            ) : (
              <FieldDescription>
                <Trans>Only someone signed in to the workspace opens it.</Trans>
              </FieldDescription>
            )}
          </Field>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            {app.link === null ? null : (
              <Button
                disabled={busy}
                onClick={() => {
                  save(null);
                }}
                type="button"
                variant="outline"
              >
                <Trans>Remove link</Trans>
              </Button>
            )}
            <Button
              disabled={busy || !valid || link === app.link}
              type="submit"
            >
              <Trans>Save link</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
