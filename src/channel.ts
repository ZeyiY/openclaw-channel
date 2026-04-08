import { getConnectedClient, startAccountClient, stopAccountClient } from "./clients";
import { listAccountIds, resolveAccountConfig, getOpenIMAccountConfig } from "./config";
import { sendTextToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";

export const OpenIMChannelPlugin = {
  id: "openim",
  meta: {
    id: "openim",
    label: "OpenIM",
    selectionLabel: "OpenIM",
    docsPath: "/channels/openim",
    blurb: "OpenIM protocol channel via @openim/client-sdk",
    aliases: ["openim", "im"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => resolveAccountConfig(cfg, accountId),
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const api = (globalThis as any).__openimApi;
      if (!api) {
        ctx.log?.error?.("[openim] api not initialized");
        return;
      }
      const config = getOpenIMAccountConfig(ctx.cfg ?? api.config, ctx.accountId);
      if (!config || !config.enabled) return;
      if (!getConnectedClient(ctx.accountId)) {
        await startAccountClient(api, config);
      }
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) {
          resolve();
        } else {
          ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      await stopAccountClient(api, ctx.accountId);
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("OpenIM requires --to <user:ID|group:ID>") };
      }
      return { ok: true, to: `${target.kind}:${target.id}` };
    },
    sendText: async ({ to, text, accountId }: { to: string; text: string; accountId?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("invalid target, expected user:<id> or group:<id>") };
      }
      const client = getConnectedClient(accountId);
      if (!client) {
        return { ok: false, error: new Error("OpenIM not connected") };
      }
      try {
        await sendTextToTarget(client, target, text);
        return { ok: true, provider: "openim" };
      } catch (e: any) {
        return { ok: false, error: new Error(formatSdkError(e)) };
      }
    },
  },
};
