# Contributing

## Prerequisites

- Node.js 20+
- pnpm 10+
- GitHub CLI (`gh`) authenticated

Install dependencies once:

```bash
pnpm install
```

## Local Checks

Run the standard local verification loop before opening a PR:

```bash
pnpm verify
```

That runs:

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`

## Live End-to-End Harness

`mews` also keeps a live GitHub-backed harness in-repo:

```bash
pnpm e2e:live
```

Before the first browser-backed run:

```bash
pnpm e2e:live:install-browser
```

The live harness requires a second GitHub actor so it can generate a real
mention notification. Set one of:

- `MEWS_E2E_SECONDARY_USER`
- `MEWS_E2E_SECONDARY_TOKEN`

By default the harness starts and stops the real background service with
`mews start` / `mews stop` and scopes the run to `bingran-you/mews`. If you
override `MEWS_E2E_REPO`, it still must be a single `owner/repo` value; CSV
scopes and wildcards are rejected on purpose.

Artifacts are written under `.artifacts/live-e2e/`.
