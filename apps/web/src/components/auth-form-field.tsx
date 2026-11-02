import { Field, FieldError, FieldLabel } from "@cerebro/ui/components/field";
import { Input } from "@cerebro/ui/components/input";

export const AuthFormField = ({
  name,
  label,
  type,
  value,
  onBlur,
  onChange,
  errors,
}: {
  name: string;
  label: string;
  type?: "email" | "password";
  value: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  errors: readonly ({ message: string } | undefined)[];
}) => (
  <Field data-invalid={errors.length > 0 || undefined}>
    <FieldLabel htmlFor={name}>{label}</FieldLabel>
    <Input
      id={name}
      name={name}
      type={type}
      value={value}
      aria-invalid={errors.length > 0 || undefined}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
    />
    <FieldError errors={[...errors]} />
  </Field>
);
