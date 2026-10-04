// An app's tile, as the prototype draws it (`components/app-logo.tsx`): its
// first letter on a light tile. The catalog carries no logos, so the letter
// stands in for every app.

const tileClass = {
  default:
    "bg-tile text-tile-foreground flex size-9 flex-none items-center justify-center rounded-md border text-xs font-medium",
  sm: "bg-tile text-tile-foreground flex size-7 flex-none items-center justify-center rounded-md border text-xs font-medium",
  lg: "bg-tile text-tile-foreground flex size-14 flex-none items-center justify-center rounded-2xl border text-2xl font-medium shadow-xs",
} as const;

/** The app's tile; its name is said beside it, so the letter is hidden from assistive technology. */
export const AppLogo = ({
  name,
  size = "default",
}: {
  name: string;
  size?: keyof typeof tileClass;
}) => (
  <div aria-hidden="true" className={tileClass[size]}>
    {name.charAt(0).toLocaleUpperCase()}
  </div>
);
