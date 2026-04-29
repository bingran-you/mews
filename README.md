# mews: represent you to finish all the work, when you are sleeping.

`mews` is a local GitHub notification daemon for a small set of repos you
explicitly allow. It polls notifications, keeps a local inbox under
`~/.mews/`, serves a browser dashboard, and can dispatch Codex CLI or Claude
Code work for actionable items.

The daemon only acts on repos you pass through `--allow-repo`. That keeps the
runtime predictable and avoids accidentally scanning or scheduling work for the
rest of your GitHub account.

## Requirements

- Node.js 20+
- pnpm 10+
- GitHub CLI (`gh`) authenticated for the host you want to poll
- Playwright Chromium only when you run the live end-to-end harness

## Install From npm

```bash
npm install -g @bingran/mews
mews --version
```

## Install From Source

```bash
pnpm install
pnpm build
pnpm link --global
mews --version
```

## Quickstart

```bash
mews install --allow-repo bingran-you/mews
mews status
```

Then open `http://127.0.0.1:7878/dashboard`.

Daemon-starting commands require an explicit repo scope:

```bash
mews start --allow-repo owner/repo
mews start --allow-repo owner/repo,owner/*
```

Use `mews help <command>` or `mews <command> --help` for command details.

## Command Overview

- `mews install --allow-repo ...` checks `gh`, writes `config.yaml` if needed, and starts the daemon
- `mews start --allow-repo ...` launches the daemon in the background
- `mews stop` stops the background daemon
- `mews status` prints the current lock and runtime status
- `mews doctor` diagnoses auth, lock, and runtime state
- `mews poll` runs one notifications poll without starting the daemon
- `mews watch` opens the local TUI inbox
- `mews run-once --allow-repo ...` runs one full daemon cycle and exits

## Development

```bash
pnpm verify
```

That runs the same build, typecheck, and unit test flow used in CI.

For the repo-scoped live harness that starts the real background service and
verifies the dashboard end to end:

```bash
pnpm e2e:live
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local development loop and the
live end-to-end harness.
