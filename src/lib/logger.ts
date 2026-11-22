/** Minimal structured JSON logger (one line per event, no PII, no secrets). */
type Level = "debug" | "info" | "warn" | "error";
type Ctx = Record<string, unknown>;

function emit(level: Level, msg: string, ctx: Ctx = {}) {
  const line = JSON.stringify(
    { ts: new Date().toISOString(), level, msg, ...ctx },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v),
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level !== "debug" || process.env.LOG_LEVEL === "debug") console.log(line);
}

export const log = {
  debug: (msg: string, ctx?: Ctx) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Ctx) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Ctx) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Ctx) => emit("error", msg, ctx),
};
