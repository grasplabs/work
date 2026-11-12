import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { SidebarTrigger } from "@grasp-os/ui/components/sidebar";

/**
 * The head of Grasp's sidebar, the same in the platform and the admin: the
 * mark, then `title` (the organization's name, or "Grasp"), with
 * `subtitle` under it where there is one ("Admin"). It is a heading, not a
 * control: the mark centres over the menu's icons, open or folded, so it
 * never moves as the sidebar folds, and the fold button ends where the
 * menu's buttons end.
 *
 * Given a `toggleLabel`, it holds the sidebar's own fold too: a button on
 * its right while the sidebar is open; folded to the rail, it lies over the
 * mark, which turns into it where the pointer or the keyboard is on it. It
 * goes at once as the sidebar folds, rather than fading where it lands.
 */
function BrandHeader({
  title,
  subtitle,
  toggleLabel,
}: {
  title: string;
  subtitle?: string;
  /** The fold button's name, read out by screen readers; no button when not given. */
  toggleLabel?: string;
}) {
  return (
    <div
      data-slot="brand-header"
      className="group/brand relative flex h-8 min-w-0 items-center gap-2 pl-1.5"
    >
      <GraspMark
        aria-hidden
        className="text-sidebar-foreground ease-sidebar size-5 shrink-0 transition-opacity duration-(--motion-duration) group-data-[collapsible=icon]:group-has-[[data-sidebar=trigger]:focus-visible]/brand:opacity-0 group-data-[collapsible=icon]:group-has-[[data-sidebar=trigger]:hover]/brand:opacity-0"
      />
      <div className="ease-sidebar grid min-w-0 flex-1 leading-tight transition-opacity duration-(--motion-duration) group-data-[collapsible=icon]:opacity-0">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle === undefined ? null : (
          <span className="text-sidebar-foreground/70 truncate text-xs">
            {subtitle}
          </span>
        )}
      </div>
      {toggleLabel === undefined ? null : (
        <SidebarTrigger
          label={toggleLabel}
          className="ease-sidebar text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex-none transition-opacity duration-(--motion-duration) group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-y-0 group-data-[collapsible=icon]:left-0 group-data-[collapsible=icon]:my-auto group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:transition-none group-data-[collapsible=icon]:hover:opacity-100 group-data-[collapsible=icon]:focus-visible:opacity-100"
        />
      )}
    </div>
  );
}

export { BrandHeader };
