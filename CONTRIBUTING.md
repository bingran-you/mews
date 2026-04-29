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

Artifacts are written under `.artifacts/live-e2e/`.
