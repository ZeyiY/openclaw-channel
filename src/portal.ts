/**
 * Portal Bridge — WebSocket client that connects to agent-portal cloud service.
 *
 * Establishes a persistent WS connection to agent-portal using botId as the unique identifier.
 * Handles requests from portal to manage local openclaw agents, files, and models.
 * Lifecycle is tied to the OpenIM account: starts/stops alongside the account.
 */

import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import type {
  OpenIMAccountConfig,
  PortalBridgeState,
  PortalRequest,
  PortalResponse,
  ModelEntry,
  AgentSummary,
  AgentFileEntry,
} from "./types";

const bridges = new Map<string, PortalBridgeState>();

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 30000;

/** Well-known workspace files that agents use */
const AGENT_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md",
  "memory.md",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function portalLog(api: any, level: "info" | "warn" | "error" | "debug", msg: string): void {
  api.logger?.[level]?.(`[portal] ${msg}`);
}

function getConfig(api: any): any {
  return api.config ?? (globalThis as any).__openimGatewayConfig ?? {};
}

function normalizeAgentId(value: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "main";
  return trimmed.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64) || "main";
}

function resolveDefaultAgentId(cfg: any): string {
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  if (agents.length === 0) return "main";
  const defaults = agents.filter((a: any) => a?.default);
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || "main");
}

/** Expand leading ~ to $HOME, then resolve to absolute path. */
function resolveUserPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (p.startsWith("~/") || p === "~") {
    return resolve(home, p.slice(2));
  }
  return resolve(p);
}

function resolveAgentWorkspaceDir(cfg: any, agentId: string): string {
  const id = normalizeAgentId(agentId);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const entry = agents.find((a: any) => a?.id && normalizeAgentId(a.id) === id);

  if (entry?.workspace?.trim()) return resolveUserPath(entry.workspace.trim());

  const fallback = cfg.agents?.defaults?.workspace?.trim();
  const defaultId = resolveDefaultAgentId(cfg);
  const home = process.env.HOME ?? process.cwd();

  if (id === defaultId) {
    if (fallback) return resolveUserPath(fallback);
    return resolve(home, ".openclaw", "workspace");
  }

  if (fallback) return join(resolveUserPath(fallback), id);
  return resolve(home, ".openclaw", `workspace-${id}`);
}

function isPathSafe(workspaceRoot: string, targetPath: string): boolean {
  const resolved = resolve(workspaceRoot, targetPath);
  return resolved.startsWith(workspaceRoot + "/") || resolved === workspaceRoot;
}

