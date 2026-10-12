# Account and workspace setup

A person can create an account, sign in, claim the fresh installation with its token, and sign out.

## Sub-features

- `account-signup` creates a disposable local account and opens the dashboard.
- `account-signin` signs in with that account after signout.
- `workspace-claim` gives the first account ownership of the fresh workspace.
- `account-signout` removes authenticated access.

## How to get to it (user POV)

- Open `/login`, or choose `Sign In` in the public page header. The initial form is `Create Account`.
- Choose `Already have an account? Sign In` for the signin form.
- After signup or signin, open `/dashboard`. A fresh installation shows `Set up your company assistant.`
- Choose the signed-in user's name in the header, then `Sign Out`.

## Driving it with CUA

Preconditions:

- Doctor passes. The browser profile has no conflicting localhost session.
- The stack has no user or workspace claim for the signup/claim path.

- **Create account.** Fill `Name`, `Email`, and `Password` using the exact `getByLabel` recipe in SKILL.md. Click `getByRole("button", { name: "Sign Up", exact: true })`. Require `/dashboard` and the setup heading. Capture the empty form before filling secrets and the dashboard after submission.
- **Claim workspace.** Read `control.mjs token`. Run `await tab.playwright.getByLabel("Installation token", { exact: true }).fill(token)` with that value, then `await tab.playwright.getByRole("button", { name: "Set up workspace", exact: true }).click()`. Require `Create your first agent` and owner administration controls. Reload, then require that setup stays complete. `observe` must show one user and one setup claim.
- **Sign out.** Run `await tab.playwright.getByRole("button", { name: "Verification Owner", exact: true }).click()`, inspect the menu, then `await tab.playwright.getByRole("menuitem", { name: "Sign Out", exact: true }).click()`. Opening `/dashboard` must redirect to `/login`.
- **Sign in.** At `/login`, click `getByRole("button", { name: "Already have an account? Sign In", exact: true })`. Fill the same `Email` and `Password`, then click `tab.playwright.locator("form").getByRole("button", { name: "Sign In", exact: true })`. Require the saved workspace at `/dashboard` without a second setup claim.

## Gotchas

- The password field and installation token are secrets even in a local test. Do not retain them in artifacts.
- The default login form is signup. The public header's `Sign In` does not select the signin form automatically.
- Scope the signin submit button to `form`. The public header also has a button named `Sign In`.
- Setup needs the generated token and permits only one owner claim. Never claim the user's real installation.
- An API signup or setup call is fixture preparation, not proof of the browser form.
