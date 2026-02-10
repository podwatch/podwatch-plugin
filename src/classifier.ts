/**
 * Tool classifier — lightweight client-side classification for real-time
 * security decisions (exfiltration detection, persistence attempts).
 *
 * NOTE: Full risk-level classification remains server-side
 * (podwatch-app/src/lib/risk-classifier.ts). This classifier only provides
 * boolean flags needed for the before_tool_call hook to make blocking/alerting
 * decisions in real time.
 */

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export interface ToolClassification {
  /** Tool reads credential-like files (.env, .key, .pem, ssh keys). */
  accessesCredentials: boolean;
  /** Tool makes outbound network calls (web_fetch, curl, wget, http_request). */
  makesNetworkCall: boolean;
  /** Tool attempts to set up persistence (crontab, systemd, autostart). */
  persistenceAttempt: boolean;
}

// ---------------------------------------------------------------------------
// Credential file patterns
// ---------------------------------------------------------------------------

const CREDENTIAL_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\.[a-z]+$/i, // .env.local, .env.production, etc.
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /\.ssh\//i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /id_dsa/i,
  /authorized_keys/i,
  /known_hosts/i,
  /\.gnupg\//i,
  /\.aws\/credentials/i,
  /\.netrc/i,
];

// ---------------------------------------------------------------------------
// Network tools
// ---------------------------------------------------------------------------

const NETWORK_TOOLS = new Set([
  "web_fetch",
  "curl",
  "wget",
  "http_request",
  "fetch",
  "httpie",
]);

// ---------------------------------------------------------------------------
// Persistence keywords (for bash/exec/spawn commands)
// ---------------------------------------------------------------------------

const PERSISTENCE_KEYWORDS = [
  "crontab",
  "systemd",
  "systemctl",
  "autostart",
  "launchctl",
  "launchd",
  "at ",          // `at` scheduler
  "rc.local",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  "init.d",
  "cron.d",
];

const EXEC_TOOLS = new Set(["bash", "exec", "spawn", "shell", "run"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a tool call for real-time security decisions.
 */
export function classifyTool(
  toolName: string,
  params: Record<string, unknown>
): ToolClassification {
  const name = toolName.toLowerCase();

  return {
    accessesCredentials: checkAccessesCredentials(name, params),
    makesNetworkCall: checkMakesNetworkCall(name, params),
    persistenceAttempt: checkPersistenceAttempt(name, params),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract command string from exec-like tool params. */
function extractCommand(params: Record<string, unknown>): string {
  return (
    (typeof params.command === "string" && params.command) ||
    (typeof params.cmd === "string" && params.cmd) ||
    (typeof params.script === "string" && params.script) ||
    ""
  );
}

// ---------------------------------------------------------------------------
// Internal checks
// ---------------------------------------------------------------------------

function checkAccessesCredentials(
  toolName: string,
  params: Record<string, unknown>
): boolean {
  // Direct file-reading tools: check path params
  if (toolName === "read" || toolName === "read_file" || toolName === "cat") {
    const filePath =
      (typeof params.path === "string" && params.path) ||
      (typeof params.file_path === "string" && params.file_path) ||
      (typeof params.file === "string" && params.file) ||
      "";

    if (!filePath) return false;
    return CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
  }

  // Exec-like tools: parse command for credential file paths
  // Check each token/word individually since patterns use anchors (e.g. \.env$)
  if (EXEC_TOOLS.has(toolName)) {
    const command = extractCommand(params);
    if (!command) return false;
    // Split on whitespace; also strip common prefixes like @ (curl's file ref)
    const tokens = command.split(/\s+/).map((t) => t.replace(/^[@<>]+/, ""));
    return tokens.some((token) =>
      CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(token))
    );
  }

  return false;
}

// Network tool names that may appear as commands inside exec
const EXEC_NETWORK_COMMANDS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "rsync",
  "fetch",
  "http",    // httpie
  "httpie",
];

function checkMakesNetworkCall(
  toolName: string,
  params: Record<string, unknown>
): boolean {
  // Direct network tools
  if (NETWORK_TOOLS.has(toolName)) return true;

  // Exec-like tools: parse command for network tool invocations
  if (EXEC_TOOLS.has(toolName)) {
    const command = extractCommand(params);
    if (!command) return false;
    const lower = command.toLowerCase();
    return EXEC_NETWORK_COMMANDS.some((cmd) => {
      // Match as a standalone word (start of command, after pipe, after &&, etc.)
      const re = new RegExp(`(?:^|[|;&\\s])${cmd}(?:\\s|$)`);
      return re.test(lower);
    });
  }

  return false;
}

function checkPersistenceAttempt(
  toolName: string,
  params: Record<string, unknown>
): boolean {
  if (!EXEC_TOOLS.has(toolName)) return false;

  const command = extractCommand(params);
  if (!command) return false;

  const lower = command.toLowerCase();
  return PERSISTENCE_KEYWORDS.some((kw) => lower.includes(kw));
}
