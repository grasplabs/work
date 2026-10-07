// Demos of the kit's navigation components and the command palette. One
// per component, for the dev-only gallery and its accessibility checks
// (e2e/catalog.e2e.ts).
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@grasp-os/ui/components/navigation-menu";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@grasp-os/ui/components/pagination";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@grasp-os/ui/components/sidebar";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { BookOpenIcon, MessagesSquareIcon } from "lucide-react";

const BreadcrumbDemo = () => (
  <Breadcrumb>
    <BreadcrumbList>
      <BreadcrumbItem>
        <BreadcrumbLink href="#home">Home</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbLink href="#projects">Projects</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Relaunch</BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>
);

const CommandDemo = () => (
  <div className="rounded-lg border">
    <Command>
      <CommandInput placeholder="Type a command" aria-label="Command" />
      <CommandList>
        <CommandEmpty>No command found.</CommandEmpty>
        <CommandGroup heading="Suggestions">
          <CommandItem>New invoice</CommandItem>
          <CommandItem>Open settings</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  </div>
);

const NavigationMenuDemo = () => (
  <NavigationMenu>
    <NavigationMenuList>
      <NavigationMenuItem>
        <NavigationMenuTrigger>Open navigation menu</NavigationMenuTrigger>
        <NavigationMenuContent>
          <NavigationMenuLink href="#guides">Guides</NavigationMenuLink>
        </NavigationMenuContent>
      </NavigationMenuItem>
      <NavigationMenuItem>
        <NavigationMenuLink href="#pricing">Pricing</NavigationMenuLink>
      </NavigationMenuItem>
    </NavigationMenuList>
  </NavigationMenu>
);

const PaginationDemo = () => (
  <Pagination>
    <PaginationContent>
      <PaginationItem>
        <PaginationPrevious href="#page-1" />
      </PaginationItem>
      <PaginationItem>
        <PaginationLink href="#page-1" isActive>
          1
        </PaginationLink>
      </PaginationItem>
      <PaginationItem>
        <PaginationLink href="#page-2">2</PaginationLink>
      </PaginationItem>
      <PaginationItem>
        <PaginationNext href="#page-2" />
      </PaginationItem>
    </PaginationContent>
  </Pagination>
);

const SidebarDemo = () => (
  <SidebarProvider className="min-h-0">
    <div className="overflow-hidden rounded-lg border">
      <Sidebar collapsible="none">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Product</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>
                  <MessagesSquareIcon />
                  Chat
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <BookOpenIcon />
                  Knowledge
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </div>
  </SidebarProvider>
);

const TabsDemo = () => (
  <Tabs defaultValue="account">
    <TabsList>
      <TabsTrigger value="account">Account</TabsTrigger>
      <TabsTrigger value="password">Password</TabsTrigger>
    </TabsList>
    <TabsContent value="account">
      <p className="text-sm">Your name and email.</p>
    </TabsContent>
    <TabsContent value="password">
      <p className="text-sm">Change your password.</p>
    </TabsContent>
  </Tabs>
);

export const navigationDemos = {
  breadcrumb: BreadcrumbDemo,
  command: CommandDemo,
  "navigation-menu": NavigationMenuDemo,
  pagination: PaginationDemo,
  sidebar: SidebarDemo,
  tabs: TabsDemo,
};
