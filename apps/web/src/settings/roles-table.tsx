import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon } from "lucide-react";

import { formatList } from "../format.ts";
import { roleLabel } from "../labels.ts";
import { SettingsSection } from "./settings-parts.tsx";

// What each role may do, as the prototype's roles table shows it
// (`routes/settings/members.tsx`), in the words of what core checks: who
// builds (`canBuild`) and who manages (`isAdmin`, @grasp-os/shared/roles).
// Core decides on every call; this only explains it.

const roles = roleSchema.options;

const capabilities: { label: MessageDescriptor; roles: readonly Role[] }[] = [
  {
    label: msg`Use the chat, and the apps, workflows and knowledge shared with them`,
    roles: ["admin", "builder", "user"],
  },
  {
    label: msg`Build apps and workflows, and ask for the access they need`,
    roles: ["admin", "builder"],
  },
  {
    label: msg`Grant and revoke access, and approve apps`,
    roles: ["admin"],
  },
  {
    label: msg`See every app and the audit trail`,
    roles: ["admin"],
  },
  {
    label: msg`Choose models and limit AI spend`,
    roles: ["admin"],
  },
  {
    label: msg`Invite people, change roles and remove members`,
    roles: ["admin"],
  },
];

/** The roles, and what each may do: a column a role where there is room. */
export const RolesSection = () => {
  const { t, i18n } = useLingui();
  return (
    <SettingsSection
      description={t`What each role may do. Grasp checks it on every request.`}
      title={t`Roles`}
    >
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">
                <Trans comment="Heading of a list of what each role is allowed to do">
                  May
                </Trans>
              </TableHead>
              {roles.map((role) => (
                <TableHead
                  className="hidden w-20 text-center @lg:table-cell"
                  variant="card"
                  key={role}
                >
                  {roleLabel(role)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {capabilities.map((capability) => (
              <TableRow key={capability.label.id}>
                <TableCell className="whitespace-normal" variant="roomy">
                  <span className="flex flex-col gap-0.5">
                    <span>{i18n._(capability.label)}</span>
                    <span className="text-muted-foreground text-xs @lg:hidden">
                      {formatList(capability.roles.map(roleLabel))}
                    </span>
                  </span>
                </TableCell>
                {roles.map((role) => (
                  <TableCell
                    className="hidden text-center @lg:table-cell"
                    key={role}
                    variant="roomy"
                  >
                    {capability.roles.includes(role) ? (
                      <>
                        <CheckIcon
                          aria-hidden="true"
                          className="mx-auto size-4"
                        />
                        <span className="sr-only">{t`Yes`}</span>
                      </>
                    ) : (
                      <>
                        <span
                          aria-hidden="true"
                          className="text-muted-foreground"
                        >
                          –
                        </span>
                        <span className="sr-only">{t`No`}</span>
                      </>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
};
