// `@grasp-os/runtime/forms`: what `@grasp-os/app-kit`'s form field helpers
// read beside their TanStack state: a form's submission status, how to
// subscribe to it, and what its validator declares of each field. Not an
// App's import: pages get `useForm` from `@grasp-os/sdk/react` and the
// components from `@grasp-os/app-kit`.
export { bindingOf } from "./form-binding.ts";
export type { FormBinding } from "./form-binding.ts";
export type { ValueDescriptor } from "./value-descriptor.ts";
