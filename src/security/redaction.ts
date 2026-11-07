export function redactSecrets(text: string): string {
  return text.replace(
    /((?<!\w)['"]?(?:api[_-]?key|token|secret|password|authorization)['"]?(?!\w)\s*[:=]\s*)(?:(['"])(.*?)\2|\S+(?:[ \t]+\S+)*)/gi,
    "$1$2[REDACTED]$2",
  );
}
