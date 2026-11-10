// `@grasp-os/runtime/forms`: what `@grasp-os/ui/form`'s field helpers read
// of a form beside its TanStack state: its submission status, how to
// subscribe to it, and what its validator declares of each field. Not an
// App's import: pages get `useForm` from `@grasp-os/sdk/react` and the
// helpers from `@grasp-os/ui/form`.

export { bindingOf } from "./form.ts";
export type { FormBinding } from "./form.ts";
export type { ValueDescriptor } from "./value-descriptor.ts";
