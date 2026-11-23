import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { Button } from "@grasp-os/ui/components/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@grasp-os/ui/components/carousel";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import { Container } from "@grasp-os/ui/components/container";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@grasp-os/ui/components/context-menu";
import {
  Dialog,
  DialogBody,
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
  HoverCardDescription,
  HoverCardTitle,
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
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@grasp-os/ui/components/navigation-menu";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  Pagination,
  PaginationContent,
  PaginationNext,
  PaginationPrevious,
  PaginationRange,
} from "@grasp-os/ui/components/pagination";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@grasp-os/ui/components/resizable";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import { Section, SectionHeader } from "@grasp-os/ui/components/section-header";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
  SidePanelText,
} from "@grasp-os/ui/components/side-panel";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarLevel,
  SidebarLevelHeader,
  SidebarLevels,
  SidebarLevelTitle,
  SidebarLevelTrigger,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@grasp-os/ui/components/sidebar";
import { Stepper } from "@grasp-os/ui/components/stepper";
import { TableOfContents } from "@grasp-os/ui/components/table-of-contents";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { toast, Toaster } from "@grasp-os/ui/components/toast";
import { TreeView } from "@grasp-os/ui/components/tree-view";
import {
  ChevronLeftIcon,
  Icon,
  InboxIcon,
  SettingsIcon,
} from "@grasp-os/ui/lib/icons";

import type { Demos } from "./demo.ts";

// Damsko's overlays and navigation, one small use of each, for the local
// gallery (routes/kit_.damsko.tsx). An overlay is shown by its trigger:
// what it opens is tested in Damsko.

const showToast = () => {
  toast.success("Saved", { description: "Your changes are saved." });
};

export const overlayDemos: Demos = {
  "alert-dialog": () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete the workspace</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  breadcrumb: () => (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#knowledge">Knowledge</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Onboarding guide</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
  carousel: () => (
    <Carousel aria-label="Looks">
      <CarouselContent>
        <CarouselItem>One</CarouselItem>
        <CarouselItem>Two</CarouselItem>
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
  command: () => (
    <Command>
      <CommandInput placeholder="Search" />
      <CommandList>
        <CommandEmpty>Nothing found</CommandEmpty>
        <CommandGroup heading="Go to">
          <CommandItem value="chat">Chat</CommandItem>
          <CommandItem value="brain">Brain</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
  container: () => <Container size="sm">The column of a page.</Container>,
  "context-menu": () => (
    <ContextMenu>
      <ContextMenuTrigger aria-label="A line">
        Right-click this line
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Rename</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
  dialog: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Rename</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename the document</DialogTitle>
          <DialogDescription>Everyone sees the new name.</DialogDescription>
        </DialogHeader>
        <DialogBody>Its links stay the same.</DialogBody>
      </DialogContent>
    </Dialog>
  ),
  drawer: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Open the drawer</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Filters</DrawerTitle>
          <DrawerDescription>Narrow what the list shows.</DrawerDescription>
        </DrawerHeader>
      </DrawerContent>
    </Drawer>
  ),
  "dropdown-menu": () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">More</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  "hover-card": () => (
    <HoverCard>
      <HoverCardTrigger href="#anna">Anna de Vries</HoverCardTrigger>
      <HoverCardContent>
        <HoverCardTitle>Anna de Vries</HoverCardTitle>
        <HoverCardDescription>Leads Finance.</HoverCardDescription>
      </HoverCardContent>
    </HoverCard>
  ),
  menubar: () => (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>New document</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  ),
  "navigation-menu": () => (
    <NavigationMenu aria-label="Site">
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuLink href="#docs">Docs</NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  ),
  "page-header": () => (
    <PageHeader description="Who can do what." title="Members" />
  ),
  pagination: () => (
    <Pagination pageSize={10} total={48}>
      <PaginationRange />
      <PaginationContent>
        <PaginationPrevious />
        <PaginationNext />
      </PaginationContent>
    </Pagination>
  ),
  resizable: () => (
    <div className="h-24">
      <ResizablePanelGroup>
        <ResizablePanel>List</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel>Detail</ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
  "scroll-area": () => (
    <div className="h-16">
      <ScrollArea aria-label="Notes">
        <p>One line.</p>
        <p>Another line.</p>
        <p>A third line.</p>
        <p>A fourth line.</p>
      </ScrollArea>
    </div>
  ),
  "section-header": () => (
    <Section>
      <SectionHeader description="Kept for a year." title="Audit log" />
    </Section>
  ),
  sheet: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open the sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>About this run.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
  "side-panel": () => (
    <SidePanel aria-label="Details">
      <SidePanelHeader title="Invoice intake" />
      <SidePanelContent>
        <SidePanelText>Runs when an invoice arrives.</SidePanelText>
      </SidePanelContent>
    </SidePanel>
  ),
  sidebar: () => (
    <SidebarProvider>
      <Sidebar collapsible="none">
        <SidebarLevels defaultValue="main">
          <SidebarLevel value="main">
            <SidebarContent>
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive>
                      <a href="#inbox">
                        <Icon icon={InboxIcon} />
                        Inbox
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarLevelTrigger value="settings">
                      <Icon icon={SettingsIcon} />
                      Settings
                    </SidebarLevelTrigger>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
          </SidebarLevel>
          <SidebarLevel value="settings">
            <SidebarLevelHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarLevelTrigger value="main">
                    <Icon icon={ChevronLeftIcon} />
                    Back
                  </SidebarLevelTrigger>
                </SidebarMenuItem>
              </SidebarMenu>
              <SidebarLevelTitle>
                <Icon icon={SettingsIcon} />
                Settings
              </SidebarLevelTitle>
            </SidebarLevelHeader>
            <SidebarContent aria-label="Settings">
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <a href="#profile">Profile</a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
          </SidebarLevel>
        </SidebarLevels>
      </Sidebar>
    </SidebarProvider>
  ),
  stepper: () => (
    <Stepper
      aria-label="Setup"
      steps={[{ label: "Connect" }, { label: "Invite" }, { label: "Go" }]}
      value={1}
    />
  ),
  "table-of-contents": () => (
    <TableOfContents
      items={[
        { id: "install", label: "Install" },
        { id: "update", label: "Update" },
      ]}
    />
  ),
  tabs: () => (
    <Tabs defaultValue="runs">
      <TabsList>
        <TabsTrigger value="runs">Runs</TabsTrigger>
        <TabsTrigger value="traces">Traces</TabsTrigger>
      </TabsList>
      <TabsContent value="runs">Three runs last week.</TabsContent>
      <TabsContent value="traces">No traces yet.</TabsContent>
    </Tabs>
  ),
  toast: () => (
    <>
      <Button onClick={showToast} variant="outline">
        Show a toast
      </Button>
      <Toaster />
    </>
  ),
  "tree-view": () => (
    <TreeView
      aria-label="Files"
      defaultExpandedValue={["src"]}
      items={[
        {
          value: "src",
          label: "src",
          children: [{ value: "src/main.tsx", label: "main.tsx" }],
        },
      ]}
    />
  ),
};
