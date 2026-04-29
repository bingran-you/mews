#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const timestamp = Date.now();
const repo = process.env.MEWS_E2E_REPO ?? "bingran-you/mews";
const actorUser = process.env.MEWS_E2E_SECONDARY_USER;
const actorToken = process.env.MEWS_E2E_SECONDARY_TOKEN;
const basePort = Number(process.env.MEWS_E2E_HTTP_PORT ?? "8787");
const pollIntervalSecs = Number(process.env.MEWS_E2E_POLL_INTERVAL_SECS ?? "5");
const artifactsRoot = resolve(repoRoot, ".artifacts", "live-e2e", String(timestamp));

const realGh = execFileSync("sh", ["-lc", "command -v gh"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

let primaryUser = null;
let switchedAccount = false;

function log(traceFile, line) {
  process.stdout.write(`${line}\n`);
  writeFileSync(traceFile, `${line}\n`, { flag: "a" });
}

function fail(message) {
  throw new Error(message);
}

function execGh(args, options = {}) {
  return execFileSync("gh", args, {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
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

async function fetchJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed with ${response.status}`);
  }
  return response.json();
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

function buildAgentWrapper({
  agent,
  wrapperPath,
  logPath,
}) {
  const source =
    agent === "codex"
      ? `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const logPath = process.env.MEWS_E2E_AGENT_LOG;
const outIndex = args.indexOf("--output-last-message");
const outputPath = outIndex >= 0 ? args[outIndex + 1] : "";
const promptPath = args[args.length - 1] ?? "";
const promptText = promptPath ? readFileSync(promptPath, "utf8") : "";
appendFileSync(logPath, JSON.stringify({
  agent: "codex",
  argv: args,
  cwd: process.cwd(),
  outputPath,
  promptPath,
  promptText,
  env: {
    MEWS_TASK_DIR: process.env.MEWS_TASK_DIR,
    MEWS_SNAPSHOT_DIR: process.env.MEWS_SNAPSHOT_DIR,
    MEWS_BROKER_DIR: process.env.MEWS_BROKER_DIR,
  },
}) + "\\n");
if (outputPath) {
  writeFileSync(outputPath, "MEWS_RESULT: status=handled summary=codex wrapper handled probe");
}
process.stdout.write("codex wrapper complete\\n");
`
      : `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptText = args[args.length - 1] ?? "";
appendFileSync(process.env.MEWS_E2E_AGENT_LOG, JSON.stringify({
  agent: "claude",
  argv: args,
  cwd: process.cwd(),
  promptText,
  env: {
    MEWS_TASK_DIR: process.env.MEWS_TASK_DIR,
    MEWS_SNAPSHOT_DIR: process.env.MEWS_SNAPSHOT_DIR,
    MEWS_BROKER_DIR: process.env.MEWS_BROKER_DIR,
  },
}) + "\\n");
process.stdout.write("MEWS_RESULT: status=handled summary=claude wrapper handled probe\\n");
`;
  writeFileSync(wrapperPath, source);
  chmodSync(wrapperPath, 0o755);
}

function createWrapperBin({
  phaseDir,
  agent,
}) {
  const binDir = join(phaseDir, "bin");
  const agentLog = join(phaseDir, `${agent}-invocations.jsonl`);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh\nexec "${realGh}" "$@"\n`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  buildAgentWrapper({
    agent,
    wrapperPath: join(binDir, agent),
    logPath: agentLog,
  });
  return { binDir, agentLog };
}

function makePhaseRuntime(name, index) {
  const phaseDir = join(artifactsRoot, name);
  const stateDir = join(phaseDir, "state");
  const runnerHome = join(stateDir, "runner");
  mkdirSync(phaseDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    name,
    phaseDir,
    stateDir,
    runnerHome,
    port: basePort + index,
    dashboardScreenshot: join(phaseDir, "dashboard.png"),
    daemonLog: join(phaseDir, "daemon.log"),
    traceFile: join(phaseDir, "trace.log"),
    inboxFile: join(phaseDir, "inbox.json"),
    tasksFile: join(phaseDir, "tasks.json"),
    activityFile: join(phaseDir, "activity.json"),
  };
}

function startDaemon(phase, options = {}) {
  const args = [
    "dist/cli.mjs",
    "run",
    "--allow-repo",
    repo,
    "--http-port",
    String(phase.port),
    "--poll-interval-secs",
    String(pollIntervalSecs),
  ];
  if (options.dryRun) args.push("--dry-run");

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...options.extraEnv,
      MEWS_DIR: phase.stateDir,
      MEWS_HOME: phase.runnerHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => writeFileSync(phase.daemonLog, chunk, { flag: "a" }));
  child.stderr.on("data", (chunk) => writeFileSync(phase.daemonLog, chunk, { flag: "a" }));
  return child;
}

async function stopDaemon(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

async function closeProbeIssue(issueNumber) {
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
  } catch {
    // best effort
  }
}

async function verifyDashboard({
  phase,
  title,
  expectedStatus,
}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${phase.port}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("#rows tr", { hasText: title }).waitFor({
      timeout: 90_000,
    });
    const taskRow = page.locator("#task-rows tr", { hasText: title });
    await taskRow.waitFor({ timeout: 90_000 });
    await taskRow.locator(".badge", { hasText: expectedStatus }).first().waitFor({
      timeout: 90_000,
    });
    await page.screenshot({ path: phase.dashboardScreenshot, fullPage: true });
  } finally {
    await browser.close();
  }
}

function parseAgentLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runPhase({
  index,
  name,
  mode,
}) {
  const phase = makePhaseRuntime(name, index);
  const title = `[mews live e2e ${name} ${timestamp}]`;
  const mentionBody = `@${primaryUser} live mews ${name} probe from a secondary actor.`;
  const issueNumber = createProbeIssue(title);
  let daemon;
  let agentLogPath = null;

  log(phase.traceFile, `Artifacts: ${phase.phaseDir}`);
  log(phase.traceFile, `Created probe issue #${issueNumber}`);

  try {
    if (mode === "dry-run") {
      daemon = startDaemon(phase, { dryRun: true });
    } else {
      const wrapper = createWrapperBin({ phaseDir: phase.phaseDir, agent: mode });
      agentLogPath = wrapper.agentLog;
      daemon = startDaemon(phase, {
        extraEnv: {
          PATH: `${wrapper.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          MEWS_E2E_AGENT_LOG: agentLogPath,
        },
      });
    }

    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${phase.port}/healthz`);
          return response.ok;
        } catch {
          return false;
        }
      },
      { label: `${name}: daemon health check did not come up` },
    );

    postSecondaryMention(issueNumber, mentionBody);
    log(phase.traceFile, "Posted secondary mention comment");

    const inboxPayload = await waitFor(
      async () => {
        try {
          const payload = await fetchJson(phase.port, "/inbox");
          return payload.notifications?.some((entry) => entry.title === title)
            ? payload
            : null;
        } catch {
          return null;
        }
      },
      { label: `${name}: probe issue never appeared in /inbox` },
    );
    writeFileSync(phase.inboxFile, JSON.stringify(inboxPayload, null, 2));

    const expectedTaskStatus = mode === "dry-run" ? "simulated" : "handled";
    const tasksPayload = await waitFor(
      async () => {
        try {
          const payload = await fetchJson(phase.port, "/tasks");
          return payload.tasks?.some(
            (task) => task.title === title && task.status === expectedTaskStatus,
          )
            ? payload
            : null;
        } catch {
          return null;
        }
      },
      { label: `${name}: probe task never appeared in /tasks` },
    );
    writeFileSync(phase.tasksFile, JSON.stringify(tasksPayload, null, 2));
    const matchingTask = tasksPayload.tasks.find(
      (task) => task.title === title && task.status === expectedTaskStatus,
    );
    if (!matchingTask) {
      fail(`${name}: tasks payload did not include the probe task`);
    }

    const activityPayload = await fetchJson(phase.port, "/activity");
    writeFileSync(phase.activityFile, JSON.stringify(activityPayload, null, 2));

    if (mode !== "dry-run" && agentLogPath) {
      const invocations = parseAgentLog(agentLogPath);
      const matching = invocations.find((entry) => {
        const taskDir = String(entry?.env?.MEWS_TASK_DIR ?? "");
        const outputPath = String(entry?.outputPath ?? "");
        return taskDir.includes(matchingTask.task_id) || outputPath.includes(matchingTask.task_id);
      });
      if (!matching) {
        fail(`${name}: wrapper log never captured the probe prompt`);
      }
      if (mode === "codex") {
        const argv = matching.argv ?? [];
        if (
          argv[0] !== "exec" ||
          !argv.includes("--cd") ||
          !argv.includes("--dangerously-bypass-approvals-and-sandbox") ||
          !argv.includes("--output-last-message")
        ) {
          fail(`${name}: codex wrapper did not receive the expected argv`);
        }
      } else {
        const argv = matching.argv ?? [];
        if (
          argv[0] !== "-p" ||
          !argv.includes("--permission-mode") ||
          !argv.includes("bypassPermissions")
        ) {
          fail(`${name}: claude wrapper did not receive the expected argv`);
        }
        if (!matching.cwd || !String(matching.cwd).includes("/workspaces/")) {
          fail(`${name}: claude wrapper did not run in a workspace cwd`);
        }
      }
    }

    await verifyDashboard({
      phase,
      title,
      expectedStatus: expectedTaskStatus,
    });
    log(phase.traceFile, `Dashboard screenshot: ${phase.dashboardScreenshot}`);
    log(phase.traceFile, `${name} verification passed.`);
  } finally {
    await closeProbeIssue(issueNumber);
    await stopDaemon(daemon);
  }
}

async function main() {
  ensureSecondaryActor();
  detectPrimaryUser();
  mkdirSync(artifactsRoot, { recursive: true });
  if (!existsSync(join(repoRoot, "dist", "cli.mjs"))) {
    fail("dist/cli.mjs is missing. Run `pnpm build` first.");
  }

  log(join(artifactsRoot, "trace.log"), `Primary GitHub user: ${primaryUser}`);
  log(join(artifactsRoot, "trace.log"), `Artifacts root: ${artifactsRoot}`);

  await runPhase({ index: 0, name: "dry-run", mode: "dry-run" });
  await runPhase({ index: 1, name: "codex", mode: "codex" });
  await runPhase({ index: 2, name: "claude", mode: "claude" });

  log(join(artifactsRoot, "trace.log"), "Full live mews end-to-end verification passed.");
}

try {
  await main();
} catch (error) {
  const traceFile = join(artifactsRoot, "trace.log");
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  if (existsSync(dirname(traceFile))) {
    log(traceFile, `ERROR: ${message}`);
  } else {
    process.stdout.write(`ERROR: ${message}\n`);
  }
  process.exitCode = 1;
} finally {
  if (switchedAccount && primaryUser) {
    try {
      switchAccount(primaryUser);
    } catch {
      // best effort
    }
  }
}
