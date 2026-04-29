/**
 * `mews install` — first-run setup for the mews daemon.
 *
 * Creates `~/.mews/config.yaml` with defaults (if absent) and hands
 * off daemon startup to `mews start`.
 *
 * The standalone `mews` package does not install any editor/agent
 * skills automatically. It only prepares the local daemon runtime.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseAllowRepoArg,
  requireExplicitRepoFilter,
  REQUIRED_ALLOW_REPO_USAGE,
} from "../runtime/allow-repo.js";

const DEFAULT_CONFIG = `# mews configuration
poll_interval_sec: 60
task_timeout_sec: 1800
log_level: info
http_port: 7878
host: github.com
`;

export interface InstallDeps {
  mewsDir?: string;
  write?: (text: string) => void;
  spawn?: typeof spawnSync;
  checkCommand?: (cmd: string) => boolean;
  checkGhAuth?: () => boolean;
  startCommand?: {
    cmd: string;
    args: string[];
  };
}

export function resolveSelfStartCommand(
  entrypoint: string | undefined = process.argv[1],
): { cmd: string; args: string[] } {
  if (entrypoint && entrypoint.length > 0) {
    return {
      cmd: process.execPath,
      args: [entrypoint, "start"],
    };
  }
  return { cmd: "mews", args: ["start"] };
}

function defaultCheckCommand(cmd: string): boolean {
  const result = spawnSync("command", ["-v", cmd], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function defaultCheckGhAuth(): boolean {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return result.status === 0;
}

export function runInstall(
  args: readonly string[],
  deps: InstallDeps = {},
): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    (deps.write ?? console.log)(`usage: mews install

  Bootstraps the local mews daemon:

    1. Checks for gh and gh auth status
    2. Creates \`~/.mews/config.yaml\` with defaults (if absent)
    3. Starts the daemon via \`mews start\`

  Required:
    ${REQUIRED_ALLOW_REPO_USAGE}   Explicit repo scope for the daemon startup

  Environment:
    MEWS_DIR            Override \`~/.mews\` (store root)
`);
    return 0;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  const checkCommand = deps.checkCommand ?? defaultCheckCommand;
  const checkGhAuth = deps.checkGhAuth ?? defaultCheckGhAuth;
  const spawn = deps.spawn ?? spawnSync;
  const mewsDir =
    deps.mewsDir ?? process.env.MEWS_DIR ?? join(homedir(), ".mews");
  const startCommand = deps.startCommand ?? resolveSelfStartCommand();
  try {
    requireExplicitRepoFilter(parseAllowRepoArg(args));
  } catch (err) {
    write(
      `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  write("=== mews setup ===");
  write("");
  write("Checking prerequisites...");

  if (!checkCommand("gh")) {
    write("ERROR: gh CLI is not installed. Install it: https://cli.github.com/");
    return 1;
  }
  if (!checkGhAuth()) {
    write("ERROR: gh is not authenticated. Run `gh auth login` first.");
    return 1;
  }
  write("  gh CLI: OK");
  write("  gh auth: OK");
  write("");

  write(`Setting up ${mewsDir}...`);
  mkdirSync(mewsDir, { recursive: true });
  const configPath = join(mewsDir, "config.yaml");
  if (existsSync(configPath)) {
    write(`  Config already exists at ${configPath}`);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG);
    write(`  Created default config at ${configPath}`);
  }
  write("");

  write("Starting the mews daemon...");
  const result = spawn(startCommand.cmd, [...startCommand.args, ...args], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    write("  Daemon started");
  } else {
    write(
      "  WARN: daemon start failed; rerun `mews start --allow-repo owner/repo` manually",
    );
  }
  write("");

  write("=== mews setup complete ===");
  write("");
  write("  Dashboard:  http://127.0.0.1:7878");
  write("  Status:     mews status");
  write("  Stop:       mews stop");
  write("  Inspect:    mews doctor");

  return 0;
}
