/**
 * Structured JSON logging.
 *
 * Rule for this codebase: an exception is never swallowed. Every catch block
 * calls `log.exception(...)` with enough context to identify the message or
 * request, and then either rethrows or returns an explicit error response.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

/** Flattens an Error (and its `cause` chain) into something JSON-safe. */
export function serializeError(err: unknown, depth = 0): unknown {
  if (depth > 5) return "[cause chain truncated]";

  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    };
    if (err.cause !== undefined) out.cause = serializeError(err.cause, depth + 1);
    return out;
  }

  if (typeof err === "object" && err !== null) {
    try {
      return JSON.parse(JSON.stringify(err));
    } catch {
      // JSON.stringify failed (cycles, BigInt, throwing getters). Do not lose
      // the value — fall through to a string form.
      return { name: "UnserializableThrownValue", message: String(err) };
    }
  }

  return { name: "NonErrorThrownValue", message: String(err), type: typeof err };
}

export class Logger {
  constructor(
    private readonly minLevel: number,
    private readonly base: LogFields,
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(this.minLevel, { ...this.base, ...fields });
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  /** Always logs at error level, regardless of LOG_LEVEL. */
  exception(err: unknown, message: string, fields?: LogFields): void {
    this.write("error", message, { ...fields, error: serializeError(err) });
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    this.write(level, message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    const line = { level, msg: message, time: new Date().toISOString(), ...this.base, ...fields };

    let text: string;
    try {
      text = JSON.stringify(line);
    } catch (stringifyErr) {
      // Never let logging itself throw and mask the original problem.
      text = JSON.stringify({
        level,
        msg: message,
        time: new Date().toISOString(),
        logSerializationError: String(stringifyErr),
      });
    }

    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  }
}

export function createLogger(level: string | undefined, base: LogFields = {}): Logger {
  const normalized = (level ?? "info").toLowerCase();
  const min = normalized in LEVEL_ORDER ? LEVEL_ORDER[normalized as LogLevel] : LEVEL_ORDER.info;
  return new Logger(min, base);
}
