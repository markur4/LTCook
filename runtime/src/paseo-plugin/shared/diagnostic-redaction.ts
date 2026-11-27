const PRIVATE_ENV_KEYS = /(?:secret|token|password|api.?key|authorization|credential)$/i;
const PRIVATE_HEADER =
  /(\b(?:proxy-authorization|authorization|set-cookie|cookie)\b["']?[ \t]*:[ \t]*)[^\r\n]*/gi;
const SECRET_ASSIGNMENT =
  /(\b(?:[\w-]*(?:token|password|secret|api[_.-]?key|credential)|authorization|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;&]+|[^\s,;&]+)/gi;

export function redactDiagnosticText(
  text: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let result = text;
  for (const [key, value] of Object.entries(environment)) {
    if (value && value.length >= 8 && PRIVATE_ENV_KEYS.test(key))
      result = result.replaceAll(value, '<redacted>');
  }
  return result
    .replace(PRIVATE_HEADER, '$1<redacted>')
    .replace(SECRET_ASSIGNMENT, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 <redacted>')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '<redacted>');
}
