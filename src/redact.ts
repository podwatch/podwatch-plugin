/**
 * Param redaction — strips sensitive values before transmitting to dashboard.
 *
 * Keeps structure but replaces values of sensitive keys with "[REDACTED]".
 * Truncates long string values to prevent bloated payloads.
 *
 * Returns { result, redactedCount } so callers can track how many fields
 * were scrubbed (heavy redaction > 3 feeds into risk classification).
 */

// ---------------------------------------------------------------------------
// Sensitive key patterns (normalized: lowercase, no hyphens/underscores)
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  // Original
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
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

  // Encryption / signing
  "encryptionkey",
  "encryption_key",
  "signingkey",
  "signing_key",
  "masterkey",
  "master_key",

  // Database
  "databaseurl",
  "database_url",
  "dburl",
  "db_url",
  "dbpassword",
  "db_password",
  "connectionstring",
  "connection_string",

  // Communication / SMTP
  "smtppassword",
  "smtp_password",
  "webhooksecret",
  "webhook_secret",

  // JWT / App
  "jwtsecret",
  "jwt_secret",
  "appsecret",
  "app_secret",

  // Crypto primitives (when used as keys)
  "hmac",
  "nonce",
  "salt",

  // Provider-specific key names
  "resendapikey",
  "resend_api_key",
  "inngestkey",
  "inngest_signing_key",
  "planetscaletoken",
  "planetscale_token",
  "railwaytoken",
  "railway_token",
  "renderkey",
  "render_api_key",
  "postmarktoken",
  "postmark_server_token",
  "postmark_api_token",
  "lemonsqueezyapikey",
  "lemon_squeezy_api_key",
  "pineconeapikey",
  "pinecone_api_key",
  "weaviateapikey",
  "weaviate_api_key",
  "flyapitoken",
  "fly_api_token",
]);

