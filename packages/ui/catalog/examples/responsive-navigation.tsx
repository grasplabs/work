// Navigation that fits the screen: links in a row from `md` up, and a menu
// button that opens them in a sheet on a phone. The links are the same list
// in both places; the current page is marked for screen readers too.
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Inline } from "@grasp-os/ui/components/inline";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Stack } from "@grasp-os/ui/components/stack";
import { cn } from "@grasp-os/ui/lib/utils";
import { MenuIcon } from "lucide-react";

const links = [
  { href: "#overview", label: "Overview" },
  { href: "#orders", label: "Orders" },
  { href: "#customers", label: "Customers" },
  { href: "#settings", label: "Settings" },
];

const current = "#orders";

const NavLinks = ({ className }: { className?: string }) => (
  <ul className={cn("flex gap-1", className)}>
    {links.map((link) => (
      <li key={link.href}>
        <a
          href={link.href}
          aria-current={link.href === current ? "page" : undefined}
          className={buttonVariants({
            variant: link.href === current ? "secondary" : "ghost",
          })}
        >
          {link.label}
        </a>
      </li>
    ))}
  </ul>
);

export const ResponsiveNavigationExample = () => (
  <header className="border-b pb-3">
    <Inline justify="between">
      <span className="font-heading font-medium">Shop</span>
      <nav aria-label="Main" className="hidden md:block">
        <NavLinks />
      </nav>
      <Sheet>
        <SheetTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open the menu"
            />
          }
        >
          <MenuIcon />
        </SheetTrigger>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Menu</SheetTitle>
          </SheetHeader>
          <div className="px-4">
            <Stack>
              <nav aria-label="Main">
                <NavLinks className="flex-col" />
              </nav>
            </Stack>
          </div>
        </SheetContent>
      </Sheet>
    </Inline>
  </header>
);
