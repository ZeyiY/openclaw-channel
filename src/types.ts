import type { ApiService, CallbackEvent, MessageItem } from "@openim/client-sdk";

export type ChatType = "direct" | "group";

export interface OpenIMAccountConfig {
  accountId: string;
  enabled: boolean;
  userID: string;
  token: string;
  wsAddr: string;
  apiAddr: string;
  platformID: number;
  requireMention: boolean;
  inboundWhitelist: string[];
  botId?: string;
  portalWsAddr?: string;
}

export interface OpenIMClientState {
  sdk: ApiService;
  config: OpenIMAccountConfig;
  handlers: {
    onRecvNewMessage: (event: CallbackEvent<MessageItem>) => void;
    onRecvNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onRecvOfflineNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
  };
}

export interface ParsedTarget {
  kind: "user" | "group";
  id: string;
}

export interface InboundMediaItem {
  kind: "image" | "video" | "file";
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  snapshotUrl?: string;
}

export interface InboundBodyResult {
  body: string;
  kind: "text" | "image" | "video" | "file" | "mixed" | "unknown";
  media?: InboundMediaItem[];
}

// Portal Bridge types

export type PortalMethod =
  | "models.list"
  | "agents.list"
  | "agents.files.list"
  | "agents.files.get"
  | "agents.files.set"
  | "agents.create"
  | "ping";

export interface PortalRequest {
  id: string;
  method: PortalMethod;
  params: Record<string, unknown>;
}

export interface PortalResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface PortalBridgeState {
  ws: WebSocket | null;
  accountId: string;
  botId: string;
  portalWsAddr: string;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  stopped: boolean;
}

// --- Response types ---

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  active?: boolean;
}

export interface AgentIdentity {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
}

export interface AgentSummary {
  id: string;
  name?: string;
  identity?: AgentIdentity;
  workspace?: string;
  model?: {
    primary?: string;
    fallbacks?: string[];
  };
}

export interface AgentFileEntry {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
}
