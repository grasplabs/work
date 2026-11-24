import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
  useFieldControl,
} from "@grasp-os/ui/components/field";
import type { FieldControlProps } from "@grasp-os/ui/components/field";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { InfoTip } from "../frame/info-tip.tsx";

// One setting as a row of its card, as #2503's agents and Stephen's
// settings draw it (the old library's setting row): its name, a short
// line under it, more about it behind an info mark, and its control on the
// row's end edge; why its last change didn't save under it. Damsko folds
// the old row into a responsive Field, which this composes; the info mark
// is the product's (frame/info-tip.tsx).

const styles = stylex.create({
  // The name and its info mark on one line, as #2503's setting row: a long
  // name wraps beside the mark, never above it. The mark stays outside the
  // label, so the control's name is the setting's alone.
  named: {
    display: "flex",
    alignItems: "center",
    gap: space[1],
    width: "fit-content",
    minWidth: 0,
  },
  // The mark in a box one line tall: its button may be taller, the row never is.
  mark: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
  },
  // A fact's value where the rows' controls stand, in the text's colour.
  value: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
});

/** What a row hands a control that is not one of Damsko's own. */
type Wiring = Pick<FieldControlProps, "id" | "aria-describedby">;

/** The control, handed the row's wiring when it asks for it. */
const Control = ({
  children,
}: {
  children: (field: Wiring) => ReactNode;
}): ReactNode => {
  const field = useFieldControl();
  return children({
    ...(field?.id === undefined ? {} : { id: field.id }),
    ...(field?.["aria-describedby"] === undefined
      ? {}
      : { "aria-describedby": field["aria-describedby"] }),
  });
};

/** A setting's name with its info mark beside it. */
const Named = ({ name, info }: { name: ReactNode; info: ReactNode }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.named)}>
      {name}
      <span {...stylex.props(styles.mark)}>
        <InfoTip label={t`More about this setting`}>{info}</InfoTip>
      </span>
    </div>
  );
};

export const SettingRow = ({
  label,
  help,
  info,
  error,
  children,
}: {
  /** The setting's name. */
  label: string;
  /** One short line under it. */
  help?: ReactNode;
  /** More about it, behind an info mark beside its name. */
  info?: ReactNode;
  /** Why its last change didn't save, under it. */
  error?: string | undefined;
  /** The control; as a function, handed the id its name labels. */
  children: ReactNode | ((field: Wiring) => ReactNode);
}) => {
  const name = <FieldLabel>{label}</FieldLabel>;
  return (
    <Field
      orientation="responsive"
      {...(error === undefined ? {} : { "data-invalid": true })}
    >
      <FieldContent>
        {info === undefined ? name : <Named info={info} name={name} />}
        {help === undefined ? null : (
          <FieldDescription>{help}</FieldDescription>
        )}
        {error === undefined ? null : <FieldError>{error}</FieldError>}
      </FieldContent>
      {typeof children === "function" ? (
        <Control>{children}</Control>
      ) : (
        children
      )}
    </Field>
  );
};

/** A fact as a row of its card: its name, a line under it, and its value where a control would stand. */
export const FactRow = ({
  label,
  help,
  info,
  children,
}: {
  label: string;
  help?: ReactNode;
  info?: ReactNode;
  children: ReactNode;
}) => {
  const name = <FieldTitle>{label}</FieldTitle>;
  return (
    <Field orientation="responsive">
      <FieldContent>
        {info === undefined ? name : <Named info={info} name={name} />}
        {help === undefined ? null : (
          <FieldDescription>{help}</FieldDescription>
        )}
      </FieldContent>
      <span {...stylex.props(styles.value)}>{children}</span>
    </Field>
  );
};
