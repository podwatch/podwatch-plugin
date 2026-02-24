import { describe, it, expect } from "vitest";
import {
  redactParams,
  shannonEntropy,
  looksLikeToken,
  isHighEntropySecret,
  inlineRedactSensitiveValues,
} from "./redact.js";

// Helper: assert a value is redacted when passed as a top-level param value
function expectRedacted(value: string, description?: string) {
  const { result, redactedCount } = redactParams({ field: value });
  expect(result.field, description ?? `Expected "${value.slice(0, 40)}…" to be redacted`).toBe("[REDACTED]");
  expect(redactedCount).toBeGreaterThanOrEqual(1);
}

// Helper: assert a value is NOT redacted
function expectNotRedacted(value: string, description?: string) {
  const { result } = redactParams({ field: value });
  expect(result.field, description ?? `Expected "${value.slice(0, 40)}…" to NOT be redacted`).not.toBe("[REDACTED]");
}

// =========================================================================
// Key-based redaction
// =========================================================================
describe("key-based redaction", () => {
  const sensitiveKeys = [
    // Original
    "password", "secret", "token", "apiKey", "api_key", "authorization",
    "credentials", "private_key", "privateKey", "access_token", "accessToken",
    "refresh_token", "refreshToken", "client_secret", "clientSecret", "bearer",
    "cookie", "session_id", "sessionId", "passphrase",
    // New — encryption / signing
    "encryption_key", "encryptionKey", "signing_key", "signingKey",
    "master_key", "masterKey",
    // New — database
    "database_url", "databaseUrl", "db_url", "dbUrl", "db_password", "dbPassword",
    "connection_string", "connectionString",
    // New — communication / SMTP
    "smtp_password", "smtpPassword", "webhook_secret", "webhookSecret",
    // New — JWT / App
    "jwt_secret", "jwtSecret", "app_secret", "appSecret",
    // New — crypto primitives
    "hmac", "nonce", "salt",
  ];

  for (const key of sensitiveKeys) {
    it(`redacts key: ${key}`, () => {
      const { result, redactedCount } = redactParams({ [key]: "some-value-here" });
      expect(result[key]).toBe("[REDACTED]");
      expect(redactedCount).toBe(1);
    });
  }

  it("is case-insensitive for keys", () => {
    const { result, redactedCount } = redactParams({ PASSWORD: "x", Api_Key: "y" });
    expect(result.PASSWORD).toBe("[REDACTED]");
    expect(result.Api_Key).toBe("[REDACTED]");
    expect(redactedCount).toBe(2);
  });

  it("normalizes hyphens/underscores in keys", () => {
    const { result } = redactParams({ "access-token": "x", "private--key": "x" });
    expect(result["access-token"]).toBe("[REDACTED]");
    expect(result["private--key"]).toBe("[REDACTED]");
  });
});

// =========================================================================
// Value-based redaction — AI/LLM Providers
// =========================================================================
describe("value-based: AI/LLM providers", () => {
  it("redacts OpenAI API key", () => {
    expectRedacted("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890abcdefgh");
  });

  it("redacts Anthropic API key (api03)", () => {
    expectRedacted("sk-ant-api03-" + "a".repeat(93) + "AA");
  });

  it("redacts Anthropic admin key (admin01)", () => {
    expectRedacted("sk-ant-admin01-" + "b".repeat(93) + "AA");
  });

  it("redacts Google/GCP API key", () => {
    expectRedacted("AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe");
  });

  it("redacts Google OAuth client secret", () => {
    expectRedacted("GOCSPX-abcDefGhi123-jklMno456");
  });

  it("redacts Cohere API key", () => {
    expectRedacted("co-" + "a".repeat(40));
  });

  it("redacts Replicate API key", () => {
    expectRedacted("r8_" + "b".repeat(40));
  });

  it("redacts HuggingFace token", () => {
    expectRedacted("hf_" + "c".repeat(34));
  });
});

