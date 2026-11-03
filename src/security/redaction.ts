export function redactSecrets(text: string): string {
  return text.replace(
    /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)\S+/gi,
    "$1[REDACTED]",
  );
}
