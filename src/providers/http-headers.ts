import { randomUUID } from "node:crypto";

export type HeaderMap = Record<string, string>;

/**
 * Set a header, replacing any existing key that differs only by case.
 * HTTP header names are case-insensitive, so a naive object spread can leave
 * duplicate keys (for example `Content-Type` and `content-type`).
 */
export function setHeader(
  headers: HeaderMap,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

/** Merge header maps case-insensitively; later maps win. */
export function mergeHeaders(
  defaults: HeaderMap,
  overrides?: HeaderMap,
): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(defaults)) {
    setHeader(out, name, value);
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    setHeader(out, name, value);
  }
  return out;
}

/** Resolve an explicit request id, or generate a fresh UUID. */
export function resolveRequestId(requestId?: string): string {
  const trimmed = requestId?.trim();
  return trimmed ? trimmed : randomUUID();
}

/** Apply `X-Request-ID` case-insensitively and return the resolved id. */
export function applyRequestId(headers: HeaderMap, requestId?: string): string {
  const id = resolveRequestId(requestId);
  setHeader(headers, "X-Request-ID", id);
  return id;
}