// ---------------------------------------------------------------------------
// Value-based patterns (regex detection on string values)
// ---------------------------------------------------------------------------

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  // --- AI / LLM Providers ---
  /^sk-[a-zA-Z0-9]{20,}/,                                // OpenAI keys
  /sk-ant-api03-[a-zA-Z0-9_-]{93}AA/,                    // Anthropic API key
  /sk-ant-admin01-[a-zA-Z0-9_-]{93}AA/,                  // Anthropic admin key
  /AIza[0-9A-Za-z_-]{35}/,                                // Google/GCP API key
  /GOCSPX-[a-zA-Z0-9_-]+/,                               // Google OAuth client secret
  /^co-[a-zA-Z0-9]{40}$/,                                 // Cohere API key
  /^r8_[a-zA-Z0-9]{40}$/,                                 // Replicate API key
  /^hf_[a-zA-Z0-9]{34}$/,                                 // HuggingFace token

  // --- Auth / Identity Providers ---
  /^sk_live_[a-zA-Z0-9]+/,                                // Clerk/Stripe live secret
  /^pk_live_[a-zA-Z0-9]+/,                                // Clerk/Stripe live public
  /^sk_test_[a-zA-Z0-9]+/,                                // Clerk/Stripe test secret
  /^pk_test_[a-zA-Z0-9]+/,                                // Clerk/Stripe test public
  /^sbp_[a-zA-Z0-9]+/,                                    // Supabase project token
  /^eyJ[a-zA-Z0-9._-]{50,}/,                              // JWT tokens (also catches Supabase service role JWTs)

  // --- Cloud / Infrastructure ---
  /^AKIA[A-Z0-9]{16}/,                                    // AWS access key (permanent)
  /^ASIA[A-Z0-9]{16}/,                                    // AWS access key (temporary/STS)
  /^ABIA[A-Z0-9]{16}/,                                    // AWS access key (STS for billing)
  /^vercel_[a-zA-Z0-9_]+/,                                // Vercel token
  /^hvs\.[a-zA-Z0-9_-]+/,                                 // Hashicorp Vault token
  /^dp\.st\.[a-zA-Z0-9_-]+/,                              // Doppler service token
  /[a-zA-Z0-9]{14}\.atlasv1\.[a-zA-Z0-9_-]{60,}/,        // Terraform Cloud token

  // --- Database / Connection Strings (CRITICAL) ---
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s]+/,               // Postgres connection string
  /mysql:\/\/[^:]+:[^@]+@[^\s]+/,                         // MySQL connection string
  /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/,             // MongoDB connection string
  /redis:\/\/[^:]+:[^@]+@[^\s]+/,                         // Redis connection string
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:]+:[^@]+@/,            // Any URI with embedded credentials

  // --- Communication ---
  /^xoxb-[0-9]+-[0-9A-Za-z]+/,                            // Slack bot token
  /^xoxp-[0-9]+-[0-9A-Za-z]+/,                            // Slack user token
  /^xapp-[0-9]+-[0-9A-Za-z]+/,                            // Slack app token
  /^SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}$/,          // SendGrid API key
  /^SK[a-f0-9]{32}$/,                                     // Twilio API key
  /[0-9]+:AA[a-zA-Z0-9_-]{33}/,                           // Telegram bot token

  // --- Package Registries ---
  /^npm_[a-zA-Z0-9]{36}$/,                                // npm token
  /^pypi-[a-zA-Z0-9_-]{100,}/,                            // PyPI token

  // --- Secret Management ---
  /^ops_eyJ[a-zA-Z0-9+/]{250,}={0,3}$/,                  // 1Password service token
  /^A3-[A-Z0-9]{6}-[A-Z0-9]{6,11}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/, // 1Password secret key

  // --- Crypto ---
  /^AGE-SECRET-KEY-1[A-Z0-9]{58}$/,                       // Age encryption key

  // --- SSH / Certificates ---
  /-----BEGIN\s+PRIVATE\s+KEY/,                            // PKCS8 generic
  /-----BEGIN\s+RSA\s+PRIVATE\s+KEY/,                      // RSA
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY/,                  // OpenSSH
  /-----BEGIN\s+EC\s+PRIVATE\s+KEY/,                       // EC
  /-----BEGIN\s+DSA\s+PRIVATE\s+KEY/,                      // DSA
  /-----BEGIN\s+ENCRYPTED\s+PRIVATE\s+KEY/,                // Encrypted PKCS8
  /-----BEGIN\s+CERTIFICATE/,                              // X.509 certificate

  // --- Auth headers ---
  /^Bearer\s+[a-zA-Z0-9._-]{20,}/i,                       // Bearer tokens
  /^Basic\s+[a-zA-Z0-9+/=]{20,}/i,                        // Basic auth

  // --- GitHub ---
  /^ghp_[a-zA-Z0-9]{36,}/,                                // GitHub PAT
  /^gho_[a-zA-Z0-9]{36,}/,                                // GitHub OAuth
  /^ghs_[a-zA-Z0-9]{36,}/,                                // GitHub App installation
  /^ghr_[a-zA-Z0-9]{36,}/,                                // GitHub refresh token

  // --- Podwatch ---
  /^pw_[a-zA-Z0-9]{20,}/,                                 // Podwatch keys

  // --- Tavily ---
  /^tvly-[a-zA-Z0-9]{20,}/,                               // Tavily keys

  // --- Discord ---
  /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/, // Discord bot token

  // --- Resend ---
  /^re_[a-zA-Z0-9]{20,}/,                                 // Resend API key

  // --- PlanetScale ---
  /^pscale_(?:tkn|pw|oauth)_[a-zA-Z0-9_-]{20,}/,         // PlanetScale token/password

  // --- Fly.io ---
  /^fo1_[a-zA-Z0-9_-]{20,}/,                              // Fly.io token

  // --- Render ---
  /^rnd_[a-zA-Z0-9]{20,}/,                                // Render API key

  // --- Inngest ---
  /^signkey-[a-zA-Z0-9_-]{20,}/,                          // Inngest signing key

  // --- Pinecone ---
  /^pcsk_[a-zA-Z0-9_-]{20,}/,                             // Pinecone API key
];

// ---------------------------------------------------------------------------
// Shannon entropy for high-entropy catch-all
// ---------------------------------------------------------------------------

/**
 * Calculate Shannon entropy of a string.
 * Higher values indicate more randomness (potential secrets).
 */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  const len = s.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Heuristic: does this string look like a random token/secret?
 * - No spaces
 * - Primarily alphanumeric + limited special chars (-_=+/.)
 * - Not a common word or path-like string
 */
const TOKEN_CHARS_RE = /^[a-zA-Z0-9_+/=.-]+$/;
const COMMON_WORD_RE = /^[a-z]+$/i; // pure alpha could be a word
const PATH_LIKE_RE = /^(\/[a-zA-Z0-9._-]+)+\/?$/; // e.g. /usr/bin/node
const HEX_LIKE_RE = /^(0x)?[0-9a-fA-F]+$/; // plain hex number
const URL_LIKE_NO_CREDS = /^https?:\/\/[^@]+$/; // URL without embedded creds

