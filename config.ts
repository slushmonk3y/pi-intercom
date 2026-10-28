import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { hostname } from "os";
import { getIntercomDirPath } from "./broker/paths.ts";
import { defaultMachineName } from "./cross-machine-envelope.ts";

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const INTERCOM_SCOPE_ID_ENV = "PI_INTERCOM_SCOPE_ID";

export function getAskTimeoutMs(): number {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PI_INTERCOM_ASK_TIMEOUT_MS must be a positive integer number of milliseconds");
  }
  return value;
}

export function getIntercomScopeId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const scopeId = env[INTERCOM_SCOPE_ID_ENV]?.trim();
  return scopeId ? scopeId : undefined;
}

/** Sets this process's broker routing scope. Children launched afterwards inherit it. */
export function setIntercomScopeId(scopeId: string | undefined): void {
  if (scopeId) process.env[INTERCOM_SCOPE_ID_ENV] = scopeId;
  else delete process.env[INTERCOM_SCOPE_ID_ENV];
}

export type InboundTriggerPolicy = "always" | "replies" | "never";
export type BusyDeliveryPolicy = "steer" | "human-first";

export const INBOUND_TRIGGER_ENV = "PI_INTERCOM_INBOUND_TRIGGER";
export const BUSY_DELIVERY_ENV = "PI_INTERCOM_BUSY_DELIVERY";
const INBOUND_TRIGGER_POLICIES: readonly InboundTriggerPolicy[] = ["always", "replies", "never"];
const BUSY_DELIVERY_POLICIES: readonly BusyDeliveryPolicy[] = ["steer", "human-first"];

export function isInboundTriggerPolicy(value: unknown): value is InboundTriggerPolicy {
  return INBOUND_TRIGGER_POLICIES.includes(value as InboundTriggerPolicy);
}

export function isBusyDeliveryPolicy(value: unknown): value is BusyDeliveryPolicy {
  return BUSY_DELIVERY_POLICIES.includes(value as BusyDeliveryPolicy);
}

/** Layers that may set the delivery keys, lowest precedence first. */
export type DeliverySettingLayer = "global" | "project" | "env" | "session";
export type DeliverySettingSource = "default" | DeliverySettingLayer;
const DELIVERY_LAYER_ORDER: readonly DeliverySettingLayer[] = ["global", "project", "env", "session"];

/** Unvalidated delivery values from one layer; the resolver validates them. */
export interface DeliveryLayerInput {
  /** Named in warnings: a file path, "environment" or "session". */
  origin: string;
  values: { inboundTrigger?: unknown; busyDelivery?: unknown };
  /** Per-key names used in warnings; the JSON key is used when absent. */
  keyNames?: { inboundTrigger?: string; busyDelivery?: string };
  /** Set when the layer could not be read; fails closed for both keys. */
  error?: string;
}

export interface DeliverySettings {
  inboundTrigger: InboundTriggerPolicy;
  busyDelivery: BusyDeliveryPolicy;
  sources: { inboundTrigger: DeliverySettingSource; busyDelivery: DeliverySettingSource };
  warnings: string[];
}

/**
 * Applies the delivery layers over the defaults. An invalid inboundTrigger
 * fails closed to "never" at its layer; an invalid busyDelivery is ignored.
 * A higher valid layer still overrides either.
 */
export function resolveDeliverySettings(layers: Partial<Record<DeliverySettingLayer, DeliveryLayerInput>>): DeliverySettings {
  const settings: DeliverySettings = {
    inboundTrigger: defaults.inboundTrigger,
    busyDelivery: defaults.busyDelivery,
    sources: { inboundTrigger: "default", busyDelivery: "default" },
    warnings: [],
  };
  for (const name of DELIVERY_LAYER_ORDER) {
    const layer = layers[name];
    if (!layer) continue;
    if (layer.error !== undefined) {
      settings.inboundTrigger = "never";
      settings.sources.inboundTrigger = name;
      settings.warnings.push(`${layer.origin}: ${layer.error}; using inboundTrigger "never"`);
      continue;
    }
    const { inboundTrigger, busyDelivery } = layer.values;
    if (inboundTrigger !== undefined) {
      settings.sources.inboundTrigger = name;
      if (isInboundTriggerPolicy(inboundTrigger)) {
        settings.inboundTrigger = inboundTrigger;
      } else {
        settings.inboundTrigger = "never";
        const key = layer.keyNames?.inboundTrigger ?? `"inboundTrigger"`;
        settings.warnings.push(`${layer.origin}: ${key} must be "always", "replies", or "never"; using "never"`);
      }
    }
    if (busyDelivery !== undefined) {
      if (isBusyDeliveryPolicy(busyDelivery)) {
        settings.busyDelivery = busyDelivery;
        settings.sources.busyDelivery = name;
      } else {
        const key = layer.keyNames?.busyDelivery ?? `"busyDelivery"`;
        settings.warnings.push(`${layer.origin}: ${key} must be "steer" or "human-first"; ignoring it`);
      }
    }
  }
  return settings;
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".agents", "intercom.json");
}

