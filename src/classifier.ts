/**
 * Security classifier — determines risk level and behavior flags for tool calls.
 *
 * Returns both a risk level AND behavioral flags:
 * - accessesCredentials: tool reads sensitive files (.env, .key, .pem, .ssh/*)
 * - makesNetworkCall: tool makes outbound network requests
 * - persistenceAttempt: tool modifies startup/cron/systemd configs
 */

import type { RiskLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export interface Classification {
  riskLevel: RiskLevel;
  reason: string;
  accessesCredentials: boolean;
  makesNetworkCall: boolean;
  persistenceAttempt: boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const CREDENTIAL_PATHS = [
  /\.ssh\//i,
  /\.gnupg\//i,
  /\.aws\/credentials/i,
  /\.env$/i,
  /\.env\./i,
  /\.env\.local/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
  /\.netrc/i,
  /\.npmrc/i,
  /credentials/i,
  /secrets?\.(ya?ml|json|toml)/i,
  /\.kube\/config/i,
  /\.docker\/config\.json/i,
  /token/i,
  /password/i,
  /apikey/i,
  /api_key/i,
];

const WARNING_PATHS = [
  /\.config\//i,
  /\.openclaw\//i,
  /\.gitconfig/i,
];

const NETWORK_TOOLS = new Set([
  "web_fetch",
  "http",
  "fetch",
  "curl",
  "wget",
  "http_request",
  "browser",
  "message",        // messaging tools send data out
  "sessions_send",  // cross-session could exfiltrate
]);

const PERSISTENCE_PATTERNS = [
  /crontab/i,
  /systemctl\s+(enable|start)/i,
  /systemd/i,
  /\.bashrc/i,
  /\.profile/i,
  /\.bash_profile/i,
  /\.zshrc/i,
  /autostart/i,
  /launchd/i,
  /plist/i,
  /init\.d/i,
  /rc\.local/i,
];

const DANGER_COMMANDS = [
  /rm\s+-rf\s+\//i,
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\//i,
  /chmod\s+777/i,
  /curl.*\|\s*(bash|sh)/i,
  /wget.*\|\s*(bash|sh)/i,
];

const WARNING_COMMANDS = [
  /curl\s/i,
  /wget\s/i,
  /ssh\s/i,
  /scp\s/i,
  /rsync\s/i,
  /git\s+push/i,
  /npm\s+publish/i,
  /docker\s/i,
  /sudo\s/i,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a tool call by risk level and behavioral flags.
 */
export function classify(
  toolName: string,
  params: Record<string, unknown>
): Classification {
  const tool = toolName.toLowerCase();
  const result: Classification = {
    riskLevel: "SAFE",
    reason: "",
    accessesCredentials: false,
    makesNetworkCall: false,
    persistenceAttempt: false,
  };

  // --- Network detection ---
  if (NETWORK_TOOLS.has(tool)) {
    result.makesNetworkCall = true;
  }

  // Shell commands can also make network calls or access credentials
  if (["exec", "shell", "run", "bash"].includes(tool)) {
    const cmd = extractCommand(params);
    if (cmd) {
      // Network in shell
      if (/curl\s|wget\s|ssh\s|scp\s|rsync\s|nc\s|ncat\s|socat\s/i.test(cmd)) {
        result.makesNetworkCall = true;
      }

      // Credential access in shell
      if (/cat\s.*\.(env|key|pem)|cat\s.*id_rsa|cat\s.*\/etc\/(shadow|passwd)/i.test(cmd)) {
        result.accessesCredentials = true;
      }

      // Persistence in shell
      if (PERSISTENCE_PATTERNS.some((p) => p.test(cmd))) {
        result.persistenceAttempt = true;
        result.riskLevel = "WARNING";
        result.reason = `Persistence attempt: ${cmd.slice(0, 100)}`;
      }

      // Dangerous commands
      if (DANGER_COMMANDS.some((p) => p.test(cmd))) {
        result.riskLevel = "DANGER";
        result.reason = `Dangerous command: ${cmd.slice(0, 100)}`;
        return result;
      }

      // Warning commands
      if (WARNING_COMMANDS.some((p) => p.test(cmd))) {
        if (result.riskLevel === "SAFE") {
          result.riskLevel = "WARNING";
          result.reason = `Network/system command: ${cmd.slice(0, 100)}`;
        }
      }
    }
  }

  // --- File access tools ---
  if (["read", "file_read", "read_file", "cat", "Read"].includes(tool)) {
    const path = extractPath(params);
    if (path) {
      if (CREDENTIAL_PATHS.some((p) => p.test(path))) {
        result.accessesCredentials = true;
        result.riskLevel = "DANGER";
        result.reason = `Reading sensitive file: ${path}`;
        return result;
      }
      if (WARNING_PATHS.some((p) => p.test(path))) {
        result.riskLevel = "WARNING";
        result.reason = `Reading config file: ${path}`;
      }
    }
  }

  // --- Write/edit tools ---
  if (["write", "file_write", "write_file", "edit", "file_edit", "Write", "Edit"].includes(tool)) {
    const path = extractPath(params);
    if (path) {
      if (CREDENTIAL_PATHS.some((p) => p.test(path))) {
        result.accessesCredentials = true;
        result.riskLevel = "DANGER";
        result.reason = `Writing sensitive file: ${path}`;
        return result;
      }
      // Persistence via file write
      if (PERSISTENCE_PATTERNS.some((p) => p.test(path))) {
        result.persistenceAttempt = true;
        result.riskLevel = "WARNING";
        result.reason = `Persistence via file write: ${path}`;
      }
    }
  }

  // --- Network tools get at least WARNING ---
  if (result.makesNetworkCall && result.riskLevel === "SAFE") {
    result.riskLevel = "WARNING";
    result.reason = `Network access: ${tool}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPath(params: Record<string, unknown>): string | null {
  const path = params.path ?? params.file_path ?? params.filePath ?? params.file ?? null;
  return typeof path === "string" ? path : null;
}

function extractCommand(params: Record<string, unknown>): string | null {
  const cmd = params.command ?? params.cmd ?? params.script ?? null;
  return typeof cmd === "string" ? cmd : null;
}
