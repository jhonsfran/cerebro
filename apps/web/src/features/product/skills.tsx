import { useEffect, useState } from "react";

import { encoded, mutate, productPath, request } from "./api";
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
  const [notice, setNotice] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const listed = await listSkills(controller.signal);
        if (!controller.signal.aborted) {
          setSkills(listed);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setErrorMessage("");
    setNotice("");
    try {
      const message = await action();
      setSkills(await listSkills());
      setNotice(message);
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
      setName("");
      setDescription("");
      setBody("");
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
      return `Removed ${skillName}.`;
    });
  return (
    <section className="settings-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Skills</p>
          <h2>Playbooks your agents can follow</h2>
        </div>
      </div>
      <p className="muted-text">
        Every agent sees each skill name and description. When a task matches,
        the agent reads the instructions. Changes apply to new conversations.
      </p>
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {notice ? <output className="muted-text">{notice}</output> : null}
      <div className="access-table">
        <div className="access-row access-labels">
          <span>Skill</span>
          <span />
        </div>
        {skills.map((skill) => (
          <div className="access-row" key={skill.name}>
            <div>
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
            </div>
            <span className="row-actions">
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setName(skill.name);
                  setDescription(skill.description);
                  setBody(skill.body);
                }}
              >
                Edit
              </button>
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => remove(skill.name)}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
      </div>
      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor="skill-name">Skill name</label>
        <input
          id="skill-name"
          autoComplete="off"
          placeholder="refund-policy"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={64}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <label htmlFor="skill-description">When to use it</label>
        <input
          id="skill-description"
          autoComplete="off"
          placeholder="Use when a customer asks for a refund."
          maxLength={1024}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
        />
        <label htmlFor="skill-body">Instructions</label>
        <textarea
          id="skill-body"
          rows={10}
          maxLength={32_000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
        />
        <button className="primary-button" disabled={busy} type="submit">
          Save skill
        </button>
      </form>
    </section>
  );
};
