import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL = 2 * 60 * 60 * 1000;
const PEER_TIMEOUT = 45_000;
const MAX_BODY = 64_000;

type Role = "host" | "guest";
type RoomRow = {
  code: string;
  host_token: string;
  guest_token: string | null;
  expires_at: number;
  host_seen: number;
  guest_seen: number | null;
  host_signal: string | null;
  guest_signal: string | null;
  host_data: string | null;
  guest_data: string | null;
};
type JsonObject = Record<string, unknown>;

class RoomError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (v) => v.toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  let result = "";
  while (result.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(12))) {
      if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) result += ALPHABET[byte % ALPHABET.length];
      if (result.length === 6) break;
    }
  }
  return result;
}

async function digest(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (v) => v.toString(16).padStart(2, "0")).join("");
}

function parseStored(value: string | null) {
  return value ? JSON.parse(value) : null;
}

function safeSequence(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

async function readBody(request: Request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) throw new RoomError("请求过大", 413);
  if (!request.body) throw new RoomError("无效的请求");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new RoomError("请求过大", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function validateGameMessage(value: unknown, role: Role) {
  if (!object(value) || typeof value.type !== "string") throw new RoomError("无效的游戏消息");
  const allowed = role === "host" ? ["state", "serve", "restart", "pause"] : ["input", "serve", "restart", "pause"];
  if (!allowed.includes(value.type)) throw new RoomError("不支持的游戏消息");
  if (JSON.stringify(value).length > 16_000) throw new RoomError("游戏消息过大", 413);
}

function validateMailbox(value: unknown, role: Role) {
  if (!object(value) || typeof value.session !== "string" || value.session.length > 32 || !safeSequence(value.ack) || !Array.isArray(value.reliable) || value.reliable.length > 32) throw new RoomError("无效的同步数据");
  if (value.realtime !== null) {
    if (!object(value.realtime) || !safeSequence(value.realtime.seq)) throw new RoomError("无效的移动数据");
    validateGameMessage(value.realtime.data, role);
    if (!["state", "input"].includes((value.realtime.data as JsonObject).type as string)) throw new RoomError("无效的移动数据");
  }
  let previous = -1;
  for (const entry of value.reliable) {
    if (!object(entry) || !safeSequence(entry.seq) || Number(entry.seq) <= previous) throw new RoomError("无效的操作序号");
    validateGameMessage(entry.data, role);
    if (["state", "input"].includes((entry.data as JsonObject).type as string)) throw new RoomError("无效的操作数据");
    previous = Number(entry.seq);
  }
  if (JSON.stringify(value).length > 32_000) throw new RoomError("同步数据过大", 413);
}

function validateSignal(value: unknown, role: Role) {
  if (!object(value) || typeof value.id !== "string" || value.id.length > 64 || value.type !== (role === "host" ? "offer" : "answer") || typeof value.sdp !== "string" || value.sdp.length > 24_000) throw new RoomError("无效的连接信息");
}

function roomView(row: RoomRow, role: Role, now: number) {
  const peerConnected = role === "host"
    ? Boolean(row.guest_token && row.guest_seen && row.guest_seen > now - PEER_TIMEOUT)
    : row.host_seen > now - PEER_TIMEOUT;
  return {
    room: { code: row.code, role },
    peerConnected,
    peerId: peerConnected ? (role === "host" ? row.guest_token?.slice(0, 16) : row.host_token.slice(0, 16)) : null,
    session: peerConnected ? row.guest_token?.slice(0, 16) : null,
    signal: parseStored(role === "host" ? row.guest_signal : row.host_signal),
    mailbox: peerConnected ? parseStored(role === "host" ? row.guest_data : row.host_data) : null,
  };
}

export async function POST(request: Request) {
  try {
    const text = await readBody(request);
    let payload: JsonObject;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!object(parsed)) throw new Error();
      payload = parsed;
    } catch { throw new RoomError("无效的请求"); }

    const db = env.DB as D1Database | undefined;
    if (!db) throw new RoomError("联机服务尚未配置，请稍后再试", 503);
    const now = Date.now();

    if (payload.action === "create") {
      const token = randomToken();
      const hashed = await digest(token);
      await db.prepare("DELETE FROM rooms WHERE expires_at < ?").bind(now).run();
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        const inserted = await db.prepare("INSERT OR IGNORE INTO rooms (code, host_token, created_at, expires_at, host_seen) VALUES (?, ?, ?, ?, ?)").bind(code, hashed, now, now + ROOM_TTL, now).run();
        if (inserted.meta.changes) return json({ room: { code, role: "host" }, token, peerConnected: false }, 201);
      }
      throw new RoomError("房间创建繁忙，请再试一次", 503);
    }

    const code = typeof payload.code === "string" ? payload.code.trim().toUpperCase() : "";
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) throw new RoomError("请输入 6 位房间码");

    if (payload.action === "join") {
      const token = randomToken();
      const hashed = await digest(token);
      // The conditional update makes simultaneous joins race-safe.
      const joined = await db.prepare("UPDATE rooms SET guest_token = ?, guest_seen = ?, guest_signal = NULL, guest_data = NULL, expires_at = ? WHERE code = ? AND expires_at > ? AND host_seen > ? AND (guest_token IS NULL OR guest_seen < ?)").bind(hashed, now, now + ROOM_TTL, code, now, now - PEER_TIMEOUT, now - PEER_TIMEOUT).run();
      if (!joined.meta.changes) {
        const existing = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<RoomRow>();
        if (!existing || existing.expires_at <= now) throw new RoomError("房间不存在或已过期", 404);
        if (existing.host_seen <= now - PEER_TIMEOUT) throw new RoomError("房主已离线，请重新创建房间", 410);
        throw new RoomError("房间已有两位玩家", 409);
      }
      const row = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<RoomRow>();
      if (!row || row.guest_token !== hashed) throw new RoomError("房间已关闭", 410);
      return json({ ...roomView(row, "guest", now), token });
    }

    if (payload.action !== "sync" && payload.action !== "leave") throw new RoomError("不支持的请求");
    if (typeof payload.token !== "string" || !/^[a-f0-9]{48}$/.test(payload.token)) throw new RoomError("无效的房间凭证", 401);
    const hashed = await digest(payload.token);
    const row = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<RoomRow>();
    if (!row || row.expires_at <= now) throw new RoomError("房间已关闭或过期", 410);
    const role: Role = row.host_token === hashed ? "host" : row.guest_token === hashed ? "guest" : (() => { throw new RoomError("无效的房间凭证", 403); })();

    if (payload.action === "leave") {
      if (role === "host") await db.prepare("DELETE FROM rooms WHERE code = ? AND host_token = ?").bind(code, hashed).run();
      else await db.prepare("UPDATE rooms SET guest_token = NULL, guest_seen = NULL, guest_signal = NULL, guest_data = NULL WHERE code = ? AND guest_token = ?").bind(code, hashed).run();
      return json({ ok: true });
    }

    if (role === "guest" && row.host_seen <= now - PEER_TIMEOUT) throw new RoomError("房主已离线", 410);
    if (payload.signal !== undefined) validateSignal(payload.signal, role);
    if (payload.mailbox !== undefined) validateMailbox(payload.mailbox, role);
    const prefix = role === "host" ? "host" : "guest";
    const columns = [`${prefix}_seen = ?`, "expires_at = ?"];
    const values: (string | number)[] = [now, now + ROOM_TTL];
    if (payload.signal !== undefined) { columns.push(`${prefix}_signal = ?`); values.push(JSON.stringify(payload.signal)); }
    if (payload.mailbox !== undefined && (payload.mailbox as JsonObject).session === row.guest_token?.slice(0, 16)) { columns.push(`${prefix}_data = ?`); values.push(JSON.stringify(payload.mailbox)); }
    values.push(code, hashed);
    const updated = await db.prepare(`UPDATE rooms SET ${columns.join(", ")} WHERE code = ? AND ${prefix}_token = ?`).bind(...values).run();
    if (!updated.meta.changes) throw new RoomError("房间已关闭", 410);
    const fresh = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<RoomRow>();
    if (!fresh) throw new RoomError("房间已关闭", 410);
    return json(roomView(fresh, role, now));
  } catch (error) {
    if (error instanceof RoomError) return json({ error: error.message }, error.status);
    console.error("Room API error", error);
    return json({ error: "联机服务暂时不可用，请稍后重试" }, 503);
  }
}
