export function serializeBody(
  body: unknown,
  onSerialized?: (elapsedMs: number) => void,
): string {
  if (!onSerialized) return JSON.stringify(body);
  const startedAt = Date.now();
  const serialized = JSON.stringify(body);
  onSerialized(Date.now() - startedAt);
  return serialized;
}
