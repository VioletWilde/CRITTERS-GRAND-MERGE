const MODES = new Set(["endless", "dual"]);
const MAX_SCORE = 100_000_000;
const MAX_DROPS = 100_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      if (!origin || !isAllowedOrigin(origin, env)) return json({ error: "Origin not allowed" }, 403, cors);
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "critters-leaderboard" }, 200, cors);
      }

      if (!origin || !isAllowedOrigin(origin, env)) return json({ error: "Origin not allowed" }, 403, cors);

      if (url.pathname === "/device/register" && request.method === "POST") {
        const body = await readJson(request);
        validateIdentity(body.deviceId, body.deviceSecret);
        await rateLimit(env, `register:${body.deviceId}`);

        const secretHash = await sha256(body.deviceSecret);
        const existing = await env.DB.prepare(
          "SELECT secret_hash, display_code, display_name, name_updated_at FROM devices WHERE device_id = ?"
        ).bind(body.deviceId).first();

        if (existing && existing.secret_hash !== secretHash) {
          return json({ error: "Device identity conflict" }, 403, cors);
        }

        const deviceCode = existing?.display_code || await createDisplayCode(body.deviceId);
        if (!existing) {
          await env.DB.prepare(
            "INSERT INTO devices (device_id, secret_hash, display_code, created_at) VALUES (?, ?, ?, unixepoch())"
          ).bind(body.deviceId, secretHash, deviceCode).run();
        }

        return json({
          ok: true,
          deviceCode,
          displayName: existing?.display_name || "",
          nameUpdatedAt: existing?.name_updated_at || null
        }, 200, cors);
      }

      if (url.pathname === "/device/name" && request.method === "POST") {
        const body = await readJson(request);
        validateIdentity(body.deviceId, body.deviceSecret);
        const displayName = normalizeDisplayName(body.displayName);
        await rateLimit(env, `name:${body.deviceId}`);
        const device = await authenticateDevice(env, body.deviceId, body.deviceSecret, true);
        const now = Math.floor(Date.now() / 1000);
        const cooldown = 86_400;
        if (device.name_updated_at && now - Number(device.name_updated_at) < cooldown) {
          const retryAfter = cooldown - (now - Number(device.name_updated_at));
          return json({ error: "Nickname can only be changed once every 24 hours", retryAfter }, 429, cors);
        }
        await env.DB.prepare(
          "UPDATE devices SET display_name = ?, name_updated_at = ? WHERE device_id = ?"
        ).bind(displayName, now, body.deviceId).run();
        return json({ ok: true, displayName, deviceCode: device.display_code, nameUpdatedAt: now }, 200, cors);
      }

      if (url.pathname === "/score" && request.method === "POST") {
        const body = await readJson(request);
        validateIdentity(body.deviceId, body.deviceSecret);
        validateScore(body);
        await rateLimit(env, `score:${body.deviceId}`);
        await authenticateDevice(env, body.deviceId, body.deviceSecret);

        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(`
          INSERT INTO scores (device_id, mode, best_score, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(device_id, mode) DO UPDATE SET
            best_score = excluded.best_score,
            updated_at = excluded.updated_at
          WHERE excluded.best_score > scores.best_score
        `).bind(body.deviceId, body.mode, body.score, now).run();

        const saved = await env.DB.prepare(
          "SELECT best_score FROM scores WHERE device_id = ? AND mode = ?"
        ).bind(body.deviceId, body.mode).first();

        return json({ ok: true, bestScore: saved?.best_score ?? body.score }, 200, cors);
      }

      if (url.pathname === "/leaderboard" && request.method === "GET") {
        const mode = url.searchParams.get("mode");
        const deviceId = url.searchParams.get("deviceId") || "";
        const limit = clamp(Number(url.searchParams.get("limit") || 50), 1, 50);
        if (!MODES.has(mode)) return json({ error: "Invalid mode" }, 400, cors);
        if (deviceId && !validDeviceId(deviceId)) return json({ error: "Invalid deviceId" }, 400, cors);

        const result = await env.DB.prepare(`
          SELECT s.device_id, d.display_code, d.display_name, s.best_score
          FROM scores s
          JOIN devices d ON d.device_id = s.device_id
          WHERE s.mode = ?
          ORDER BY s.best_score DESC, s.updated_at ASC
          LIMIT ?
        `).bind(mode, limit).all();

        const entries = (result.results || []).map((row, index) => ({
          rank: index + 1,
          deviceCode: row.display_code,
          displayName: row.display_name || row.display_code,
          score: row.best_score,
          isMine: row.device_id === deviceId
        }));

        let mine = null;
        if (deviceId) {
          const own = await env.DB.prepare(
            "SELECT best_score FROM scores WHERE device_id = ? AND mode = ?"
          ).bind(deviceId, mode).first();
          if (own) {
            const higher = await env.DB.prepare(
              "SELECT COUNT(*) AS count FROM scores WHERE mode = ? AND best_score > ?"
            ).bind(mode, own.best_score).first();
            mine = { rank: Number(higher?.count || 0) + 1, score: own.best_score };
          }
        }

        return json({ mode, entries, mine }, 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, cors);
      console.error("leaderboard_error", error);
      return json({ error: "Internal server error" }, 500, cors);
    }
  }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "JSON required");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function validateIdentity(deviceId, deviceSecret) {
  if (!validDeviceId(deviceId)) throw new HttpError(400, "Invalid deviceId");
  if (!/^[a-f0-9]{64}$/i.test(String(deviceSecret || ""))) throw new HttpError(400, "Invalid deviceSecret");
}

