/**
 * Param redaction — strips sensitive values before transmitting to dashboard.
 *
 * Keeps structure but replaces values of sensitive keys with "[REDACTED]".
 * Truncates long string values to prevent bloated payloads.
 */

// ---------------------------------------------------------------------------
// Sensitive key patterns
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "apikey",
  "authorization",
  "credentials",
  "private_key",
  "privatekey",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "client_secret",
  "clientsecret",
  "bearer",
  "cookie",
  "session_id",
  "sessionid",
  "passphrase",
]);

const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}/,              // OpenAI/Anthropic keys
  /^pk_[a-zA-Z0-9]{20,}/,              // Stripe-style
  /^ghp_[a-zA-Z0-9]{36,}/,             // GitHub PAT
  /^gho_[a-zA-Z0-9]{36,}/,             // GitHub OAuth
  /^pw_[a-zA-Z0-9]{20,}/,              // Podwatch keys
  /^tvly-[a-zA-Z0-9]{20,}/,            // Tavily keys
  /^Bearer\s+[a-zA-Z0-9._-]{20,}/i,    // Bearer tokens
  /^Basic\s+[a-zA-Z0-9+/=]{20,}/i,     // Basic auth
  /^eyJ[a-zA-Z0-9._-]{50,}/,           // JWT tokens
  /^AKIA[A-Z0-9]{16}/,                 // AWS access keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/,// PEM keys
];

const MAX_VALUE_LENGTH = 500;

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from tool call params.
 * Returns a new object with sensitive values replaced.
 */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return redactObject(params, 0);
}

function redactObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 5) return { "[truncated]": "nested too deep" };

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase().replace(/[-_]/g, "");

    // Key-based redaction
    if (SENSITIVE_KEYS.has(keyLower)) {
      result[key] = "[REDACTED]";
      continue;
    }

    // Value-based redaction + truncation
    if (typeof value === "string") {
      if (SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))) {
        result[key] = "[REDACTED]";
      } else if (value.length > MAX_VALUE_LENGTH) {
        result[key] = value.slice(0, MAX_VALUE_LENGTH) + `… [${value.length} chars]`;
      } else {
        result[key] = value;
      }
      continue;
    }

    // Recurse into nested objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>, depth + 1);
      continue;
    }

    // Arrays — redact string elements
    if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === "string" && SENSITIVE_VALUE_PATTERNS.some((p) => p.test(item))) {
          return "[REDACTED]";
        }
        if (typeof item === "string" && item.length > MAX_VALUE_LENGTH) {
          return item.slice(0, MAX_VALUE_LENGTH) + `… [${item.length} chars]`;
        }
        return item;
      });
      continue;
    }

    // Primitives pass through
    result[key] = value;
  }

  return result;
}
