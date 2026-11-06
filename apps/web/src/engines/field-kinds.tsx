import type { FieldKind, FieldType } from "@grasp-os/shared/data-model";
import type { FieldTypeOption } from "@grasp-os/ui/components/data-model";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  AtSignIcon,
  BracesIcon,
  CalendarIcon,
  CircleDotIcon,
  BanknoteIcon,
  HashIcon,
  LinkIcon,
  PaperclipIcon,
  ToggleLeftIcon,
  TypeIcon,
  UserIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// The kinds of field a person picks in an App's Data view, as a no-code
// tool names them: each with its icon and what it holds. `other` is a type
// only code declares (a list, an object), shown but never picked.

/** The kinds a person picks, in the picker's order. */
export const pickedKinds = [
  "text",
  "number",
  "boolean",
  "date",
  "choice",
  "link",
  "person",
  "email",
  "file",
  "money",
] as const satisfies readonly FieldKind[];

const kindIcons: Record<FieldKind, LucideIcon> = {
  text: TypeIcon,
  email: AtSignIcon,
  number: HashIcon,
  boolean: ToggleLeftIcon,
  date: CalendarIcon,
  choice: CircleDotIcon,
  link: LinkIcon,
  person: UserIcon,
  file: PaperclipIcon,
  money: BanknoteIcon,
  other: BracesIcon,
};

const kindLabels: Record<FieldKind, MessageDescriptor> = {
  text: msg({ message: "Text", context: "a kind of field" }),
  email: msg({ message: "Email", context: "a kind of field" }),
  number: msg({ message: "Number", context: "a kind of field" }),
  boolean: msg({ message: "Yes or no", context: "a kind of field" }),
  date: msg({ message: "Date", context: "a kind of field" }),
  choice: msg({ message: "Choice", context: "a kind of field" }),
  link: msg({ message: "Link to a table", context: "a kind of field" }),
  person: msg({ message: "Person", context: "a kind of field" }),
  file: msg({ message: "File", context: "a kind of field" }),
  money: msg({ message: "Money", context: "a kind of field" }),
  other: msg({ message: "Set in code", context: "a kind of field" }),
};

const kindDescriptions: Record<FieldKind, MessageDescriptor> = {
  text: msg`Words and sentences`,
  email: msg`An email address`,
  number: msg`Amounts, counts and scores`,
  boolean: msg`A tick: yes or no`,
  date: msg`A day and time`,
  choice: msg`One of a list of options`,
  link: msg`A record of another table`,
  person: msg`Someone in your organization`,
  file: msg`A document or an image`,
  money: msg`An amount in a currency`,
  other: msg`A type the App's code declares`,
};

/** A kind's icon. */
export const KindIcon = ({ kind }: { kind: FieldKind }) => {
  const Icon = kindIcons[kind];
  return <Icon />;
};

/** The words for each kind, and the picker's options, in the page's language. */
export const useFieldKinds = () => {
  const { i18n } = useLingui();
  const label = (kind: FieldKind): string => i18n._(kindLabels[kind]);
  const options: FieldTypeOption[] = pickedKinds.map((kind) => ({
    value: kind,
    label: label(kind),
    description: i18n._(kindDescriptions[kind]),
    icon: <KindIcon kind={kind} />,
  }));
  /** What a field of `type` is, in a few words: its kind, a choice's options, a link's table. */
  const describe = (type: FieldType): string => {
    if (type.kind === "link") {
      const { table } = type;
      return i18n._(msg`Link to ${table}`);
    }
    return label(type.kind);
  };
  return { label, options, describe };
};
