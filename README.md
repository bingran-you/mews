# mews

Mews is a local daemon for GitHub notifications.

It runs on your machine, polls GitHub notifications for the repos you allow,
shows a live dashboard in the browser, and can dispatch work to Codex CLI or
Claude Code CLI.

This repository is being migrated out of the `breeze` implementation that used
to live inside `first-tree`. The goal of the migration is to end up with a
standalone, cleanly-structured open source project whose core concerns are:

- ingesting GitHub notifications
- classifying and tracking work
- dispatching local coding agents
- exposing daemon state in a browser dashboard

The current extraction keeps the tested daemon core and then incrementally
removes `first-tree`-specific coupling in follow-up changes.
