# mews

Mews is a local daemon for GitHub notifications.

It runs on your machine, polls GitHub notifications for the repos you allow,
shows a live dashboard in the browser, and can dispatch work to Codex CLI or
Claude Code CLI.

Core responsibilities:

- ingest GitHub notifications across pull requests, comments, review requests, issues, and discussions
- maintain local state for inbox items and task execution
- dispatch local coding agents against actionable work
- expose the live state in a browser dashboard

Main commands:

- `mews install --allow-repo owner/repo`
- `mews start --allow-repo owner/repo`
- `mews status`
- `mews watch`
- `mews poll`

Runtime data lives under `~/.mews/`.
