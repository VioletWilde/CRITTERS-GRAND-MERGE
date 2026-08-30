import worker from "./src/index.js";

class MemoryD1 {
  constructor() {
    this.devices = new Map();
    this.scores = new Map();
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...args) => ({
        first: async () => this.first(normalized, args),
        run: async () => this.run(normalized, args),
        all: async () => this.all(normalized, args)
      })
    };
  }

  async first(sql, args) {
    if (sql.includes("FROM devices WHERE device_id")) return this.devices.get(args[0]) || null;
    if (sql.includes("SELECT best_score FROM scores")) {
      const score = this.scores.get(`${args[0]}:${args[1]}`);
      return score ? { best_score: score.best_score } : null;
    }
    if (sql.includes("COUNT(*) AS count")) {
      const [mode, best] = args;
      return { count: [...this.scores.values()].filter(row => row.mode === mode && row.best_score > best).length };
    }
    return null;
  }

  async run(sql, args) {
    if (sql.startsWith("INSERT INTO devices")) {
      this.devices.set(args[0], { secret_hash: args[1], display_code: args[2] });
    } else if (sql.startsWith("INSERT INTO scores")) {
      const [device_id, mode, best_score, updated_at] = args;
      const key = `${device_id}:${mode}`, old = this.scores.get(key);
      if (!old || best_score > old.best_score) this.scores.set(key, { device_id, mode, best_score, updated_at });
    }
    return { success: true };
  }

  async all(sql, args) {
    if (!sql.includes("FROM scores s")) return { results: [] };
    const [mode, limit] = args;
    const results = [...this.scores.values()]
      .filter(row => row.mode === mode)
      .sort((a, b) => b.best_score - a.best_score || a.updated_at - b.updated_at)
      .slice(0, limit)
      .map(row => ({ ...row, display_code: this.devices.get(row.device_id).display_code }));
    return { results };
  }
}

const env = {
  DB: new MemoryD1(),
  ALLOWED_ORIGINS: "https://game.example",
  SUBMIT_LIMITER: { limit: async () => ({ success: true }) }
};
const origin = "https://game.example";
const deviceId = "123e4567-e89b-12d3-a456-426614174000";
const deviceSecret = "a".repeat(64);

async function call(path, method = "GET", body) {
  const request = new Request(`https://api.example${path}`, {
    method,
    headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json() };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const registered = await call("/device/register", "POST", { deviceId, deviceSecret });
assert(registered.status === 200 && registered.body.deviceCode.startsWith("访客 "), "device registration failed");

const first = await call("/score", "POST", { deviceId, deviceSecret, mode: "endless", score: 1500, drops: 10, durationMs: 60_000 });
assert(first.status === 200 && first.body.bestScore === 1500, "score submission failed");

const lower = await call("/score", "POST", { deviceId, deviceSecret, mode: "endless", score: 500, drops: 10, durationMs: 60_000 });
assert(lower.status === 200 && lower.body.bestScore === 1500, "lower score replaced the best score");

const board = await call(`/leaderboard?mode=endless&deviceId=${deviceId}&limit=50`);
assert(board.status === 200 && board.body.entries[0].score === 1500 && board.body.mine.rank === 1, "leaderboard query failed");

const invalid = await call("/score", "POST", { deviceId, deviceSecret, mode: "unknown", score: 1, drops: 1, durationMs: 60_000 });
assert(invalid.status === 400, "invalid mode was accepted");

const wrongSecret = await call("/score", "POST", { deviceId, deviceSecret: "b".repeat(64), mode: "endless", score: 200, drops: 10, durationMs: 12_000 });
assert(wrongSecret.status === 403, "wrong device secret was accepted");

const missingOrigin = await worker.fetch(new Request("https://api.example/leaderboard?mode=endless"), env);
assert(missingOrigin.status === 403, "request without an origin was accepted");

console.log("Leaderboard Worker tests passed.");