function looksLikeToken(s: string): boolean {
  // Must match token character set (no spaces, no weird chars)
  if (!TOKEN_CHARS_RE.test(s)) return false;
  // Skip pure alphabetic (could be a word/identifier)
  if (COMMON_WORD_RE.test(s) && s.length < 40) return false;
  // Skip path-like strings
  if (PATH_LIKE_RE.test(s)) return false;
  // Skip plain hex numbers (hashes, IDs)
  if (HEX_LIKE_RE.test(s) && s.length < 40) return false;
  // Skip normal URLs without credentials
  if (URL_LIKE_NO_CREDS.test(s)) return false;
  return true;
}

const ENTROPY_MIN_LENGTH = 20;

/**
 * Length-based entropy thresholds.
 * Short high-entropy strings (20-32 chars) are often UUIDs/hashes, not secrets.
 * Longer strings need less entropy to be suspicious.
 */
function getEntropyThreshold(length: number): number {
  if (length <= 32) return 4.8;   // Short: stricter (avoid UUID false positives)
  if (length <= 64) return 4.5;   // Medium: standard
  return 4.2;                      // Long: slightly relaxed (long random tokens)
}

function isHighEntropySecret(s: string): boolean {
  if (s.length < ENTROPY_MIN_LENGTH) return false;
  if (!looksLikeToken(s)) return false;
  return shannonEntropy(s) >= getEntropyThreshold(s.length);
}

// ---------------------------------------------------------------------------
// Inline-safe patterns (derived from SENSITIVE_VALUE_PATTERNS)
// ---------------------------------------------------------------------------

/**
 * Build regex variants suitable for inline (substring) replacement.
 * - Strip `^` / `$` anchors so patterns can match mid-string.
 * - PEM header patterns are replaced by a single block-level pattern that
 *   captures from `-----BEGIN …` through `-----END …-----` (or end-of-string).
 * - The `g` flag is added so `.matchAll()` can find all occurrences.
 */
function buildInlinePatterns(): RegExp[] {
  const out: RegExp[] = [];

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    // Skip individual PEM header patterns — replaced by unified block pattern below
    if (pattern.source.includes('BEGIN')) continue;

    let source = pattern.source;
    if (source.startsWith('^')) source = source.slice(1);
    if (source.endsWith('$')) source = source.slice(0, -1);

    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    out.push(new RegExp(source, flags));
  }

  // Unified PEM block pattern: matches from -----BEGIN ... through -----END ...-----
  // or through end-of-string when no END marker exists.
  out.push(
    /-----BEGIN\s+(?:(?:RSA|OPENSSH|EC|DSA|ENCRYPTED)\s+)?(?:PRIVATE\s+KEY|CERTIFICATE)[\s\S]*?(?:-----END[^\n]*-----|$)/g,
  );

  return out;
}

const INLINE_PATTERNS: RegExp[] = buildInlinePatterns();

/**
 * Characters that are typically part of a secret token or credential string.
 * Anything NOT matching this is treated as a word boundary for match extension.
 */
const INLINE_TOKEN_CHAR_RE = /[a-zA-Z0-9_\-.+\/=:@]/;

// ---------------------------------------------------------------------------
// Inline redaction
// ---------------------------------------------------------------------------

/**
 * Replace sensitive patterns *inline* within a string value.
 *
 * Strategy:
 * 1. Collect all regex match ranges across every INLINE_PATTERN.
 * 2. Extend each range bidirectionally to the nearest "token boundary"
 *    (whitespace, quotes, brackets, etc.) so partial regex matches still
 *    cover the full secret token.
 * 3. Merge overlapping/adjacent ranges.
 * 4. Replace each merged range with [REDACTED].
 *
 * Returns the (possibly modified) string and how many distinct secrets were
 * redacted. Does NOT check Shannon entropy — callers should use
 * `isHighEntropySecret()` as a fallback when `count === 0`.
 */
function inlineRedactSensitiveValues(s: string): { value: string; count: number } {
  // 1. Collect all match ranges
  const ranges: Array<{ start: number; end: number }> = [];

  for (const pattern of INLINE_PATTERNS) {
    for (const match of s.matchAll(pattern)) {
      let start = match.index!;
      let end = start + match[0].length;

      // Extend backward to token boundary
      while (start > 0 && INLINE_TOKEN_CHAR_RE.test(s[start - 1])) {
        start--;
      }
      // Extend forward to token boundary
      while (end < s.length && INLINE_TOKEN_CHAR_RE.test(s[end])) {
        end++;
      }

      ranges.push({ start, end });
    }
  }

  if (ranges.length === 0) return { value: s, count: 0 };

  // 2. Sort by start position, then by longest range first
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  // 3. Merge overlapping / adjacent ranges
  const merged: Array<{ start: number; end: number }> = [{ ...ranges[0] }];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i].start <= last.end) {
      last.end = Math.max(last.end, ranges[i].end);
    } else {
      merged.push({ ...ranges[i] });
    }
  }

  // 4. Build result string
  let result = '';
  let pos = 0;
  for (const { start, end } of merged) {
    result += s.slice(pos, start) + REDACTED;
    pos = end;
  }
  result += s.slice(pos);

  return { value: result, count: merged.length };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VALUE_LENGTH = 500;
