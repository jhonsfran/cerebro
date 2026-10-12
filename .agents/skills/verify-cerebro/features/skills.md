# Company skills

An administrator saves a company playbook, edits its instructions, and removes it. Agents see its name and description in new conversations.

## Sub-features

- `skill-create` saves a name, description, and instructions.
- `skill-edit` loads an existing skill into the form and updates it.
- `skill-remove` removes that skill.

## How to get to it (user POV)

- On `/dashboard`, choose `Skills` in Administration.
- Use the form's `Save skill` control.
- In a saved skill's row, choose `Edit` or `Remove`.

## Driving it with CUA

Preconditions:

- The owner is signed in. No skill is named `verification-playbook`.

- **Open.** Run `await tab.playwright.getByRole("navigation", { name: "Administration" }).getByRole("button", { name: /Skills/ }).click()`. Require `Playbooks your agents can follow`.
- **Create.** Fill `getByLabel("Skill name", { exact: true })` with `verification-playbook`, `When to use it` with `Use for local verification requests.`, and `Instructions` with `Answer with the local verification result.`. Click `getByRole("button", { name: "Save skill", exact: true })`. Require the saved row and success output. Reload, reopen Skills, and require it again. `observe` must contain the exact saved name, description, and body.
- **Edit.** Scope the row with `tab.playwright.locator(".access-row").filter({ hasText: "verification-playbook" })`. Click its `Edit` button. Require the form to show the saved content. Change `Instructions` to `Report the observed local verification result.`, save, reload, and reopen Edit. Require that exact new value and match it in `observe`.
- **Remove.** Click the same row's `Remove` button. Require `Removed verification-playbook.` and no row after reload. `observe` must no longer contain that skill. This action applies only to this run's synthetic playbook.

## Gotchas

- Skill names use lowercase letters, digits, and single hyphens, up to 64 characters.
- Saving an existing name updates the skill. Use the Edit path to prove form loading too.
- Skills apply to new conversations. Existing conversations do not prove a new skill reached the model.
- The fixed fake model does not prove that a real model follows the playbook. Keep storage/UI proof separate from live-model behavior.
