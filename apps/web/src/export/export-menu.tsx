import { useLingui } from "@lingui/react/macro";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Download, File } from "../grasp/icons/index.ts";
import { exportAs } from "./export-file.tsx";
import type { ExportFile } from "./export-file.tsx";

/**
 * Every export in Grasp, as in the prototype (`components/export-menu.tsx`):
 * a quiet icon button named by `label` in its tooltip, and the person
 * chooses Markdown or PDF. An export works on its item in Grasp UI's menu,
 * and says there when it didn't work.
 */
export const ExportMenu = ({
  file,
  label,
}: {
  file: ExportFile;
  /** What it exports, as the tooltip says it: "Export this chat". Plain "Export" without it. */
  label?: string;
}) => {
  const { i18n, t } = useLingui();
  const name = label ?? t`Export`;
  const failed = t`The export didn't work. Try again.`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={name}
        icon={Download}
        size="sm"
        tooltip={name}
        variant="ghost"
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          action={async () => {
            await exportAs(file, "md", i18n.locale);
          }}
          failedLabel={failed}
          icon={File}
        >
          {t`Markdown (.md)`}
        </DropdownMenuItem>
        <DropdownMenuItem
          action={async () => {
            await exportAs(file, "pdf", i18n.locale);
          }}
          failedLabel={failed}
          icon={File}
        >
          {t`PDF`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