const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Redaction result type
// ---------------------------------------------------------------------------

export interface RedactResult {
  result: Record<string, unknown>;
  redactedCount: number;
}

// ---------------------------------------------------------------------------
// Redaction audit mode (opt-in via PODWATCH_REDACTION_AUDIT env var)
// ---------------------------------------------------------------------------

const REDACTION_AUDIT = !!process.env.PODWATCH_REDACTION_AUDIT;

/**
 * Log fields that were NOT redacted so we can spot gaps.
 * Shows field name + first 4 chars + entropy score without exposing actual values.
 */
function auditUnredactedFields(obj: Record<string, unknown>, prefix = ''): void {
  if (!REDACTION_AUDIT) return;

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      if (value !== REDACTED && !value.startsWith('[truncated]')) {
        const preview = value.slice(0, 4);
        const entropy = shannonEntropy(value).toFixed(2);
        console.log(`[podwatch:audit] PASS field="${fieldPath}" preview="${preview}…" len=${value.length} entropy=${entropy}`);
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      auditUnredactedFields(value as Record<string, unknown>, fieldPath);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string' && item !== REDACTED) {
          const preview = item.slice(0, 4);
          const entropy = shannonEntropy(item).toFixed(2);
          console.log(`[podwatch:audit] PASS field="${fieldPath}[${i}]" preview="${preview}…" len=${item.length} entropy=${entropy}`);
        } else if (item !== null && typeof item === 'object') {
          auditUnredactedFields(item as Record<string, unknown>, `${fieldPath}[${i}]`);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from tool call params.
 * Returns the scrubbed object and a count of how many values were redacted.
 */
export function redactParams(params: Record<string, unknown>): RedactResult {
  const counter = { count: 0 };
  const result = redactObject(params, 0, counter);
  auditUnredactedFields(result);
  return { result, redactedCount: counter.count };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isSensitiveValue(value: string): boolean {
  if (SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))) return true;
  if (isHighEntropySecret(value)) return true;
  return false;
}

function redactObject(
  obj: Record<string, unknown>,
  depth: number,
  counter: { count: number },
): Record<string, unknown> {
  if (depth > 5) return { "[truncated]": "nested too deep" };

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase().replace(/[-_]/g, "");

    // Key-based redaction
    if (SENSITIVE_KEYS.has(key.toLowerCase()) || SENSITIVE_KEYS.has(keyLower)) {
      result[key] = REDACTED;
      counter.count++;
      continue;
    }

    // Value-based redaction + truncation (inline — only matched portions replaced)
    if (typeof value === "string") {
      const { value: redacted, count: inlineCount } = inlineRedactSensitiveValues(value);
      if (inlineCount > 0) {
        counter.count += inlineCount;
        result[key] = redacted.length > MAX_VALUE_LENGTH
          ? redacted.slice(0, MAX_VALUE_LENGTH) + `… [${redacted.length} chars]`
          : redacted;
      } else if (isHighEntropySecret(value)) {
        // Fallback: entire value looks like a random token
        result[key] = REDACTED;
        counter.count++;
      } else if (value.length > MAX_VALUE_LENGTH) {
        result[key] = value.slice(0, MAX_VALUE_LENGTH) + `… [${value.length} chars]`;
      } else {
        result[key] = value;
      }
      continue;
    }

    // Recurse into nested objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>, depth + 1, counter);
      continue;
    }

    // Arrays — inline-redact string elements, recurse into objects
    if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === "string") {
          const { value: redacted, count: inlineCount } = inlineRedactSensitiveValues(item);
          if (inlineCount > 0) {
            counter.count += inlineCount;
            return redacted.length > MAX_VALUE_LENGTH
              ? redacted.slice(0, MAX_VALUE_LENGTH) + `… [${redacted.length} chars]`
              : redacted;
          }
          if (isHighEntropySecret(item)) {
            counter.count++;
            return REDACTED;
          }
          if (item.length > MAX_VALUE_LENGTH) {
            return item.slice(0, MAX_VALUE_LENGTH) + `… [${item.length} chars]`;
          }
          return item;
        }
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          return redactObject(item as Record<string, unknown>, depth + 1, counter);
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

// Export internals for testing
export { shannonEntropy, looksLikeToken, isHighEntropySecret, getEntropyThreshold, inlineRedactSensitiveValues, SENSITIVE_VALUE_PATTERNS, SENSITIVE_KEYS };
