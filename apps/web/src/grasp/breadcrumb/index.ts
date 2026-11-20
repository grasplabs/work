/* oxlint-disable typescript/no-deprecated -- the breaking release's step 6: the older shape's entry type is exported until step 9 removes it (handover/audit/RELEASE.md §7). */
export {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "./breadcrumb";
export type {
  BreadcrumbEntry,
  BreadcrumbItemProps,
  BreadcrumbLayoutStyle,
  BreadcrumbLinkProps,
  BreadcrumbListProps,
  BreadcrumbPageProps,
  BreadcrumbProps,
} from "./breadcrumb";
