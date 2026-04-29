#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
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

function ensureSingleRepoScope(repoName) {
  if (
    repoName.includes(",") ||
    repoName.includes("*") ||
    !/^[^/\s]+\/[^/\s]+$/u.test(repoName)
  ) {
    fail(
      `MEWS_E2E_REPO must be a single owner/repo scope with no wildcards or CSV values; got ${repoName}`,
    );
  }
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

function runCli(args, options = {}) {
  return spawnSync(process.execPath, ["dist/cli.mjs", ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeCommandCapture(path, result) {
  writeFileSync(
    path,
    [
      `$ node dist/cli.mjs ${result.args.join(" ")}`,
      `status: ${result.status ?? "null"}`,
      "",
      "--- stdout ---",
      result.stdout ?? "",
      "",
      "--- stderr ---",
      result.stderr ?? "",
      "",
    ].join("\n"),
  );
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function parseOutputLine(text, prefix) {
  for (const line of text.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
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
const logPath = ${JSON.stringify(logPath)};
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
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
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
    profile: `live-e2e-${timestamp}-${name}`,
    port: basePort + index,
    dashboardScreenshot: join(phaseDir, "dashboard.png"),
    daemonLog: join(phaseDir, "daemon.log"),
    startOutputFile: join(phaseDir, "start.txt"),
    stopOutputFile: join(phaseDir, "stop.txt"),
    statusFile: join(phaseDir, "status.txt"),
    runtimeStatusFile: join(phaseDir, "runtime-status.env"),
    traceFile: join(phaseDir, "trace.log"),
    inboxFile: join(phaseDir, "inbox.json"),
    tasksFile: join(phaseDir, "tasks.json"),
    activityFile: join(phaseDir, "activity.json"),
  };
}

function startDaemon(phase, options = {}) {
  const env = {
    ...options.extraEnv,
    MEWS_DIR: phase.stateDir,
    MEWS_HOME: phase.runnerHome,
  };
  const args = [
    "start",
    "--allow-repo",
    repo,
    "--home",
    phase.runnerHome,
    "--profile",
    phase.profile,
    "--http-port",
    String(phase.port),
    "--poll-interval-secs",
    String(pollIntervalSecs),
  ];
  if (options.dryRun) args.push("--dry-run");

  const result = runCli(args, { env });
  result.args = args;
  writeCommandCapture(phase.startOutputFile, result);
  if (result.status !== 0) {
    fail(`${phase.name}: \`mews start\` failed\n${combinedOutput(result)}`);
  }

  const output = combinedOutput(result);
  const logPath = parseOutputLine(output, "log: ");
  if (!logPath) {
    fail(`${phase.name}: \`mews start\` did not print a daemon log path`);
  }

  log(phase.traceFile, `Started via mews start (profile=${phase.profile})`);
  return { env, logPath };
}

function captureDaemonLog(phase, runtime) {
  if (!runtime?.logPath || !existsSync(runtime.logPath)) return;
  writeFileSync(phase.daemonLog, readFileSync(runtime.logPath, "utf8"));
}

async function stopDaemon(phase, runtime, options = {}) {
  const result = runCli(
    ["stop", "--home", phase.runnerHome, "--profile", phase.profile],
    { env: runtime?.env ?? { MEWS_DIR: phase.stateDir, MEWS_HOME: phase.runnerHome } },
  );
  result.args = ["stop", "--home", phase.runnerHome, "--profile", phase.profile];
  writeCommandCapture(phase.stopOutputFile, result);
  captureDaemonLog(phase, runtime);

  if ((result.status ?? 1) !== 0 && !options.bestEffort) {
    fail(`${phase.name}: \`mews stop\` failed\n${combinedOutput(result)}`);
  }

  try {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${phase.port}/healthz`);
          return response.ok ? null : true;
        } catch {
          return true;
        }
      },
      {
        timeoutMs: 20_000,
        intervalMs: 1_000,
        label: `${phase.name}: daemon health check still up after stop`,
      },
    );
  } catch (error) {
    if (!options.bestEffort) throw error;
    log(
      phase.traceFile,
      `WARN: best-effort stop failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function assertOnlyRepo(entries, label) {
  const repos = Array.from(
    new Set(entries.map((entry) => String(entry?.repo ?? "")).filter(Boolean)),
  );
  if (repos.length === 0) {
    fail(`${label}: payload did not contain any repo values`);
  }
  if (repos.some((value) => value !== repo)) {
    fail(`${label}: expected only ${repo}, got ${repos.join(", ")}`);
  }
}

function computeStatusCounts(notifications) {
  const counts = { new: 0, human: 0, wip: 0, done: 0 };
  for (const notification of notifications) {
    const key = notification?.mews_status;
    if (Object.hasOwn(counts, key)) counts[key] += 1;
  }
  return counts;
}

async function waitForStatusSnapshot(phase, runtime) {
  const statusArgs = [
    "status",
    "--home",
    phase.runnerHome,
    "--profile",
    phase.profile,
    "--allow-repo",
    repo,
  ];

  const statusOutput = await waitFor(
    async () => {
      const result = runCli(statusArgs, { env: runtime.env });
      const text = combinedOutput(result);
      if ((result.status ?? 1) !== 0) return null;
      if (!text.includes(`allowed repos: ${repo}`)) return null;
      return text;
    },
    {
      label: `${phase.name}: mews status never reported the expected repo scope`,
    },
  );

  writeFileSync(phase.statusFile, statusOutput);

  const runtimeStatusPath = join(phase.runnerHome, "runtime", "status.env");
  if (!existsSync(runtimeStatusPath)) {
    fail(`${phase.name}: runtime/status.env was not written`);
  }
  const runtimeStatus = readFileSync(runtimeStatusPath, "utf8");
  writeFileSync(phase.runtimeStatusFile, runtimeStatus);
  if (!runtimeStatus.includes(`allowed_repos=${repo}`)) {
    fail(`${phase.name}: runtime/status.env did not record ${repo}`);
  }
}

async function verifyDashboard({
  phase,
  title,
}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${phase.port}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () => document.getElementById("sse-status")?.textContent === "live",
      undefined,
      { timeout: 90_000 },
    );
    await page.waitForFunction(
      () => document.getElementById("last-poll")?.textContent?.startsWith("last poll "),
      undefined,
      { timeout: 90_000 },
    );

    await waitFor(
      async () => {
        const liveInbox = await fetchJson(phase.port, "/inbox");
        const liveTasks = await fetchJson(phase.port, "/tasks");
        const matchingNotification = liveInbox.notifications?.find(
          (entry) => entry.title === title,
        );
        const matchingTask = liveTasks.tasks?.find(
          (entry) => entry.title === title,
        );
        if (!matchingNotification || !matchingTask) return null;

        const counts = computeStatusCounts(liveInbox.notifications ?? []);
        for (const key of ["new", "human", "wip", "done"]) {
          const text = await page.locator(`#counts .count-chip.${key} b`).textContent();
          if (text?.trim() !== String(counts[key])) return null;
        }

        const notificationRows = await page.locator("#rows tr").count();
        if (notificationRows !== liveInbox.notifications.length) return null;

        const taskRows = await page.locator("#task-rows tr").count();
        if (taskRows !== liveTasks.tasks.length) return null;

        const notificationRow = page.locator("#rows tr", {
          hasText: matchingNotification.title,
        }).first();
        if ((await notificationRow.count()) === 0) return null;

        const notificationBadge =
          (await notificationRow.locator(".badge").first().textContent())?.trim();
        if (notificationBadge !== matchingNotification.mews_status) return null;
        const notificationRepo =
          (await notificationRow.locator("td.repo").textContent())?.trim();
        if (notificationRepo !== repo) return null;
        const notificationHref = await notificationRow.locator("td a").getAttribute("href");
        if (notificationHref !== matchingNotification.html_url) return null;

        const taskRow = page.locator("#task-rows tr", {
          hasText: matchingTask.title,
        }).first();
        if ((await taskRow.count()) === 0) return null;

        const taskBadge = (await taskRow.locator(".badge").first().textContent())?.trim();
        if (taskBadge !== matchingTask.status) return null;
        const taskRepo = (await taskRow.locator("td.repo").textContent())?.trim();
        if (taskRepo !== repo) return null;
        const taskSummary = (await taskRow.locator("td").nth(4).textContent())?.trim() ?? "";
        if ((matchingTask.summary ?? "") && taskSummary !== matchingTask.summary) {
          return null;
        }

        return true;
      },
      {
        timeoutMs: 90_000,
        intervalMs: 1_000,
        label: `${phase.name}: dashboard never converged with the live inbox/tasks payload`,
      },
    );

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
  let runtime = null;
  let agentLogPath = null;
  let stopped = false;

  log(phase.traceFile, `Artifacts: ${phase.phaseDir}`);
  log(phase.traceFile, `Repo scope: ${repo}`);
  log(phase.traceFile, `Created probe issue #${issueNumber}`);

  try {
    if (mode === "dry-run") {
      runtime = startDaemon(phase, { dryRun: true });
    } else {
      const wrapper = createWrapperBin({ phaseDir: phase.phaseDir, agent: mode });
      agentLogPath = wrapper.agentLog;
      runtime = startDaemon(phase, {
        extraEnv: {
          PATH: `${wrapper.binDir}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
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

    await waitForStatusSnapshot(phase, runtime);

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
    assertOnlyRepo(inboxPayload.notifications ?? [], `${name}: /inbox`);
    const matchingNotification = inboxPayload.notifications.find(
      (entry) => entry.title === title,
    );
    if (!matchingNotification) {
      fail(`${name}: inbox payload did not include the probe issue`);
    }

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
    assertOnlyRepo(tasksPayload.tasks ?? [], `${name}: /tasks`);

    const activityPayload = await fetchJson(phase.port, "/activity");
    writeFileSync(phase.activityFile, JSON.stringify(activityPayload, null, 2));
    if (!Array.isArray(activityPayload) || activityPayload.length === 0) {
      fail(`${name}: /activity did not return any events`);
    }
    assertOnlyRepo(activityPayload, `${name}: /activity`);

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
    });
    log(phase.traceFile, `Dashboard screenshot: ${phase.dashboardScreenshot}`);

    await stopDaemon(phase, runtime);
    stopped = true;
    log(phase.traceFile, `${name} verification passed.`);
  } finally {
    await closeProbeIssue(issueNumber);
    if (!stopped) {
      await stopDaemon(phase, runtime, { bestEffort: true });
    }
  }
}

async function main() {
  ensureSecondaryActor();
  ensureSingleRepoScope(repo);
  detectPrimaryUser();
  mkdirSync(artifactsRoot, { recursive: true });
  if (!existsSync(join(repoRoot, "dist", "cli.mjs"))) {
    fail("dist/cli.mjs is missing. Run `pnpm build` first.");
  }

  log(join(artifactsRoot, "trace.log"), `Primary GitHub user: ${primaryUser}`);
  log(join(artifactsRoot, "trace.log"), `Repo scope: ${repo}`);
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
