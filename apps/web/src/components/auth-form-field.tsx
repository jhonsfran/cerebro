import { Input } from "@cerebro/ui/components/input";
import { Label } from "@cerebro/ui/components/label";

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
  <div className="space-y-2">
    <Label htmlFor={name}>{label}</Label>
    <Input
      id={name}
      name={name}
      type={type}
      value={value}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
    />
    {errors.map((error) => (
      <p key={error?.message} className="text-red-500">
        {error?.message}
      </p>
    ))}
  </div>
);
