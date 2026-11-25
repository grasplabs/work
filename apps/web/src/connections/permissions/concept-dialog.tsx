// The connect dialog's permission concepts, in development only:
// `?concept=a|b|c` on any page that opens the connect dialog for a Composio
// toolkit signed in to by OAuth shows its tools as one choice (a), three
// bins by risk (b) or one list to manage (c). Each keeps what connecting
// sends core: the tools allowed, which of them only read, and the consent
// as written. The title and the footer stay put; only the choice scrolls.
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { AppLogo } from "../app-logo.tsx";
import type { AllowedTool } from "../tool-choices.ts";
import { ActionList } from "./action-list.tsx";
import { Buckets } from "./buckets.tsx";
import type { SortedTool } from "./model.ts";
import { TrustLine, useTallyWords } from "./parts.tsx";
import { Presets } from "./presets.tsx";

/** Which concept shows. */
export type PermissionConcept = "a" | "b" | "c";

export const isPermissionConcept = (
  value: unknown
): value is PermissionConcept =>
  value === "a" || value === "b" || value === "c";

/** The page's `?concept=`, in development only; none in a build. */
export const permissionConceptOf = (
  search: string
): PermissionConcept | null => {
  const concept = new URLSearchParams(search).get("concept");
  return import.meta.env.DEV && isPermissionConcept(concept) ? concept : null;
};

const styles = stylex.create({
  title: { display: "flex", alignItems: "center", gap: space[3] },
  body: { display: "grid", gap: space[5] },
  // The count gives way to the button: one line, cut short before it wraps.
  tally: {
    overflow: "hidden",
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
    alignSelf: "center",
  },
});

/** The dialog's header, body and footer for one concept. */
export const ConceptParts = ({
  concept,
  app,
  logo,
  sorted,
  allowed,
  onAllowed,
  loading,
  failure,
  note,
  actions,
}: {
  concept: PermissionConcept;
  app: string;
  logo: string | null;
  /** The toolkit's tools, sorted; none while they load. */
  sorted: readonly SortedTool[] | undefined;
  allowed: readonly AllowedTool[];
  onAllowed: (next: AllowedTool[]) => void;
  /** While the tools load. */
  loading: ReactNode;
  /** Why the tools or the sign-in failed. */
  failure: string | undefined;
  /** A line over the choice, such as that it shows sample tools. */
  note?: string;
  /** The main action, or the waiting row: the corner's close cancels. */
  actions: ReactNode;
}) => {
  const { t } = useLingui();
  const tally = useTallyWords(allowed);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <span {...stylex.props(styles.title)}>
            <AppLogo logo={logo} name={app} size="sm" />
            {t`Connect ${app}`}
          </span>
        </DialogTitle>
        <DialogDescription>
          {t`Choose what Grasp may do in ${app}. Then you sign in at ${app}, which takes about a minute.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div {...stylex.props(styles.body)}>
          {note === undefined ? null : (
            <Text color="subtle" size="xs">
              {note}
            </Text>
          )}
          {sorted === undefined ? loading : null}
          {sorted !== undefined && concept === "a" ? (
            <Presets
              allowed={allowed}
              app={app}
              onAllowed={onAllowed}
              sorted={sorted}
            />
          ) : null}
          {sorted !== undefined && concept === "b" ? (
            <Buckets allowed={allowed} onAllowed={onAllowed} sorted={sorted} />
          ) : null}
          {sorted !== undefined && concept === "c" ? (
            <ActionList
              allowed={allowed}
              onAllowed={onAllowed}
              sorted={sorted}
            />
          ) : null}
          {failure === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>{failure}</AlertTitle>
            </Alert>
          )}
          <TrustLine app={app} />
        </div>
      </DialogBody>
      <DialogFooter>
        <span {...stylex.props(styles.tally)}>
          <Text as="span" color="muted" size="sm" truncate>
            {tally}
          </Text>
        </span>
        {actions}
      </DialogFooter>
    </>
  );
};
