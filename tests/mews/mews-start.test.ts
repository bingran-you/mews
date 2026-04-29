import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runStart", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("refuses to start without an explicit repo scope", async () => {
    const { runStart } = await import(
      "../../src/mews/engine/commands/start.js"
    );

    const lines: string[] = [];
    const code = await runStart([], {
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing required --allow-repo");
  });

  it("passes MEWS_DIR/MEWS_HOME plus the cli entrypoint to launchd", async () => {
    const bootstrapLaunchdJob = vi.fn(() => ({
      label: "com.mews.runner.test.default",
      domain: "gui/1",
      plistPath: "/tmp/plist",
    }));

    vi.doMock("../../src/mews/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/mews/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/mews/engine/runtime/config.js", () => ({
      loadMewsDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/mews/engine/daemon/claim.js", () => ({
      findServiceLock: () => null,
      isLockStale: () => false,
    }));

    const { runStart } = await import(
      "../../src/mews/engine/commands/start.js"
    );

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: "/tmp/mews-home/runner",
      entrypoint: "/tmp/mews/dist/cli.mjs",
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(bootstrapLaunchdJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerHome: "/tmp/mews-home/runner",
        executable: process.execPath,
        arguments: [
          "/tmp/mews/dist/cli.mjs",
          "daemon",
          "--backend=ts",
          "--allow-repo",
          "owner/repo",
        ],
        env: {
          MEWS_DIR: "/tmp/mews-home",
          MEWS_HOME: "/tmp/mews-home/runner",
        },
      }),
    );
    expect(lines).toContain("mews-daemon started in background via launchd");
  });

  it("refuses to start and points to `mews stop` when a live daemon is detected (#293)", async () => {
    const bootstrapLaunchdJob = vi.fn();

    vi.doMock("../../src/mews/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/mews/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/mews/engine/runtime/config.js", () => ({
      loadMewsDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/mews/engine/daemon/claim.js", () => ({
      findServiceLock: () => ({
        pid: 97184,
        heartbeat_epoch: Math.floor(Date.now() / 1000),
        active_tasks: 0,
        note: "",
      }),
      isLockStale: () => false,
    }));

    const { runStart } = await import(
      "../../src/mews/engine/commands/start.js"
    );

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: "/tmp/mews-home/runner",
      entrypoint: "/tmp/mews/dist/cli.mjs",
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(bootstrapLaunchdJob).not.toHaveBeenCalled();
    const output = lines.join("\n");
    expect(output).toContain("daemon already running (pid 97184)");
    expect(output).toContain("mews stop");
  });

  it("includes --home/--profile in the stop hint when the caller set them (#301 review)", async () => {
    vi.doMock("../../src/mews/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob: vi.fn(),
    }));
    vi.doMock("../../src/mews/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/mews/engine/runtime/config.js", () => ({
      loadMewsDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/mews/engine/daemon/claim.js", () => ({
      findServiceLock: () => ({
        pid: 4242,
        heartbeat_epoch: Math.floor(Date.now() / 1000),
        active_tasks: 0,
        note: "",
      }),
      isLockStale: () => false,
    }));

    const { runStart } = await import(
      "../../src/mews/engine/commands/start.js"
    );

    const lines: string[] = [];
    const code = await runStart(
      [
        "--allow-repo",
        "owner/repo",
        "--home",
        "/custom/home",
        "--profile",
        "work",
      ],
      { write: (line) => lines.push(line) },
    );

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain(
      "mews stop --home /custom/home --profile work",
    );
  });
});
