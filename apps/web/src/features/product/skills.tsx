import { Button } from "@cerebro/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@cerebro/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cerebro/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@cerebro/ui/components/field";
import { Input } from "@cerebro/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@cerebro/ui/components/item";
import { Skeleton } from "@cerebro/ui/components/skeleton";
import { Spinner } from "@cerebro/ui/components/spinner";
import { Textarea } from "@cerebro/ui/components/textarea";
import { BookOpenText, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { encoded, mutate, productPath, request } from "./api";
import { ConfirmRemoval } from "./confirm-removal";
import { ErrorAlert, PageBody, PageIntro } from "./feedback";
import { skillListSchema, skillRemovedSchema, skillSavedSchema } from "./types";
import type { SkillView } from "./types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";
const listSkills = async (signal?: AbortSignal) => {
  const value = await request(
    productPath("skills"),
    skillListSchema,
    signal ? { signal } : undefined
  );
  return value.skills;
};

// Company playbooks every agent can activate by name. Agents see only the name
// and description until a task matches; then they read the instructions.
export const SkillsPanel = () => {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  // The skill whose instructions are in the form. Its name is its key.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const reset = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setBody("");
  };
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const listed = await listSkills(controller.signal);
        if (!controller.signal.aborted) {
          setSkills(listed);
          setLoaded(true);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
          setLoaded(true);
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setErrorMessage("");
    setConfirming(null);
    try {
      const message = await action();
      setSkills(await listSkills());
      toast.success(message);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const save = () =>
    run(async () => {
      const saved = await mutate(
        productPath(`skills/${encoded(name)}`),
        { body, description },
        skillSavedSchema,
        "PUT"
      );
      reset();
      return `Saved ${saved.name}. New conversations can use it.`;
    });
  const remove = (skillName: string) =>
    run(async () => {
      await mutate(
        productPath(`skills/${encoded(skillName)}`),
        {},
        skillRemovedSchema,
        "DELETE"
      );
      if (editing === skillName) {
        reset();
      }
      return `Removed ${skillName}.`;
    });
  return (
    <PageBody>
      <PageIntro id="skills-title" title="Playbooks your agents can follow">
        Every agent sees each skill name and description. When a task matches,
        the agent reads the instructions. Changes apply to new conversations.
      </PageIntro>
      {errorMessage ? <ErrorAlert>{errorMessage}</ErrorAlert> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section
          className="flex flex-col gap-3"
          aria-labelledby="skills-list-title"
        >
          <div className="flex min-h-7 items-center justify-between gap-2">
            <h3 id="skills-list-title" className="text-xs font-medium">
              Saved skills
            </h3>
            {editing ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={busy}
                onClick={reset}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                New skill
              </Button>
            ) : null}
          </div>
          {loaded ? null : (
            <div className="flex flex-col gap-2" aria-busy="true">
              <span className="sr-only">Loading skills…</span>
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          )}
          {loaded && skills.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenText aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No skills yet</EmptyTitle>
                <EmptyDescription>
                  Write the first one in the form.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {skills.length > 0 ? (
            <ItemGroup className="gap-2">
              {skills.map((skill) => (
                <Item
                  variant="outline"
                  className={
                    editing === skill.name
                      ? "border-primary bg-secondary/40"
                      : "bg-card"
                  }
                  aria-current={editing === skill.name ? "true" : undefined}
                  key={skill.name}
                >
                  <ItemContent>
                    <ItemTitle className="font-mono">{skill.name}</ItemTitle>
                    <ItemDescription>{skill.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        setEditing(skill.name);
                        setName(skill.name);
                        setDescription(skill.description);
                        setBody(skill.body);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(skill.name)}
                    >
                      Remove
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : null}
        </section>
        <Card>
          <form
            className="contents"
            aria-labelledby="skill-form-title"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <CardHeader>
              <CardTitle>
                <h3 id="skill-form-title">
                  {editing ? `Edit ${editing}` : "New skill"}
                </h3>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="skill-name">Skill name</FieldLabel>
                  <Input
                    id="skill-name"
                    aria-describedby="skill-name-help"
                    autoComplete="off"
                    className="font-mono"
                    placeholder="refund-policy"
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={64}
                    value={name}
                    readOnly={editing !== null}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                  <FieldDescription id="skill-name-help">
                    {editing
                      ? "The name identifies the skill and stays fixed."
                      : "Lowercase letters and numbers, joined by hyphens."}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="skill-description">
                    When to use it
                  </FieldLabel>
                  <Input
                    id="skill-description"
                    aria-describedby="skill-description-help"
                    autoComplete="off"
                    placeholder="Use when a customer asks for a refund."
                    maxLength={1024}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    required
                  />
                  <FieldDescription id="skill-description-help">
                    Agents read this to decide whether the skill fits a task.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="skill-body">Instructions</FieldLabel>
                  <Textarea
                    id="skill-body"
                    className="min-h-64"
                    maxLength={32_000}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    required
                  />
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="gap-2">
              <Button disabled={busy} type="submit">
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Save skill
              </Button>
              {editing ? (
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={reset}
                >
                  Cancel
                </Button>
              ) : null}
            </CardFooter>
          </form>
        </Card>
      </div>
      <ConfirmRemoval
        target={confirming}
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={remove}
      >
        Agents stop seeing this skill in new conversations. This cannot be
        undone.
      </ConfirmRemoval>
    </PageBody>
  );
};
