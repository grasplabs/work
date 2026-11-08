// What `@grasp-os/ui/form`'s field helpers read of a form beside its
// TanStack state: its submission status, how to subscribe to it, and what
// its validator declares of each field. Not an App's import: the App
// compiler offers pages `@grasp-os/sdk/react` and the helpers, never
// this.

export { bindingOf } from "./form.ts";
export type { FormBinding } from "./form.ts";
export type { ValueDescriptor } from "./value-descriptor.ts";
