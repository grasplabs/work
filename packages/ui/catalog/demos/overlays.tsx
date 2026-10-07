// Demos of the kit's overlays: dialogs, sheets, menus and popups. Each opens
// from a trigger named "Open <component>", which e2e/catalog.e2e.ts opens
// from the keyboard and closes with Escape.
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@grasp-os/ui/components/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@grasp-os/ui/components/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@grasp-os/ui/components/menubar";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { toast, Toaster } from "@grasp-os/ui/components/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";

const AlertDialogDemo = () => (
  <AlertDialog>
    <AlertDialogTrigger render={<Button variant="outline" />}>
      Open alert dialog
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete the file?</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

const ContextMenuDemo = () => (
  <ContextMenu>
    <ContextMenuTrigger>
      <div className="text-muted-foreground flex h-32 items-center justify-center rounded-lg border border-dashed text-sm">
        Right-click here
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem>Copy</ContextMenuItem>
      <ContextMenuItem>Paste</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
);

const DialogDemo = () => (
  <Dialog>
    <DialogTrigger render={<Button variant="outline" />}>
      Open dialog
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Share</DialogTitle>
        <DialogDescription>Anyone with the link can view.</DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
);

const DrawerDemo = () => (
  <Drawer>
    <DrawerTrigger render={<Button variant="outline" />}>
      Open drawer
    </DrawerTrigger>
    <DrawerContent>
      <DrawerHeader>
        <DrawerTitle>Filters</DrawerTitle>
        <DrawerDescription>Narrow the list down.</DrawerDescription>
      </DrawerHeader>
    </DrawerContent>
  </Drawer>
);

const DropdownMenuDemo = () => (
  <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" />}>
      Open dropdown menu
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem>Rename</DropdownMenuItem>
      <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

const HoverCardDemo = () => (
  <HoverCard>
    <HoverCardTrigger href="#maya">Maya Jansen</HoverCardTrigger>
    <HoverCardContent>Account manager for Benelux.</HoverCardContent>
  </HoverCard>
);

const MenubarDemo = () => (
  <Menubar>
    <MenubarMenu>
      <MenubarTrigger>File</MenubarTrigger>
      <MenubarContent>
        <MenubarItem>New</MenubarItem>
        <MenubarItem>Open</MenubarItem>
      </MenubarContent>
    </MenubarMenu>
    <MenubarMenu>
      <MenubarTrigger>Edit</MenubarTrigger>
      <MenubarContent>
        <MenubarItem>Undo</MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  </Menubar>
);

const PopoverDemo = () => (
  <Popover>
    <PopoverTrigger render={<Button variant="outline" />}>
      Open popover
    </PopoverTrigger>
    <PopoverContent>
      <PopoverHeader>
        <PopoverTitle>Dimensions</PopoverTitle>
        <PopoverDescription>Set the size of the layer.</PopoverDescription>
      </PopoverHeader>
    </PopoverContent>
  </Popover>
);

const SheetDemo = () => (
  <Sheet>
    <SheetTrigger render={<Button variant="outline" />}>
      Open sheet
    </SheetTrigger>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Edit profile</SheetTitle>
        <SheetDescription>
          Changes are saved when you close it.
        </SheetDescription>
      </SheetHeader>
    </SheetContent>
  </Sheet>
);

const showToast = () => {
  toast.add({ title: "Saved", description: "Your changes are saved." });
};

const ToastDemo = () => (
  <Toaster>
    <Button variant="outline" onClick={showToast}>
      Show a toast
    </Button>
  </Toaster>
);

const TooltipDemo = () => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger render={<Button variant="outline" />}>
        Open tooltip
      </TooltipTrigger>
      <TooltipContent>Add to the library</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

export const overlayDemos = {
  "alert-dialog": AlertDialogDemo,
  "context-menu": ContextMenuDemo,
  dialog: DialogDemo,
  drawer: DrawerDemo,
  "dropdown-menu": DropdownMenuDemo,
  "hover-card": HoverCardDemo,
  menubar: MenubarDemo,
  popover: PopoverDemo,
  sheet: SheetDemo,
  toast: ToastDemo,
  tooltip: TooltipDemo,
};