// =========================================================================
// Value-based redaction — Auth/Identity Providers
// =========================================================================
describe("value-based: Auth/Identity providers", () => {
  it("redacts Clerk/Stripe live secret key", () => {
    expectRedacted("sk_live_abc123def456ghi789");
  });

  it("redacts Clerk/Stripe live public key", () => {
    expectRedacted("pk_live_abc123def456ghi789");
  });

  it("redacts Clerk/Stripe test secret key", () => {
    expectRedacted("sk_test_abc123def456ghi789");
  });

  it("redacts Clerk/Stripe test public key", () => {
    expectRedacted("pk_test_abc123def456ghi789");
  });

  it("redacts Supabase project token", () => {
    expectRedacted("sbp_abcdef123456789");
  });

  it("redacts JWT token", () => {
    expectRedacted("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
  });

  it("redacts Supabase service role JWT", () => {
    expectRedacted("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlc3QiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNjQwOTk1MjAwLCJleHAiOjE5NTY1NzEyMDB9.test_signature_here_abcdef123456");
  });
});

// =========================================================================
// Value-based redaction — Cloud/Infrastructure
// =========================================================================
describe("value-based: Cloud/Infrastructure", () => {
  it("redacts AWS permanent access key (AKIA)", () => {
    expectRedacted("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts AWS temporary access key (ASIA)", () => {
    expectRedacted("ASIAIOSFODNN7EXAMPLE");
  });

  it("redacts AWS STS billing key (ABIA)", () => {
    expectRedacted("ABIAIOSFODNN7EXAMPLE");
  });

  it("redacts Vercel token", () => {
    expectRedacted("vercel_abc123def456");
  });

  it("redacts Hashicorp Vault token", () => {
    expectRedacted("hvs.CAESIJDKFB3jD8dA3lkjafld-ajkfl3");
  });

  it("redacts Doppler service token", () => {
    expectRedacted("dp.st.dev_abcDEF123-ghiJKL456");
  });

  it("redacts Terraform Cloud token", () => {
    expectRedacted("abcdefghijklmn.atlasv1." + "x".repeat(64));
  });
});

// =========================================================================
// Value-based redaction — Database/Connection Strings
// =========================================================================
describe("value-based: Database/Connection strings", () => {
  it("redacts Postgres connection string", () => {
    expectRedacted("postgres://user:password123@ep-cool-neon-123.us-east-2.aws.neon.tech/neondb");
  });

  it("redacts PostgreSQL connection string (ql suffix)", () => {
    expectRedacted("postgresql://admin:s3cret@db.example.com:5432/mydb?sslmode=require");
  });

  it("redacts MySQL connection string", () => {
    expectRedacted("mysql://root:password@localhost:3306/mydb");
  });

  it("redacts MongoDB connection string", () => {
    expectRedacted("mongodb://user:pass@cluster0.example.mongodb.net/db");
  });

  it("redacts MongoDB+SRV connection string", () => {
    expectRedacted("mongodb+srv://user:pass@cluster0.mongodb.net/db?retryWrites=true");
  });

  it("redacts Redis connection string", () => {
    expectRedacted("redis://default:secretpass@redis-12345.c1.us-east-1.ec2.cloud.redislabs.com:12345");
  });

  it("redacts generic URI with credentials", () => {
    expectRedacted("amqp://user:pass@broker.example.com:5672/vhost");
  });

  it("does NOT redact URL without credentials", () => {
    expectNotRedacted("https://example.com/api/v1");
  });

  it("does NOT redact URL with @ in path but no password", () => {
    // This is tricky — our regex looks for ://user:pass@ which requires the colon
    expectNotRedacted("https://example.com/@user/repo");
  });
});

// =========================================================================
// Value-based redaction — Communication
// =========================================================================
describe("value-based: Communication", () => {
  it("redacts Slack bot token", () => {
    expectRedacted("xoxb-123456789012-1234567890123-abcdefGHIJKLmnopQRSTuvwx");
  });

  it("redacts Slack user token", () => {
    expectRedacted("xoxp-123456789012-1234567890123-abcdefGHIJKLmnopQRSTuvwx");
  });

  it("redacts Slack app token", () => {
    expectRedacted("xapp-123456789012-1234567890123-abcdefGHIJKLmnopQRSTuvwx");
  });

  it("redacts SendGrid API key", () => {
    expectRedacted("SG.abcdefghijklmnopqrstuv.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
  });

  it("redacts Twilio API key", () => {
    expectRedacted("SK" + "a".repeat(32));
  });

  it("redacts Telegram bot token", () => {
    expectRedacted("123456789:AABBccDDeeFFggHHiiJJkkLLmmNNooP-QRs");
  });

  it("redacts Discord bot token", () => {
    expectRedacted("MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh12AB.abcdefghijklmnopqrstuvwxyz1234567");
  });
});

// =========================================================================
// Value-based redaction — Package Registries
// =========================================================================
describe("value-based: Package registries", () => {
  it("redacts npm token", () => {
    expectRedacted("npm_" + "a".repeat(36));
  });

  it("redacts PyPI token", () => {
    expectRedacted("pypi-" + "b".repeat(120));
  });
});

// =========================================================================
// Value-based redaction — Secret Management
// =========================================================================
describe("value-based: Secret management", () => {
  it("redacts 1Password service token", () => {
    expectRedacted("ops_eyJ" + "a".repeat(260));
  });

  it("redacts 1Password secret key", () => {
    expectRedacted("A3-BCDEFG-HIJKLMNOPQ-RSTUV-WXYZ1-23456");
  });
});

// =========================================================================
// Value-based redaction — Crypto
// =========================================================================
describe("value-based: Crypto", () => {
  it("redacts Age encryption key", () => {
    expectRedacted("AGE-SECRET-KEY-1" + "A".repeat(58));
  });
});

// =========================================================================
// Value-based redaction — SSH/Certificates
// =========================================================================
describe("value-based: SSH/Certificates", () => {
  it("redacts RSA private key", () => {
    expectRedacted("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...");
  });

  it("redacts OpenSSH private key", () => {
    expectRedacted("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk...");
  });

  it("redacts EC private key", () => {
    expectRedacted("-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIBfN...");
  });

  it("redacts DSA private key", () => {
    expectRedacted("-----BEGIN DSA PRIVATE KEY-----\nMIIBuwIBAAKBgQ...");
  });

  it("redacts PKCS8 generic private key", () => {
    expectRedacted("-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...");
  });

  it("redacts encrypted private key", () => {
    expectRedacted("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgk...");
  });

  it("redacts X.509 certificate", () => {
    expectRedacted("-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJ...");
  });
});

// =========================================================================
// Value-based redaction — Auth headers
// =========================================================================
describe("value-based: Auth headers", () => {
  it("redacts Bearer token", () => {
    expectRedacted("Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test");
  });

  it("redacts Basic auth", () => {
    expectRedacted("Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4OTA=");
  });
});

// =========================================================================
// Value-based redaction — GitHub
// =========================================================================
describe("value-based: GitHub", () => {
  it("redacts GitHub PAT (ghp)", () => {
    expectRedacted("ghp_" + "a".repeat(36));
  });

  it("redacts GitHub OAuth (gho)", () => {
    expectRedacted("gho_" + "b".repeat(36));
  });

  it("redacts GitHub App installation token (ghs)", () => {
    expectRedacted("ghs_" + "c".repeat(36));
  });

  it("redacts GitHub refresh token (ghr)", () => {
    expectRedacted("ghr_" + "d".repeat(36));
  });
});

// =========================================================================
// Value-based redaction — Podwatch & Tavily
// =========================================================================
describe("value-based: Podwatch & Tavily", () => {
  it("redacts Podwatch key", () => {
    expectRedacted("pw_" + "a".repeat(24));
  });

  it("redacts Tavily key", () => {
    expectRedacted("tvly-" + "b".repeat(24));
  });
});

// =========================================================================
// Shannon entropy / high-entropy catch-all
// =========================================================================
describe("Shannon entropy", () => {
  it("calculates entropy correctly for uniform distribution", () => {
    // 256 unique chars = log2(256) = 8 bits max, but for short strings...
    // "abcd" = 4 unique chars, each p=0.25, entropy = 4 * -(0.25 * log2(0.25)) = 2
    expect(shannonEntropy("abcd")).toBeCloseTo(2.0, 1);
  });

  it("calculates zero entropy for single char", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
  });

  it("calculates high entropy for random-looking string", () => {
    const randomStr = "aB3$kL9mN2xQ7pR4wT6yU1vZ8cJ5hG0";
    expect(shannonEntropy(randomStr)).toBeGreaterThan(4.0);
  });
});

describe("looksLikeToken", () => {
  it("returns true for token-like string", () => {
    expect(looksLikeToken("abc123DEF456ghi789JKL0mn")).toBe(true);
  });

  it("returns false for string with spaces", () => {
    expect(looksLikeToken("hello world foo bar")).toBe(false);
  });

  it("returns false for short pure alphabetic string (likely a word)", () => {
    expect(looksLikeToken("development")).toBe(false);
  });

  it("returns false for file paths", () => {
    expect(looksLikeToken("/usr/local/bin/node")).toBe(false);
  });

  it("returns false for plain hex under 40 chars", () => {
    expect(looksLikeToken("abc123def456")).toBe(false);
  });

  it("returns false for normal URL", () => {
    expect(looksLikeToken("https://example.com/api/v1")).toBe(false);
  });

  it("returns true for long mixed alphanumeric", () => {
    expect(looksLikeToken("aB3kL9mN2xQ7pR4wT6yU1vZ8c")).toBe(true);
  });
});

describe("isHighEntropySecret", () => {
  it("detects high-entropy random token", () => {
    // Use a longer token (>32 chars) to hit the standard 4.5 threshold
    expect(isHighEntropySecret("aB3kL9mN2xQ7pR4wT6yU1vZ8jH5cF0gD")).toBe(true);
    // Short high-entropy strings (≤32 chars) require higher entropy (4.8) to avoid UUID false positives
    expect(isHighEntropySecret("aB3kL9mN2xQ7pR4wT6yU1vZ")).toBe(false);
  });

  it("does NOT flag short strings", () => {
    expect(isHighEntropySecret("abc123")).toBe(false);
  });

  it("does NOT flag low-entropy repetitive strings", () => {
    expect(isHighEntropySecret("aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("does NOT flag normal english-like text", () => {
    // Even if long, pure alpha with common patterns shouldn't trigger
    expect(isHighEntropySecret("development")).toBe(false);
  });

  it("does NOT flag normal URLs", () => {
    expect(isHighEntropySecret("https://example.com/api/v1/users")).toBe(false);
  });
});

describe("high-entropy catch-all integration", () => {
  it("redacts unknown token format via entropy", () => {
    // A novel secret format not matched by any regex
    const novelToken = "xK9mQ3pR7wT2nB5vZ8cJ4hG0fL6aE1dY";
    expectRedacted(novelToken);
  });

  it("does NOT redact normal text", () => {
    expectNotRedacted("Hello world, this is a normal message");
  });

  it("does NOT redact code snippets", () => {
    expectNotRedacted("const result = await fetch(url)");
  });

  it("does NOT redact short values", () => {
    expectNotRedacted("abc123");
  });

  it("does NOT redact simple identifiers", () => {
    expectNotRedacted("my-component-name");
  });
});

// =========================================================================
// Structural / behavioral tests
// =========================================================================
describe("structural behavior", () => {
  it("handles nested objects", () => {
    const { result, redactedCount } = redactParams({
      config: {
        db: {
          password: "super-secret",
          host: "localhost",
        },
      },
    });
    expect((result.config as any).db.password).toBe("[REDACTED]");
    expect((result.config as any).db.host).toBe("localhost");
    expect(redactedCount).toBe(1);
  });

  it("handles arrays with sensitive strings", () => {
    const { result, redactedCount } = redactParams({
      tokens: ["ghp_" + "a".repeat(36), "normal-value", "sk_live_abc123"],
    });
    const arr = result.tokens as string[];
    expect(arr[0]).toBe("[REDACTED]");
    expect(arr[1]).toBe("normal-value");
    expect(arr[2]).toBe("[REDACTED]");
    expect(redactedCount).toBe(2);
  });

  it("truncates long non-sensitive strings", () => {
    const longStr = "x".repeat(600);
    const { result } = redactParams({ data: longStr });
    expect((result.data as string).length).toBeLessThan(600);
    expect((result.data as string)).toContain("… [600 chars]");
  });

  it("handles deeply nested objects with truncation", () => {
    // redactObject starts at depth=0, truncates when depth > 5
    // So we need 7 levels of nesting: depths 0,1,2,3,4,5 are processed,
    // depth 6 triggers truncation
    let obj: any = { value: "safe" };
    for (let i = 0; i < 10; i++) {
      obj = { nested: obj };
    }
    const { result } = redactParams(obj);
    // Navigate 6 levels deep (depths 0-5 processed, depth 6 = truncated)
    let current: any = result;
    for (let i = 0; i < 6; i++) {
      current = current.nested;
    }
    expect(current["[truncated]"]).toBe("nested too deep");
  });

  it("returns accurate redactedCount for multiple redactions", () => {
    const { redactedCount } = redactParams({
      password: "x",
      api_key: "y",
      normal: "z",
      token: "w",
      safe_field: "hello",
    });
    expect(redactedCount).toBe(3); // password, api_key, token
  });

  it("returns 0 redactedCount when nothing is redacted", () => {
    const { redactedCount } = redactParams({
      name: "test",
      count: 42,
      active: true,
    });
    expect(redactedCount).toBe(0);
  });

  it("counts value-based and key-based redactions together", () => {
    const { redactedCount } = redactParams({
      password: "x",                              // key-based
      url: "postgres://u:p@host/db",              // value-based
      safe: "hello",
    });
    expect(redactedCount).toBe(2);
  });

  it("passes through numbers and booleans unchanged", () => {
    const { result } = redactParams({ count: 42, active: true, ratio: 3.14 });
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.ratio).toBe(3.14);
  });

  it("passes through null values", () => {
    const { result } = redactParams({ field: null as any });
    expect(result.field).toBeNull();
  });

  it("handles objects inside arrays", () => {
    const { result, redactedCount } = redactParams({
      items: [
        { name: "safe", password: "secret123" },
        { name: "also-safe", key: "normal" },
      ],
    });
    const items = result.items as any[];
    expect(items[0].password).toBe("[REDACTED]");
    expect(items[0].name).toBe("safe");
    expect(items[1].name).toBe("also-safe");
    expect(redactedCount).toBe(1);
  });
});

// =========================================================================
// Inline redaction (the primary fix — only matched portions are replaced)
// =========================================================================
describe("inline redaction", () => {
  it("redacts only the API key portion of a curl command", () => {
    const { result, redactedCount } = redactParams({
      command: 'curl -H "Authorization: Bearer sk_live_abc123def456" https://api.example.com',
    });
    expect(result.command).toBe(
      'curl -H "Authorization: [REDACTED]" https://api.example.com',
    );
    expect(redactedCount).toBe(1);
  });

  it("redacts multiple secrets inline in a single string", () => {
    const { result, redactedCount } = redactParams({
      command: 'curl -H "sk_live_abc123def456" -H "ghp_' + "x".repeat(36) + '" https://api.example.com',
    });
    const s = result.command as string;
    expect(s).toContain("[REDACTED]");
    expect(s).toContain("curl");
    expect(s).toContain("https://api.example.com");
    expect(s).not.toContain("sk_live_");
    expect(s).not.toContain("ghp_");
    expect(redactedCount).toBe(2);
  });

  it("pure secret value (no surrounding text) is still fully redacted", () => {
    const { result } = redactParams({ field: "sk_live_abc123def456" });
    expect(result.field).toBe("[REDACTED]");
  });

  it("high-entropy string with no pattern match is still fully redacted", () => {
    const novelToken = "xK9mQ3pR7wT2nB5vZ8cJ4hG0fL6aE1dY";
    const { result } = redactParams({ field: novelToken });
    expect(result.field).toBe("[REDACTED]");
  });

  it("normal command with no secrets passes through unchanged", () => {
    const cmd = "ls -la /home/user/projects";
    const { result, redactedCount } = redactParams({ command: cmd });
    expect(result.command).toBe(cmd);
    expect(redactedCount).toBe(0);
  });

  it("redacts embedded GitHub PAT in git clone command", () => {
    const ghpToken = "ghp_" + "A".repeat(36);
    const { result } = redactParams({
      command: `git clone https://${ghpToken}@github.com/user/repo.git`,
    });
    const s = result.command as string;
    expect(s).not.toContain("ghp_");
    expect(s).toContain("[REDACTED]");
    // The URL structure around the secret is preserved
    expect(s).toContain("git clone");
  });

  it("redacts embedded Postgres connection string in env export", () => {
    const { result } = redactParams({
      command: 'export DATABASE_URL="postgres://admin:s3cret@db.example.com:5432/mydb"',
    });
    const s = result.command as string;
    expect(s).toContain("export");
    expect(s).toContain("[REDACTED]");
    expect(s).not.toContain("s3cret");
  });

  it("redacts inline secrets in array elements", () => {
    const { result, redactedCount } = redactParams({
      args: [
        'curl -H "Authorization: Bearer sk_live_abc123def456" https://api.example.com',
        "normal-arg",
        "ghp_" + "b".repeat(36),
      ],
    });
    const arr = result.args as string[];
    // First element: inline redaction preserves curl command structure
    expect(arr[0]).toContain("curl");
    expect(arr[0]).toContain("[REDACTED]");
    expect(arr[0]).not.toContain("sk_live_");
    // Second element: untouched
    expect(arr[1]).toBe("normal-arg");
    // Third element: fully redacted (pure secret)
    expect(arr[2]).toBe("[REDACTED]");
    expect(redactedCount).toBe(2);
  });

  it("key-based redaction still replaces the entire value", () => {
    const { result } = redactParams({
      password: "this-is-not-a-pattern-match-but-key-is-sensitive",
    });
    expect(result.password).toBe("[REDACTED]");
  });

  it("redacts JWT embedded in a longer command string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const { result } = redactParams({
      command: `curl -H "Authorization: Bearer ${jwt}" https://api.example.com/data`,
    });
    const s = result.command as string;
    expect(s).toContain("curl");
    expect(s).toContain("https://api.example.com/data");
    expect(s).not.toContain("eyJhbGci");
    expect(s).toContain("[REDACTED]");
  });

  it("redacts PEM private key embedded in a command", () => {
    const { result } = redactParams({
      command: 'echo "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----" > key.pem',
    });
    const s = result.command as string;
    expect(s).toContain("echo");
    expect(s).toContain("[REDACTED]");
    expect(s).not.toContain("MIIEpAIBAAKCAQEA");
  });
});

describe("inlineRedactSensitiveValues (unit)", () => {
  it("returns count=0 and unchanged string when no secrets present", () => {
    const { value, count } = inlineRedactSensitiveValues("hello world");
    expect(value).toBe("hello world");
    expect(count).toBe(0);
  });

  it("returns count=1 for a single inline secret", () => {
    const { value, count } = inlineRedactSensitiveValues(
      'curl -H "sk_live_abc123def456" https://api.example.com',
    );
    expect(count).toBe(1);
    expect(value).toContain("[REDACTED]");
    expect(value).toContain("curl");
  });

  it("returns count=2 for two distinct secrets", () => {
    const ghp = "ghp_" + "a".repeat(36);
    const { value, count } = inlineRedactSensitiveValues(
      `first ${ghp} middle sk_live_abc123 end`,
    );
    expect(count).toBe(2);
    expect(value).toBe("first [REDACTED] middle [REDACTED] end");
  });

  it("does NOT check entropy (that is the caller's job)", () => {
    // A high-entropy string that no pattern matches
    const token = "xK9mQ3pR7wT2nB5vZ8cJ4hG0fL6aE1dY";
    const { value, count } = inlineRedactSensitiveValues(token);
    // inlineRedactSensitiveValues should NOT redact it (no pattern match)
    expect(count).toBe(0);
    expect(value).toBe(token);
  });
});

// =========================================================================
// False-positive checks
// =========================================================================
describe("false-positive safety", () => {
  it("does NOT redact normal file paths", () => {
    expectNotRedacted("/home/user/.config/app/settings.json");
  });

  it("does NOT redact normal environment variable names", () => {
    expectNotRedacted("NODE_ENV");
    expectNotRedacted("HOME");
    expectNotRedacted("PATH");
  });

  it("does NOT redact normal module names", () => {
    expectNotRedacted("@types/node");
    expectNotRedacted("express");
  });

  it("does NOT redact SHA hashes (hex < 40 chars)", () => {
    expectNotRedacted("abc123def456");
  });

  it("does NOT redact normal CSS/class names", () => {
    expectNotRedacted("bg-gray-100");
    expectNotRedacted("text-xl");
  });

  it("does NOT redact normal JSON", () => {
    expectNotRedacted('{"key": "value", "count": 42}');
  });

  it("does NOT redact normal code", () => {
    expectNotRedacted("function hello() { return 42; }");
  });

  it("does NOT redact HTTP URLs without credentials", () => {
    expectNotRedacted("https://api.example.com/v1/users?page=1");
  });

  it("does NOT redact simple numbers as strings", () => {
    expectNotRedacted("12345");
    expectNotRedacted("3.14159");
  });

  it("does NOT redact UUIDs", () => {
    // UUIDs are hex with dashes, most are under the entropy threshold
    expectNotRedacted("550e8400-e29b-41d4-a716-446655440000");
  });

  it("does NOT redact git commit hashes", () => {
    expectNotRedacted("abc123f");
    expectNotRedacted("a1b2c3d4e5f6");
  });

  it("does NOT redact normal 'safe' key names", () => {
    const { result } = redactParams({ name: "test", description: "hello", count: "5" });
    expect(result.name).toBe("test");
    expect(result.description).toBe("hello");
    expect(result.count).toBe("5");
  });
});
