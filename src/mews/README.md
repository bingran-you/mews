# `mews`

Local daemon that monitors GitHub notifications for an allow-listed set of
repositories, keeps a triaged inbox, exposes a browser dashboard, and can
dispatch local coding agents in the background.

## What's In This Directory

```text
mews/
├── README.md              # product overview
├── cli.ts                 # dispatcher
├── version.ts             # runtime package version resolver
└── engine/
    ├── commands/          # install, start, stop, poll, watch, doctor, cleanup, status, status-manager
    ├── daemon/            # long-lived process: broker, bus, claim, dispatcher, poller, runner, scheduler, …
    ├── runtime/           # classifier, config, identity helpers
    ├── bridge.ts          # integration with the umbrella CLI
    └── statusline.ts      # zero-dep bundle consumed by the Claude Code statusline hook
```

## Commands

### Primary

| Command | Role |
|---------|------|
| `mews install --allow-repo owner/repo` | Check `gh` / auth, create `~/.mews/config.yaml`, and start the daemon. Statusline hook wiring is a separate manual step. |
| `mews start --allow-repo owner/repo` | Launch the daemon in the background |
| `mews stop` | Stop the daemon and remove its lock |
| `mews status` | Print current daemon/runtime status |
| `mews doctor` | Diagnose daemon / gh login / runtime health |
| `mews watch` | Interactive TUI inbox (Ink) |
| `mews poll [--allow-repo owner/repo]` | One-shot inbox poll without requiring the daemon |

### Advanced / internal

| Command | Role |
|---------|------|
| `mews run --allow-repo owner/repo` / `mews daemon --allow-repo owner/repo` | Run the broker loop in the foreground |
| `mews run-once --allow-repo owner/repo` | Run one poll cycle, wait for drain, then exit |
| `mews cleanup` | Clear stale state |
| `mews statusline` | CLI shim that executes the pre-bundled `dist/mews-statusline.js` hook |
| `mews status-manager` | Internal helper used by mews runners |
| `mews poll-inbox` | Legacy alias for `poll` |

Run `mews --help` for the authoritative list.

Daemon-starting commands (`install`, `start`, `run`, `daemon`, `run-once`)
must be given `--allow-repo <owner/repo[,owner/*,...]>` so mews never
falls back to scanning every notification on the account.

## Runtime Constraints

`engine/statusline.ts` is bundled separately (`dist/mews-statusline.js`) and
is called every few seconds by the Claude Code statusline hook. It must stay
zero-dep and cold-start under 30ms — do not import `ink`, `zod`, or the
umbrella CLI from it.

## Related

- Assets (SSE dashboard HTML): [`assets/dashboard.html`](../../../assets/dashboard.html)
- Tests: [`tests/mews/`](../../../tests/mews)
