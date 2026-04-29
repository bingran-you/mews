#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const timestamp = Date.now();
const repo = process.env.MEWS_E2E_REPO ?? "bingran-you/mews";
const actorUser = process.env.MEWS_E2E_SECONDARY_USER;
const actorToken = process.env.MEWS_E2E_SECONDARY_TOKEN;
const port = Number(process.env.MEWS_E2E_HTTP_PORT ?? "8787");
const pollIntervalSecs = Number(process.env.MEWS_E2E_POLL_INTERVAL_SECS ?? "5");
const artifactsRoot = resolve(
  repoRoot,
  ".artifacts",
  "live-e2e",
  String(timestamp),
);
const stateRoot = join(artifactsRoot, "state");
const runnerHome = join(stateRoot, "runner");
const dashboardScreenshot = join(artifactsRoot, "dashboard.png");
const daemonLog = join(artifactsRoot, "daemon.log");
const traceFile = join(artifactsRoot, "trace.log");

mkdirSync(artifactsRoot, { recursive: true });
mkdirSync(stateRoot, { recursive: true });

let issueNumber = null;
let daemon = null;
let primaryUser = null;
let switchedAccount = false;

function log(line) {
  process.stdout.write(`${line}\n`);
  writeFileSync(traceFile, `${line}\n`, { flag: "a" });
}

function fail(message) {
  throw new Error(message);
}

function execGh(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  return execFileSync("gh", args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(options.label ?? "Timed out");
}

async function fetchJson(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed with ${response.status}`);
  }
  return response.json();
}

function appendDaemonLog(chunk) {
  writeFileSync(daemonLog, chunk, { flag: "a" });
}

function ensureSecondaryActor() {
  if (!actorToken && !actorUser) {
    fail(
      "Set MEWS_E2E_SECONDARY_USER or MEWS_E2E_SECONDARY_TOKEN so a second actor can generate a real mention notification.",
    );
  }
}

function detectPrimaryUser() {
  primaryUser = execGh(["api", "/user", "-q", ".login"]);
  return primaryUser;
}

function switchAccount(user) {
  execGh(["auth", "switch", "--hostname", "github.com", "--user", user]);
}

function createProbeIssue(title) {
  const body = [
    "Temporary issue created by the live mews end-to-end harness.",
    "",
    "The harness will close it automatically after verification.",
  ].join("\n");
  const created = JSON.parse(
    execGh([
      "api",
      `/repos/${repo}/issues`,
      "-f",
      `title=${title}`,
      "-f",
      `body=${body}`,
      "-F",
      `assignees[]=${primaryUser}`,
    ]),
  );
  return created.number;
}

function postSecondaryMention(issue, mentionBody) {
  if (actorToken) {
    execGh(
      ["issue", "comment", String(issue), "--repo", repo, "--body", mentionBody],
      { env: { GH_TOKEN: actorToken } },
    );
    return;
  }

  switchAccount(actorUser);
  switchedAccount = true;
  try {
    execGh([
      "issue",
      "comment",
      String(issue),
      "--repo",
      repo,
      "--body",
      mentionBody,
    ]);
  } finally {
    switchAccount(primaryUser);
    switchedAccount = false;
  }
}

function startDaemon() {
  const child = spawn(
    process.execPath,
    [
      "dist/cli.mjs",
      "run",
      "--allow-repo",
      repo,
      "--http-port",
      String(port),
      "--poll-interval-secs",
      String(pollIntervalSecs),
      "--dry-run",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MEWS_DIR: stateRoot,
        MEWS_HOME: runnerHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => appendDaemonLog(chunk));
  child.stderr.on("data", (chunk) => appendDaemonLog(chunk));
  daemon = child;
  return child;
}

async function stopDaemon() {
  if (!daemon) return;
  if (daemon.exitCode !== null) return;
  daemon.kill("SIGTERM");
  await new Promise((resolvePromise) => daemon.once("exit", resolvePromise));
}

async function closeProbeIssue() {
  if (issueNumber === null) return;
  try {
    execGh([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--comment",
      "Closing temporary mews live e2e probe.",
    ]);
  } catch (error) {
    log(`WARN: failed to close probe issue #${issueNumber}: ${String(error)}`);
  }
}

async function verifyDashboard(title) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    fail(
      `Could not launch Chromium. Run \`pnpm e2e:live:install-browser\` first. ${String(error)}`,
    );
  }

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("#rows tr", { hasText: title }).waitFor({
      timeout: 90_000,
    });
    const taskRow = page.locator("#task-rows tr", { hasText: title });
    await taskRow.waitFor({
      timeout: 90_000,
    });
    await taskRow.getByText("simulated").waitFor({ timeout: 90_000 });
    await page.screenshot({ path: dashboardScreenshot, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  ensureSecondaryActor();
  detectPrimaryUser();
  log(`Primary GitHub user: ${primaryUser}`);
  log(`Artifacts: ${artifactsRoot}`);

  if (!existsSync(join(repoRoot, "dist", "cli.mjs"))) {
    fail("dist/cli.mjs is missing. Run `pnpm build` first.");
  }

  const title = `[mews live e2e ${timestamp}]`;
  const mentionBody = `@${primaryUser} live mews end-to-end probe from a secondary actor.`;

  startDaemon();
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { label: "Daemon health check did not come up" },
  );

  issueNumber = createProbeIssue(title);
  log(`Created probe issue #${issueNumber}`);
  postSecondaryMention(issueNumber, mentionBody);
  log("Posted secondary mention comment");

  const inboxPayload = await waitFor(
    async () => {
      try {
        const payload = await fetchJson("/inbox");
        return payload.notifications?.some((entry) => entry.title === title)
          ? payload
          : null;
      } catch {
        return null;
      }
    },
    { label: "Probe issue never appeared in /inbox" },
  );
  writeFileSync(
    join(artifactsRoot, "inbox.json"),
    JSON.stringify(inboxPayload, null, 2),
  );

  const tasksPayload = await waitFor(
    async () => {
      try {
        const payload = await fetchJson("/tasks");
        return payload.tasks?.some((task) => task.title === title)
          ? payload
          : null;
      } catch {
        return null;
      }
    },
    { label: "Probe task never appeared in /tasks" },
  );
  writeFileSync(
    join(artifactsRoot, "tasks.json"),
    JSON.stringify(tasksPayload, null, 2),
  );

  const activityPayload = await fetchJson("/activity");
  writeFileSync(
    join(artifactsRoot, "activity.json"),
    JSON.stringify(activityPayload, null, 2),
  );

  await verifyDashboard(title);

  log(`Dashboard screenshot: ${dashboardScreenshot}`);
  log("Live mews end-to-end verification passed.");
}

try {
  await main();
} catch (error) {
  log(`ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (switchedAccount && primaryUser) {
    try {
      switchAccount(primaryUser);
    } catch {
      // best effort
    }
  }
  await closeProbeIssue();
  await stopDaemon();
}
