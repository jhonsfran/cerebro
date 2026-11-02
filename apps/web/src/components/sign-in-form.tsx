import { Button } from "@cerebro/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@cerebro/ui/components/card";
import { FieldGroup } from "@cerebro/ui/components/field";
import { Spinner } from "@cerebro/ui/components/spinner";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { z } from "zod";

import { authClient } from "@/lib/auth-client";

import { AuthFormField } from "./auth-form-field";
import Loader from "./loader";

const SignInForm = ({ onSwitchToSignUp }: { onSwitchToSignUp: () => void }) => {
  const navigate = useNavigate({
    from: "/",
  });
  const { isPending } = authClient.useSession();

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    onSubmit: async ({ value }) => {
      await authClient.signIn.email(
        {
          email: value.email,
          password: value.password,
        },
        {
          onSuccess: () => {
            navigate({
              to: "/dashboard",
            });
            toast.success("Sign in successful");
          },
          onError: (error) => {
            toast.error(error.error.message || error.error.statusText);
          },
        }
      );
    },
    validators: {
      onSubmit: z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    },
  });

  if (isPending) {
    return <Loader />;
  }

  return (
    <main className="flex min-h-full items-start justify-center px-4 py-10 md:items-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="font-display text-2xl font-normal">Welcome back</h1>
          </CardTitle>
          <CardDescription>Sign in to your company workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="email">
                {(field) => (
                  <AuthFormField
                    name={field.name}
                    label="Email"
                    type="email"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    errors={field.state.meta.errors}
                  />
                )}
              </form.Field>

              <form.Field name="password">
                {(field) => (
                  <AuthFormField
                    name={field.name}
                    label="Password"
                    type="password"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    errors={field.state.meta.errors}
                  />
                )}
              </form.Field>

              <form.Subscribe
                selector={(state) => ({
                  canSubmit: state.canSubmit,
                  isSubmitting: state.isSubmitting,
                })}
              >
                {({ canSubmit, isSubmitting }) => (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!canSubmit || isSubmitting}
                  >
                    {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                    {isSubmitting ? "Submitting…" : "Sign In"}
                  </Button>
                )}
              </form.Subscribe>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="link" type="button" onClick={onSwitchToSignUp}>
            Need an account? Sign Up
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
};

export default SignInForm;