/** Reads <cwd>/.agents/intercom.json, or returns undefined when the project has none. */
export function readProjectDeliveryLayer(cwd: string): DeliveryLayerInput | undefined {
  const origin = getProjectConfigPath(cwd);
  if (!existsSync(origin)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(origin, "utf-8"));
  } catch (error) {
    return { origin, values: {}, error: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { origin, values: {}, error: "must be a JSON object" };
  }
  const { inboundTrigger, busyDelivery } = parsed as Record<string, unknown>;
  return { origin, values: { inboundTrigger, busyDelivery } };
}

/** Reads the launch environment layer; blank variables count as unset. */
export function readEnvDeliveryLayer(env: NodeJS.ProcessEnv = process.env): DeliveryLayerInput | undefined {
  const inboundTrigger = env[INBOUND_TRIGGER_ENV]?.trim() || undefined;
  const busyDelivery = env[BUSY_DELIVERY_ENV]?.trim() || undefined;
  if (inboundTrigger === undefined && busyDelivery === undefined) return undefined;
  return {
    origin: "environment",
    values: { inboundTrigger, busyDelivery },
    keyNames: { inboundTrigger: INBOUND_TRIGGER_ENV, busyDelivery: BUSY_DELIVERY_ENV },
  };
}

export interface CrossMachineConfig {
  /** Name peers use for this host in their Herdr saved-machine lists. */
  machineName: string;
  /** Command invoked through SSH on remote machines. */
  remoteCommand: string;
}

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (e.g. "npx" or "bun") */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** The global layer's inboundTrigger and busyDelivery, validated by resolveDeliverySettings */
  delivery: DeliveryLayerInput;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;

  /** Optional stable intercom session ID for restart-stable addressing */
  stableId?: string;
  
  /** Enable/disable intercom (default: true) */
  enabled: boolean;
  
  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;

  /** Cross-machine discovery and SSH relay settings. */
  crossMachine: CrossMachineConfig;
}

export function getConfigPath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "config.json");
}

const defaults = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  inboundTrigger: "always" as InboundTriggerPolicy,
  busyDelivery: "steer" as BusyDeliveryPolicy,
  enabled: true,
  replyHint: true,
  crossMachine: {
    machineName: defaultMachineName(hostname()),
    remoteCommand: "pi-intercom",
  },
};

function defaultConfig(configPath: string): IntercomConfig {
  const { inboundTrigger: _inboundTrigger, busyDelivery: _busyDelivery, ...rest } = defaults;
  return { ...rest, crossMachine: { ...defaults.crossMachine }, delivery: { origin: configPath, values: {} } };
}

export function loadConfig(): IntercomConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return defaultConfig(configPath);
  }
  
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config = defaultConfig(configPath);

    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }

    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs: string[] = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }

    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }

    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }

    config.delivery.values = { inboundTrigger: parsedConfig.inboundTrigger, busyDelivery: parsedConfig.busyDelivery };

    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }

    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }

    if (Object.hasOwn(parsedConfig, "stableId")) {
      if (typeof parsedConfig.stableId !== "string") {
        throw new Error(`"stableId" must be a string`);
      }
      const stableId = parsedConfig.stableId.trim();
      if (!stableId) {
        throw new Error(`"stableId" must not be empty`);
      }
      config.stableId = stableId;
    }

    if (Object.hasOwn(parsedConfig, "crossMachine")) {
      const value = parsedConfig.crossMachine;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`"crossMachine" must be an object`);
      }
      const crossMachine = value as Record<string, unknown>;
      if (Object.hasOwn(crossMachine, "machineName")) {
        if (typeof crossMachine.machineName !== "string" || !crossMachine.machineName.trim()) {
          throw new Error(`"crossMachine.machineName" must be a non-empty string`);
        }
        config.crossMachine.machineName = crossMachine.machineName.trim();
      }
      if (Object.hasOwn(crossMachine, "remoteCommand")) {
        if (typeof crossMachine.remoteCommand !== "string" || !crossMachine.remoteCommand.trim()) {
          throw new Error(`"crossMachine.remoteCommand" must be a non-empty string`);
        }
        config.crossMachine.remoteCommand = crossMachine.remoteCommand.trim();
      }
    }

    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load intercom config at ${configPath}: ${message}`, { cause: error });
  }
}