async function statFileSafely(filePath: string): Promise<{ size: number; updatedAtMs: number } | null> {
  try {
    const s = await stat(filePath);
    return { size: s.size, updatedAtMs: Math.floor(s.mtimeMs) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

/**
 * models.list — return the model catalog from config.
 *
 * Config structure: models.providers.{providerName}.models[]
 * Marks the active model for the given agent. If the agent has no model
 * configured, the first model in the list is marked active.
 */
function handleModelsList(api: any, params: Record<string, unknown>): { models: ModelEntry[] } {
  const cfg = getConfig(api);
  const models: ModelEntry[] = [];

  const providers = cfg.models?.providers;
  if (providers && typeof providers === "object") {
    for (const [providerName, provider] of Object.entries(providers) as [string, any][]) {
      const providerModels = provider?.models;
      if (!Array.isArray(providerModels)) continue;
      for (const m of providerModels) {
        if (!m || typeof m !== "object") continue;
        const id = String(m.id ?? "").trim();
        if (!id) continue;
        models.push({
          id: `${providerName}/${id}`,
          name: String(m.name ?? id),
          provider: providerName,
          ...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
          ...(m.reasoning !== undefined ? { reasoning: Boolean(m.reasoning) } : {}),
        });
      }
    }
  }

  // Resolve active model for the requested agent
  const rawAgentId = String(params.agentId ?? "").trim();
  let activeModelId: string | undefined;

  if (rawAgentId) {
    const agentId = normalizeAgentId(rawAgentId);
    const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    const entry = agents.find((a: any) => a?.id && normalizeAgentId(a.id) === agentId);
    if (entry?.model) {
      // model can be a string like "deepminer/claude-sonnet-4-6" or an object { primary: "..." }
      activeModelId = typeof entry.model === "string"
        ? entry.model.trim()
        : String(entry.model.primary ?? "").trim();
    }
  }

  // Fallback: if no agent model configured, first model is active
  if (!activeModelId && models.length > 0) {
    activeModelId = models[0].id;
  }

  if (activeModelId) {
    for (const m of models) {
      m.active = m.id === activeModelId;
    }
  }

  return { models };
}

/**
 * agents.list — return all configured agents.
 */
function handleAgentsList(api: any): { defaultId: string; agents: AgentSummary[] } {
  const cfg = getConfig(api);
  const defaultId = resolveDefaultAgentId(cfg);
  const agents: AgentSummary[] = [];
  const seen = new Set<string>();

  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const entry of entries) {
    if (!entry?.id) continue;
    const id = normalizeAgentId(entry.id);
    if (seen.has(id)) continue;
    seen.add(id);

    const identity = entry.identity
      ? {
          ...(entry.identity.name ? { name: entry.identity.name } : {}),
          ...(entry.identity.theme ? { theme: entry.identity.theme } : {}),
          ...(entry.identity.emoji ? { emoji: entry.identity.emoji } : {}),
          ...(entry.identity.avatar ? { avatar: entry.identity.avatar } : {}),
        }
      : undefined;

    const model = entry.model
      ? typeof entry.model === "string"
        ? { primary: entry.model }
        : {
            ...(entry.model.primary ? { primary: entry.model.primary } : {}),
            ...(Array.isArray(entry.model.fallbacks) ? { fallbacks: entry.model.fallbacks } : {}),
          }
      : undefined;

    agents.push({
      id,
      ...(entry.name ? { name: entry.name } : {}),
      ...(identity && Object.keys(identity).length > 0 ? { identity } : {}),
      workspace: resolveAgentWorkspaceDir(cfg, id),
      ...(model ? { model } : {}),
    });
  }

  // Ensure default agent is present
  if (!seen.has(defaultId)) {
    agents.unshift({
      id: defaultId,
      workspace: resolveAgentWorkspaceDir(cfg, defaultId),
    });
  }

  return { defaultId, agents };
}

/**
 * agents.files.list — list workspace files for an agent, including file content.
 */
async function handleAgentsFilesList(
  api: any,
  params: Record<string, unknown>,
): Promise<{ agentId: string; workspace: string; files: AgentFileEntry[] }> {
  const rawAgentId = String(params.agentId ?? "").trim();
  if (!rawAgentId) throw { code: 400, message: "agentId is required" };

  const cfg = getConfig(api);
  const agentId = normalizeAgentId(rawAgentId);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const files: AgentFileEntry[] = [];

  for (const name of AGENT_FILE_NAMES) {
    const filePath = join(workspaceDir, name);
    const meta = await statFileSafely(filePath);

    if (meta) {
      let content: string | undefined;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        // skip unreadable files
      }
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
        content,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  portalLog(api, "info", `agents.files.list: agentId=${agentId} workspace=${workspaceDir} found=${files.filter(f => !f.missing).length}`);
  return { agentId, workspace: workspaceDir, files };
}

/**
 * agents.files.get — get a single workspace file's content.
 */
async function handleAgentsFilesGet(
  api: any,
  params: Record<string, unknown>,
): Promise<{ agentId: string; workspace: string; file: AgentFileEntry }> {
  const rawAgentId = String(params.agentId ?? "").trim();
  const name = String(params.name ?? "").trim();

  if (!rawAgentId) throw { code: 400, message: "agentId is required" };
  if (!name) throw { code: 400, message: "name is required" };

  const cfg = getConfig(api);
  const agentId = normalizeAgentId(rawAgentId);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const filePath = join(workspaceDir, name);

  portalLog(api, "info", `agents.files.get: agentId=${agentId} name=${name} workspace=${workspaceDir} filePath=${filePath}`);

  if (!isPathSafe(workspaceDir, name)) {
    throw { code: 403, message: "path traversal not allowed" };
  }

  const meta = await statFileSafely(filePath);
  if (!meta) {
    portalLog(api, "warn", `agents.files.get: file not found at ${filePath}`);
    return {
      agentId,
      workspace: workspaceDir,
      file: { name, path: filePath, missing: true },
    };
  }

  let content: string | undefined;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    // unreadable
  }

  return {
    agentId,
    workspace: workspaceDir,
    file: {
      name,
      path: filePath,
      missing: false,
      size: meta.size,
      updatedAtMs: meta.updatedAtMs,
      content,
    },
  };
}

/**
 * agents.files.set — write a file into an agent's workspace.
 */
async function handleAgentsFilesSet(
  api: any,
  params: Record<string, unknown>,
): Promise<{ ok: true; agentId: string; workspace: string; file: AgentFileEntry }> {
  const rawAgentId = String(params.agentId ?? "").trim();
  const name = String(params.name ?? "").trim();
  const content = String(params.content ?? "");

  if (!rawAgentId) throw { code: 400, message: "agentId is required" };
  if (!name) throw { code: 400, message: "name is required" };

  const cfg = getConfig(api);
  const agentId = normalizeAgentId(rawAgentId);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  if (!isPathSafe(workspaceDir, name)) {
    throw { code: 403, message: "path traversal not allowed" };
  }

  const filePath = resolve(workspaceDir, name);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");

  const meta = await statFileSafely(filePath);
  portalLog(api, "info", `agents.files.set: agentId=${agentId} file=${name} size=${content.length}`);

  return {
    ok: true,
    agentId,
    workspace: workspaceDir,
    file: {
      name,
      path: filePath,
      missing: false,
      size: meta?.size,
      updatedAtMs: meta?.updatedAtMs,
      content,
    },
  };
}

/**
 * agents.create — create a new agent with workspace and identity file.
 */
async function handleAgentsCreate(
  api: any,
  params: Record<string, unknown>,
): Promise<{ ok: true; agentId: string; name: string; workspace: string }> {
  const rawName = String(params.name ?? "").trim();
  const rawWorkspace = String(params.workspace ?? "").trim();

  if (!rawName) throw { code: 400, message: "name is required" };
  if (!rawWorkspace) throw { code: 400, message: "workspace is required" };

  const agentId = normalizeAgentId(rawName);
  if (agentId === "main") {
    throw { code: 400, message: '"main" is reserved' };
  }

  const cfg = getConfig(api);
  const existingAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  if (existingAgents.some((a: any) => a?.id && normalizeAgentId(a.id) === agentId)) {
    throw { code: 400, message: `agent "${agentId}" already exists` };
  }

  const workspaceDir = resolve(rawWorkspace);
  await mkdir(workspaceDir, { recursive: true });

  // Create IDENTITY.md
  const emoji = String(params.emoji ?? "").trim();
  const avatar = String(params.avatar ?? "").trim();
  const lines = [
    "",
    `- Name: ${rawName}`,
    ...(emoji ? [`- Emoji: ${emoji}`] : []),
    ...(avatar ? [`- Avatar: ${avatar}`] : []),
    "",
  ];

  const identityPath = join(workspaceDir, "IDENTITY.md");
  await writeFile(identityPath, lines.join("\n"), "utf-8");

  portalLog(api, "info", `agents.create: agentId=${agentId} name=${rawName} workspace=${workspaceDir}`);

  return { ok: true, agentId, name: rawName, workspace: workspaceDir };
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handlePortalRequest(api: any, request: PortalRequest): Promise<PortalResponse> {
  const { id, method, params } = request;
  portalLog(api, "info", `request received: id=${id} method=${method} params=${JSON.stringify(params)}`);

  try {
    let result: unknown;
    switch (method) {
      case "models.list":
        result = handleModelsList(api, params ?? {});
        break;
      case "agents.list":
        result = handleAgentsList(api);
        break;
      case "agents.files.list":
        result = await handleAgentsFilesList(api, params ?? {});
        break;
      case "agents.files.get":
        result = await handleAgentsFilesGet(api, params ?? {});
        break;
      case "agents.files.set":
        result = await handleAgentsFilesSet(api, params ?? {});
        break;
      case "agents.create":
        result = await handleAgentsCreate(api, params ?? {});
        break;
      case "ping":
        result = { pong: true };
        break;
      default:
        throw { code: 404, message: `unknown method: ${method}` };
    }
    return { id, result };
  } catch (err: any) {
    const code = typeof err?.code === "number" ? err.code : 500;
    const message = err?.message ?? String(err);
    portalLog(api, "error", `request failed: id=${id} method=${method} error=${message}`);
    return { id, error: { code, message } };
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection management (unchanged logic)
// ---------------------------------------------------------------------------

function sendResponse(ws: WebSocket, response: PortalResponse): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

function connectPortal(api: any, bridge: PortalBridgeState): void {
  if (bridge.stopped) return;

  const url = `${bridge.portalWsAddr}/${bridge.botId}`;
  portalLog(api, "info", `connecting to agent-portal: url=${url} botId=${bridge.botId} accountId=${bridge.accountId}`);

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err: any) {
    portalLog(api, "error", `WebSocket constructor failed: ${err?.message ?? err}`);
    scheduleReconnect(api, bridge, 0);
    return;
  }

  bridge.ws = ws;
  let reconnectAttempts = 0;

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    portalLog(api, "info", `connected to agent-portal: botId=${bridge.botId}`);

    bridge.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const pingMsg: PortalRequest = { id: `ping-${Date.now()}`, method: "ping", params: {} };
        ws.send(JSON.stringify(pingMsg));
        portalLog(api, "debug", `heartbeat ping sent: botId=${bridge.botId}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  });

  ws.addEventListener("message", async (event) => {
    let raw: string;
    if (typeof event.data === "string") {
      raw = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(event.data);
    } else {
      portalLog(api, "warn", `unexpected message data type: ${typeof event.data}`);
      return;
    }

    let request: PortalRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      portalLog(api, "warn", `invalid JSON from portal: ${raw.slice(0, 200)}`);
      return;
    }

    if (!request.id || !request.method) {
      portalLog(api, "warn", `malformed request from portal: missing id or method`);
      return;
    }

    const response = await handlePortalRequest(api, request);
    sendResponse(ws, response);
    portalLog(api, "debug", `response sent: id=${request.id} method=${request.method} ok=${!response.error}`);
  });

  ws.addEventListener("close", (event) => {
    portalLog(api, "info", `disconnected from agent-portal: botId=${bridge.botId} code=${event.code} reason=${event.reason || "none"}`);
    clearHeartbeat(bridge);
    bridge.ws = null;
    if (!bridge.stopped) {
      scheduleReconnect(api, bridge, reconnectAttempts++);
    }
  });

  ws.addEventListener("error", (event) => {
    portalLog(api, "error", `WebSocket error: botId=${bridge.botId} error=${(event as any)?.message ?? "unknown"}`);
  });
}

function clearHeartbeat(bridge: PortalBridgeState): void {
  if (bridge.heartbeatTimer) {
    clearInterval(bridge.heartbeatTimer);
    bridge.heartbeatTimer = undefined;
  }
}

function scheduleReconnect(api: any, bridge: PortalBridgeState, attempt: number): void {
  if (bridge.stopped) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  portalLog(api, "info", `scheduling reconnect in ${delay}ms (attempt ${attempt + 1}): botId=${bridge.botId}`);
  bridge.reconnectTimer = setTimeout(() => {
    if (!bridge.stopped) {
      connectPortal(api, bridge);
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startPortalBridge(api: any, config: OpenIMAccountConfig): void {
  if (!config.botId || !config.portalWsAddr) {
    portalLog(api, "debug", `portal bridge skipped: botId or portalWsAddr not configured for account ${config.accountId}`);
    return;
  }

  if (bridges.has(config.accountId)) {
    portalLog(api, "warn", `portal bridge already running for account ${config.accountId}`);
    return;
  }

  const bridge: PortalBridgeState = {
    ws: null,
    accountId: config.accountId,
    botId: config.botId,
    portalWsAddr: config.portalWsAddr,
    stopped: false,
  };

  bridges.set(config.accountId, bridge);
  portalLog(api, "info", `starting portal bridge: accountId=${config.accountId} botId=${config.botId} portalWsAddr=${config.portalWsAddr}`);
  connectPortal(api, bridge);
}

export function stopPortalBridge(api: any, accountId: string): void {
  const bridge = bridges.get(accountId);
  if (!bridge) return;

  portalLog(api, "info", `stopping portal bridge: accountId=${accountId} botId=${bridge.botId}`);
  bridge.stopped = true;
  bridges.delete(accountId);

  clearHeartbeat(bridge);
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer);
    bridge.reconnectTimer = undefined;
  }
  if (bridge.ws) {
    bridge.ws.close(1000, "account stopping");
    bridge.ws = null;
  }
}

export function stopAllPortalBridges(api: any): void {
  for (const accountId of Array.from(bridges.keys())) {
    stopPortalBridge(api, accountId);
  }
}
