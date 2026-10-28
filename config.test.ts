import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigPath,
  getProjectConfigPath,
  loadConfig,
  readEnvDeliveryLayer,
  readProjectDeliveryLayer,
  resolveDeliverySettings,
} from "./config.ts";

async function withAgentDir<T>(agentDir: string, fn: () => T | Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("getConfigPath uses the centralized intercom runtime directory", () => {
  assert.equal(getConfigPath("/tmp/pi-agent/intercom"), join("/tmp/pi-agent", "intercom", "config.json"));
});

test("loadConfig reads config below PI_CODING_AGENT_DIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));

  try {
    const intercomDir = join(root, "intercom");
    mkdirSync(intercomDir, { recursive: true });
    writeFileSync(join(intercomDir, "config.json"), JSON.stringify({ status: "platform-test" }));

    await withAgentDir(root, () => {
      assert.equal(loadConfig().status, "platform-test");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults inboundTrigger to current auto-trigger behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      const settings = resolveDeliverySettings({ global: loadConfig().delivery });
      assert.equal(settings.inboundTrigger, "always");
      assert.equal(settings.busyDelivery, "steer");
      assert.deepEqual(settings.sources, { inboundTrigger: "default", busyDelivery: "default" });
      assert.deepEqual(settings.warnings, []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults cross-machine routing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      const config = loadConfig().crossMachine;
      assert.equal(config.remoteCommand, "pi-intercom");
      assert.equal(config.machineName.length > 0, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts cross-machine overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine: {
      machineName: "laptop",
      remoteCommand: "/opt/tools/pi-intercom",
    } }));
    await withAgentDir(root, () => {
      assert.deepEqual(loadConfig().crossMachine, {
        machineName: "laptop",
        remoteCommand: "/opt/tools/pi-intercom",
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts inboundTrigger replies policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "replies", busyDelivery: "human-first" }));
    await withAgentDir(root, () => {
      const settings = resolveDeliverySettings({ global: loadConfig().delivery });
      assert.equal(settings.inboundTrigger, "replies");
      assert.equal(settings.busyDelivery, "human-first");
      assert.deepEqual(settings.sources, { inboundTrigger: "global", busyDelivery: "global" });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig ignores obsolete toolVisibility values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ toolVisibility: "lazy", replyHint: false }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().replyHint, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts a restart-stable intercom id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ stableId: " pinned-worker " }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().stableId, "pinned-worker");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid global inboundTrigger fails closed to never with a warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "prompt" }));

    await withAgentDir(root, () => {
      const settings = resolveDeliverySettings({ global: loadConfig().delivery });
      assert.equal(settings.inboundTrigger, "never");
      assert.equal(settings.sources.inboundTrigger, "global");
      assert.deepEqual(settings.warnings, [
        `${join(root, "intercom", "config.json")}: "inboundTrigger" must be "always", "replies", or "never"; using "never"`,
      ]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty cross-machine strings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine: { remoteCommand: "  " } }));
    await withAgentDir(root, () => {
      assert.throws(() => loadConfig(), /"crossMachine.remoteCommand" must be a non-empty string/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid global busyDelivery is ignored with a warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ busyDelivery: "prompt" }));
    await withAgentDir(root, () => {
      const settings = resolveDeliverySettings({ global: loadConfig().delivery });
      assert.equal(settings.busyDelivery, "steer");
      assert.equal(settings.sources.busyDelivery, "default");
      assert.deepEqual(settings.warnings, [
        `${join(root, "intercom", "config.json")}: "busyDelivery" must be "steer" or "human-first"; ignoring it`,
      ]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig still throws for invalid values in other keys and unparsable files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    await withAgentDir(root, () => {
      writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ confirmSend: "yes" }));
      assert.throws(() => loadConfig(), /Failed to load intercom config.*"confirmSend" must be a boolean/);
      writeFileSync(join(root, "intercom", "config.json"), "{ not json");
      assert.throws(() => loadConfig(), /Failed to load intercom config/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function withProjectFile<T>(contents: string | undefined, fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "pi-intercom-project-"));
  try {
    if (contents !== undefined) {
      mkdirSync(join(cwd, ".agents"), { recursive: true });
      writeFileSync(join(cwd, ".agents", "intercom.json"), contents);
    }
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("getProjectConfigPath names .agents/intercom.json in the project folder", () => {
  assert.equal(getProjectConfigPath("/work/repo"), join("/work/repo", ".agents", "intercom.json"));
});

test("readProjectDeliveryLayer returns undefined when the project has no file", () => {
  withProjectFile(undefined, (cwd) => {
    assert.equal(readProjectDeliveryLayer(cwd), undefined);
  });
});

test("project, environment and session layers apply in precedence order", () => {
  withProjectFile(JSON.stringify({ inboundTrigger: "replies", busyDelivery: "human-first" }), (cwd) => {
    const global = { origin: "config.json", values: { inboundTrigger: "never", busyDelivery: "steer" } };
    const project = readProjectDeliveryLayer(cwd);

    const projectWins = resolveDeliverySettings({ global, project });
    assert.equal(projectWins.inboundTrigger, "replies");
    assert.equal(projectWins.busyDelivery, "human-first");
    assert.deepEqual(projectWins.sources, { inboundTrigger: "project", busyDelivery: "project" });

    const env = readEnvDeliveryLayer({ PI_INTERCOM_INBOUND_TRIGGER: "always" });
    const envWins = resolveDeliverySettings({ global, project, env });
    assert.equal(envWins.inboundTrigger, "always");
    assert.deepEqual(envWins.sources, { inboundTrigger: "env", busyDelivery: "project" });

    const session = { origin: "session", values: { inboundTrigger: "never", busyDelivery: "steer" } };
    const sessionWins = resolveDeliverySettings({ global, project, env, session });
    assert.equal(sessionWins.inboundTrigger, "never");
    assert.equal(sessionWins.busyDelivery, "steer");
    assert.deepEqual(sessionWins.sources, { inboundTrigger: "session", busyDelivery: "session" });

    // reset drops the session layer, so the environment value stands again.
    assert.deepEqual(resolveDeliverySettings({ global, project, env }).sources, envWins.sources);
    assert.deepEqual(sessionWins.warnings, []);
  });
});

test("readEnvDeliveryLayer treats unset and blank variables as absent", () => {
  assert.equal(readEnvDeliveryLayer({}), undefined);
  assert.equal(readEnvDeliveryLayer({ PI_INTERCOM_INBOUND_TRIGGER: "  ", PI_INTERCOM_BUSY_DELIVERY: "" }), undefined);
  const layer = readEnvDeliveryLayer({ PI_INTERCOM_BUSY_DELIVERY: " human-first " });
  assert.equal(resolveDeliverySettings({ env: layer }).busyDelivery, "human-first");
});

test("invalid environment values name the variable and fail closed", () => {
  const env = readEnvDeliveryLayer({ PI_INTERCOM_INBOUND_TRIGGER: "sometimes", PI_INTERCOM_BUSY_DELIVERY: "steeer" });
  const settings = resolveDeliverySettings({
    global: { origin: "config.json", values: { inboundTrigger: "always", busyDelivery: "human-first" } },
    env,
  });
  assert.equal(settings.inboundTrigger, "never");
  assert.equal(settings.sources.inboundTrigger, "env");
  assert.equal(settings.busyDelivery, "human-first");
  assert.equal(settings.sources.busyDelivery, "global");
  assert.deepEqual(settings.warnings, [
    `environment: PI_INTERCOM_INBOUND_TRIGGER must be "always", "replies", or "never"; using "never"`,
    `environment: PI_INTERCOM_BUSY_DELIVERY must be "steer" or "human-first"; ignoring it`,
  ]);
});

test("an invalid project value fails closed and a higher layer can still override it", () => {
  withProjectFile(JSON.stringify({ inboundTrigger: 3 }), (cwd) => {
    const project = readProjectDeliveryLayer(cwd);
    const settings = resolveDeliverySettings({ project });
    assert.equal(settings.inboundTrigger, "never");
    assert.equal(settings.sources.inboundTrigger, "project");
    assert.deepEqual(settings.warnings, [
      `${getProjectConfigPath(cwd)}: "inboundTrigger" must be "always", "replies", or "never"; using "never"`,
    ]);

    const overridden = resolveDeliverySettings({ project, session: { origin: "session", values: { inboundTrigger: "always" } } });
    assert.equal(overridden.inboundTrigger, "always");
    assert.equal(overridden.sources.inboundTrigger, "session");
  });
});

test("an unparsable or non-object project file is reported once and fails closed for both keys", () => {
  for (const contents of ["{ nope", "[]", "\"replies\""]) {
    withProjectFile(contents, (cwd) => {
      const settings = resolveDeliverySettings({
        global: { origin: "config.json", values: { inboundTrigger: "always", busyDelivery: "human-first" } },
        project: readProjectDeliveryLayer(cwd),
      });
      assert.equal(settings.inboundTrigger, "never");
      assert.equal(settings.sources.inboundTrigger, "project");
      assert.equal(settings.busyDelivery, "human-first");
      assert.equal(settings.sources.busyDelivery, "global");
      assert.equal(settings.warnings.length, 1);
      assert.match(settings.warnings[0]!, /intercom\.json: .*; using inboundTrigger "never"$/);
    });
  }
});

test("project files read only the two delivery keys", () => {
  withProjectFile(JSON.stringify({ busyDelivery: "human-first", confirmSend: true }), (cwd) => {
    const settings = resolveDeliverySettings({ project: readProjectDeliveryLayer(cwd) });
    assert.equal(settings.busyDelivery, "human-first");
    assert.equal(settings.inboundTrigger, "always");
    assert.deepEqual(settings.warnings, []);
  });
});
