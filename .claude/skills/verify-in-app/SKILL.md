---
name: verify-in-app
description: "Verify a UI change in the running app before calling it done. Brings up the local stack (Supabase + UI + engine), runs `pnpm verify:ui` with the width/theme matrix or a scripted scenario in `.context/verify/`, inspects every capture, and reports what was clicked, the errors found, and what could not be tested. Use whenever a change shows anywhere in the app — a screen, dialog, button, flow, or an API route the UI calls."
---

# verify-in-app: see the change working before calling it done

Tests and typecheck are not enough. A change that shows anywhere is done only after it has been
seen working in the running app, on the **local stack only** — never on production, which carries
live Stripe keys and provisions real users on every page load.

## 1. Bring up the local stack

```bash
pnpm db:start          # local Supabase (Docker) on 127.0.0.1:54421
```

Then the UI needs `apps/ui/.env` pointing at the local stack. On a checkout without the private
`cloud/` folder there is no `pnpm cloud env:local`; copy the values from `supabase status` output
(API URL `http://127.0.0.1:54421`, anon + service-role keys) into `apps/ui/.env` with
`NEXT_PUBLIC_APP_URL=http://localhost:3050`.

```bash
pnpm dev:ui            # hub on CONDUCTOR_PORT (default 3050)
```

For changes that need the engine to answer (coworkers, sessions, runner approvals, imports):

```bash
cd apps/engine
RERUN_PORT=3051 \
RERUN_API_KEY=<the engine_api_key the UI uses> \
RERUN_HUB_BASE_URL=http://localhost:3050 \
pnpm dev
```

`RERUN_HUB_BASE_URL` is not optional: without it the foreman's hub tools (`create_agent`,
`search_docs`, …) fail with "Service catalog is unavailable" and coworker flows silently stall.
The engine API key the UI expects lives in the local `engine_pool` row (or `apps/ui/.env`).

## 2. Run the verifier

```bash
pnpm verify:ui /path1 /path2                 # every width (375/768/1440) + short viewport, both themes
pnpm verify:ui --scenario .context/verify/flow.mjs
pnpm verify:ui --engine --scenario …         # also boots an engine with data in .context/verify/engine-data
pnpm verify:ui --fresh /                     # brand-new throwaway account for signup/onboarding flows
```

`verify:ui` signs in as `verify-<workspace>@rerun.local` through the app's own magic-link page —
no credentials needed. Mail lands in the local Mailpit (`http://127.0.0.1:54424`); if a flow asks
for a code, read it there. The account persists between runs; `--fresh` deletes it first.

A scenario is a module whose default export gets `{ page, step, base, admin, workspaceId }`:
`await step('name')` captures a PNG at that point. `page` is a Playwright page already signed in,
`admin` a service-role client to seed data. Existing scenarios live in `.context/verify/*.mjs` —
read one before writing yours, and scope selectors to the dialog/panel under test (strict mode
fails on duplicate inputs).

## 3. Look at every capture

Everything lands in `.context/verify/<timestamp>/` — one PNG per path/width/theme plus
`report.json` with console errors, failed requests, and load timings. Open the PNGs, not just the
report: horizontal overflow, clipped footers, and broken stacking only show in the image. Check
the mobile width (375px) and the short viewport — the house rule is responsive from the first
version.

## 4. Report honestly

The final message shows: the captures, what was clicked, the console errors and failed requests
found, what was fixed and re-verified, and **plainly what could not be tested** (missing
credentials, flows behind paid plans, engine features with no local provider). Never claim a
surface works from tests alone, and never hide a failure behind a passing unit test.
