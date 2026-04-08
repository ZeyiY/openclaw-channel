import type { MessageItem } from "@openim/client-sdk";
import { File } from "node:buffer";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getRecvAndGroupID } from "./targets";
import type { OpenIMClientState, ParsedTarget } from "./types";

/** 调试日志：写入 /tmp/openim-debug.log，方便排查问题 */
function debugLog(msg: string): void {
  const line = `${new Date().toISOString()} [openim-debug] ${msg}\n`;
  try { appendFileSync("/tmp/openim-debug.log", line); } catch {}
}

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function toLocalPath(input: string): string {
  const raw = input.trim();
  if (raw.startsWith("file://")) return decodeURIComponent(raw.slice("file://".length));
  return raw;
}

function guessMime(pathOrName: string, fallback = "application/octet-stream"): string {
  const ext = extname(pathOrName).toLowerCase();
  const table: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return table[ext] || fallback;
}

function inferNameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const name = basename(u.pathname || "");
    return name || fallback;
  } catch {
    return fallback;
  }
}

async function readLocalAsFile(pathInput: string, forcedName?: string): Promise<{
  file: File;
  filePath: string;
  fileName: string;
  size: number;
  mime: string;
}> {
  const filePath = toLocalPath(pathInput);
  const st = await stat(filePath);
  const data = await readFile(filePath);
  const fileName = forcedName?.trim() || basename(filePath) || `file-${Date.now()}`;
  const mime = guessMime(fileName);
  const file = new File([data], fileName, { type: mime });
  return { file, filePath, fileName, size: st.size, mime };
}

export async function sendTextToTarget(client: OpenIMClientState, target: ParsedTarget, text: string): Promise<void> {
  const recvID = target.kind === "user" ? target.id : "";
  const groupID = target.kind === "group" ? target.id : "";

  let message: MessageItem | undefined;

  // 群聊场景：解析文本中的 @提及，构造 at 消息
  if (target.kind === "group") {
    // 统一 <@ID> 和 @ID 两种格式，收集去重后的被 @ 用户 ID
    const atIDs = new Set<string>();
    let normalizedText = text.replace(/<@(\d{6,})>/g, (_match, id) => { atIDs.add(id); return `@${id}`; });
    for (const m of normalizedText.matchAll(/@(\d{6,})/g)) atIDs.add(m[1]);

    if (atIDs.size > 0) {
      const atUserIDList = [...atIDs];
      // 默认用 ID 作为昵称，后续尝试查询真实群昵称
      let atUsersInfo = atUserIDList.map((id) => ({ atUserID: id, groupNickname: id }));
      try {
        // 查询被 @ 用户在群内的昵称信息
        const membersRes = await client.sdk.getSpecifiedGroupMembersInfo({ groupID: target.id, userIDList: atUserIDList });
        if (membersRes?.data) {
          const nickMap = new Map(membersRes.data.map((m: any) => [m.userID, m.nickname || m.groupNickname || m.userID]));
          atUsersInfo = atUserIDList.map((id) => ({ atUserID: id, groupNickname: (nickMap.get(id) as string) || id }));
        }
      } catch (e) {
        debugLog(`getSpecifiedGroupMembersInfo failed: ${e}`);
      }

      debugLog(`atMsg group=${target.id} users=${JSON.stringify(atUsersInfo)}`);
      try {
        // 创建带 @提及 的文本消息
        const created = await client.sdk.createTextAtMessage({ text: normalizedText, atUserIDList, atUsersInfo });
        message = created?.data;
      } catch (e) {
        debugLog(`createTextAtMessage failed: ${e}`);
      }
    }
  }

  // 如果不是 at 消息或 at 消息创建失败，回退为普通文本消息
  if (!message) {
    const created = await client.sdk.createTextMessage(text);
    message = created?.data;
    if (!message) throw new Error("createTextMessage failed");
  }

  await client.sdk.sendMessage({ recvID, groupID, message });
}

export async function sendImageToTarget(client: OpenIMClientState, target: ParsedTarget, image: string): Promise<void> {
  const input = image.trim();
  if (!input) throw new Error("image is empty");

  let message: MessageItem | undefined;
  if (isUrl(input)) {
    const name = inferNameFromUrl(input, "image.jpg");
    const pic = {
      uuid: randomUUID(),
      type: guessMime(name, "image/jpeg"),
      size: 0,
      width: 0,
      height: 0,
      url: input,
    };
    const created = await client.sdk.createImageMessageByURL({
      sourcePicture: pic,
      bigPicture: { ...pic },
      snapshotPicture: { ...pic },
      sourcePath: name,
    });
    message = created?.data;
  } else {
    const local = await readLocalAsFile(input);
    const pic = {
      uuid: randomUUID(),
      type: local.mime,
      size: local.size,
      width: 0,
      height: 0,
      url: "",
    };
    const created = await client.sdk.createImageMessageByFile({
      sourcePicture: pic,
      bigPicture: { ...pic },
      snapshotPicture: { ...pic },
      sourcePath: local.filePath,
      file: local.file,
    });
    message = created?.data;
  }

  if (!message) throw new Error("createImageMessage failed");
  const { recvID, groupID } = getRecvAndGroupID(target);
  await client.sdk.sendMessage({ recvID, groupID, message });
}

export async function sendVideoToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  video: string,
  name?: string
): Promise<void> {
  const input = video.trim();
  if (!input) throw new Error("video is empty");
  // Product policy: do not send OpenIM video messages; send videos as file messages.
  await sendFileToTarget(client, target, input, name);
}

export async function sendFileToTarget(
  client: OpenIMClientState,
  target: ParsedTarget,
  filePathOrUrl: string,
  name?: string
): Promise<void> {
  const input = filePathOrUrl.trim();
  if (!input) throw new Error("file is empty");

  let message: MessageItem | undefined;
  if (isUrl(input)) {
    const fileName = name?.trim() || inferNameFromUrl(input, "file.bin");
    const created = await client.sdk.createFileMessageByURL({
      filePath: fileName,
      fileName,
      uuid: randomUUID(),
      sourceUrl: input,
      fileSize: 0,
      fileType: guessMime(fileName),
    });
    message = created?.data;
  } else {
    const local = await readLocalAsFile(input, name);
    const created = await client.sdk.createFileMessageByFile({
      filePath: local.filePath,
      fileName: local.fileName,
      uuid: randomUUID(),
      sourceUrl: "",
      fileSize: local.size,
      fileType: local.mime,
      file: local.file,
    });
    message = created?.data;
  }

  if (!message) throw new Error("createFileMessage failed");
  const { recvID, groupID } = getRecvAndGroupID(target);
  await client.sdk.sendMessage({ recvID, groupID, message });
}
