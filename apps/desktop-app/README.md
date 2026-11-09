# desktop-app

Electron shell for Rerun (Tier-0 of `rerun-desktop/DESIGN.md`). The renderer is
the regular Next.js UI — this app only owns the window, an engine sidecar, the
tray, notifications and `rerun://` deep links. The renderer never talks to the
engine directly; it keeps using the UI's own `/api/*` proxy exactly like the web
app.

> Naming: this package is `desktop-app` on purpose. `apps/engine/src/desktop/`
> and the `/desktop` routes are the agent virtual-screen (VNC) feature — unrelated.

## What works (verified)

- **Window** loads `DESKTOP_UI_URL` / `RERUN_UI_URL` (default
  `http://localhost:3050`), context isolation on, `nodeIntegration` off,
  sandboxed preload (`src/preload/index.cts` → `dist/preload/index.cjs`).
- **Engine sidecar**: main spawns `apps/engine` (`dist/cli/bin.js run`, falling
  back to `tsx src/cli/bin.ts run`, or `DESKTOP_ENGINE_CMD`) with
  `RERUN_HOST=127.0.0.1`, a free port starting at `DESKTOP_ENGINE_PORT`
  (default 3051, increments on conflict), a generated `RERUN_API_KEY`, and
  `RERUN_DATA_DIR`. Health-polled on `/health`, restarted with backoff (max 5),
  SIGTERM→SIGKILL on quit.
- **Tray** icon (reuses `apps/ui/public/icon-192.png`) with engine state in the
  menu/tooltip; the tray title shows the pending runner-approval count, polled
  from `GET /local-runner/pending` with the sidecar API key.
- **Notifications**: new pending approvals and run status transitions
  (`done`/`error`/`cancelled`, polled via `GET /agents` +
  `GET /agents/:id/runs`) raise native `Notification`s; clicking focuses the
  window.
- **Deep links**: `rerun://…` is registered via `setAsDefaultProtocolClient`;
  `open-url` / `second-instance` / in-window `will-navigate` all route the path
  into the UI (`rerun://agents/x` → `/agents/x`).
- Persisted config in `userData/desktop-config.json` (UI URL, engine port, API
  key, data dir, poll interval).

## Stubbed / not done

- **Push-to-talk global hotkey: TODO.** Needs mic capture + permission flow;
  skipped per Tier-0 scope (no native modules required for `globalShortcut`
  itself, but the voice pipeline is P2 in the design doc).
- **Runner management UI** (pair/start/stop `rerun local-runner`) — engine APIs
  exist; no desktop UI yet (P1).
- **Engine `/desktop/events` SSE** — polling fallback is used instead (design
  doc option a).
- **Packaging/dist: out of scope.** No `electron-builder`, no signing,
  notarization, or bundled `next start` sidecar. `pnpm build` is `tsc` only.
- OAuth redirects that leave the UI origin are opened in the system browser;
  the `rerun://` auth callback path is wired but Supabase redirect-URL
  configuration is not part of this slice.

## Run

```bash
pnpm install
pnpm --filter rerun-engine build   # once, so the sidecar has dist/cli/bin.js
pnpm --filter desktop-app dev      # tsc + electron .
# or: pnpm --filter desktop-app build && pnpm --filter desktop-app start
```

The UI must already be running (`pnpm --filter rerun dev` → :3050) — this app
does not spawn it yet (packaged mode will, per DESIGN.md §2.1).

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `DESKTOP_UI_URL` / `RERUN_UI_URL` | `http://localhost:3050` | UI origin the window loads |
| `DESKTOP_ENGINE_PORT` | `3051` | First port tried for the sidecar (increments on conflict) |
| `DESKTOP_ENGINE_DATA_DIR` / `RERUN_DATA_DIR` | `~/.rerun` | Engine `RERUN_DATA_DIR` |
| `DESKTOP_ENGINE_CMD` | — | Full command line override for the engine process |
| `DESKTOP_POLL_INTERVAL_MS` | `15000` | Approval/run poll interval (min 2000) |
| `DESKTOP_ENGINE_BOOT_TIMEOUT_MS` | `90000` | `/health` wait before restart |
| `RERUN_HUB_BASE_URL`, `RERUN_LOG_LEVEL`, `RERUN_DESKTOP` | — | Passed through to the engine |

The sidecar `RERUN_API_KEY` is generated once and stored in
`userData/desktop-config.json`; it never reaches the renderer.

## Caveats

- The UI reaches the engine through `engine_pool.engine_host` in Supabase —
  the sidecar is a standalone instance; pointing the UI at it is a separate
  (Supabase/config) step, same as running `rerun run` by hand today.
- Port probing binds `127.0.0.1`; a wildcard (`0.0.0.0`) listener on the same
  port does not block it on macOS — loopback traffic still reaches the sidecar.
- `ELECTRON_RUN_AS_NODE=1` in the environment makes `electron .` run as plain
  Node; unset it if the app fails to start with module errors.