function validDeviceId(value) {
  return /^[a-f0-9-]{32,36}$/i.test(String(value || ""));
}

function validateScore(body) {
  if (!MODES.has(body.mode)) throw new HttpError(400, "Invalid mode");
  if (!Number.isInteger(body.score) || body.score < 0 || body.score > MAX_SCORE) throw new HttpError(400, "Invalid score");
  if (!Number.isInteger(body.drops) || body.drops < 1 || body.drops > MAX_DROPS) throw new HttpError(400, "Invalid drops");
  if (!Number.isInteger(body.durationMs) || body.durationMs < 1_000 || body.durationMs > 604_800_000) throw new HttpError(400, "Invalid duration");
  if (body.score > body.drops * 10_000 + 5_000) throw new HttpError(400, "Score outside casual validation range");
}

function normalizeDisplayName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  const length = [...name].length;
  if (length < 2 || length > 12) throw new HttpError(400, "Nickname must contain 2 to 12 characters");
  if (!/^[\p{L}\p{N} _·-]+$/u.test(name)) throw new HttpError(400, "Nickname contains unsupported characters");
  return name;
}

async function authenticateDevice(env, deviceId, deviceSecret, includeProfile = false) {
  const row = await env.DB.prepare(
    `SELECT secret_hash${includeProfile ? ", display_code, display_name, name_updated_at" : ""} FROM devices WHERE device_id = ?`
  ).bind(deviceId).first();
  if (!row) throw new HttpError(401, "Device is not registered");
  if (row.secret_hash !== await sha256(deviceSecret)) throw new HttpError(403, "Invalid device secret");
  return row;
}

async function rateLimit(env, key) {
  if (!env.SUBMIT_LIMITER?.limit) return;
  const result = await env.SUBMIT_LIMITER.limit({ key });
  if (!result.success) throw new HttpError(429, "Too many requests");
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function createDisplayCode(deviceId) {
  const digest = await sha256(`critters:${deviceId}`);
  return `访客 ${digest.slice(0, 6).toUpperCase()}`;
}

function isAllowedOrigin(origin, env) {
  if (!origin) return true;
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function corsHeaders(origin, env) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  };
  if (origin && isAllowedOrigin(origin, env)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}
