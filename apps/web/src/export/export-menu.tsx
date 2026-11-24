import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { DownloadIcon, FileIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { exportAs } from "./export-file.tsx";
import type { ExportFile } from "./export-file.tsx";

/**
 * Every export in Grasp, as in the prototype (`components/export-menu.tsx`):
 * a quiet icon button named by `label` in its tooltip, and the person
 * chooses Markdown or PDF. An export works on its item in the menu, with
 * the item's spinner, and says there when it didn't work.
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
      <DropdownMenuTrigger asChild>
        <Button aria-label={name} size="icon-sm" variant="ghost">
          <Icon icon={DownloadIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          errorText={failed}
          icon={FileIcon}
          onSelect={async () => {
            await exportAs(file, "md", i18n.locale);
          }}
        >
          {t`Markdown (.md)`}
        </DropdownMenuItem>
        <DropdownMenuItem
          errorText={failed}
          icon={FileIcon}
          onSelect={async () => {
            await exportAs(file, "pdf", i18n.locale);
          }}
        >
          {t`PDF`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
