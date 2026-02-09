'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// ── Colors ──────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;

const color = {
  red:    (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  green:  (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:   (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  bold:   (s) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    (s) => isTTY ? `\x1b[2m${s}\x1b[0m`   : s,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function info(msg) { console.log(color.cyan(msg)); }
function success(msg) { console.log(color.green(msg)); }
function warn(msg) { console.log(color.yellow(msg)); }
function fail(msg) {
  console.error(color.red(`\n❌ ${msg}`));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: opts.timeout || 30000,
      stdio: opts.stdio || 'pipe',
      ...opts,
    }).trim();
  } catch (err) {
    if (opts.allowFail) return null;
    throw err;
  }
}

function showHelp() {
  log('');
  log(color.bold('podwatch') + ' — One-command Podwatch plugin installer for OpenClaw');
  log('');
  log(color.bold('Usage:'));
  log('  npx podwatch <api-key>');
  log('  podwatch <api-key>');
  log('');
  log(color.bold('Arguments:'));
  log('  api-key    Your Podwatch API key (starts with pw_)');
  log('             Get one at https://podwatch.app/dashboard');
  log('');
  log(color.bold('What it does:'));
  log('  1. Validates your API key with the Podwatch server');
  log('  2. Checks OpenClaw is installed and running');
  log('  3. Checks OpenClaw version compatibility');
  log('  4. Backs up your current config');
  log('  5. Installs the Podwatch plugin');
  log('  6. Configures the plugin with your API key');
  log('  7. Restarts the gateway to activate');
  log('');
  log(color.bold('Options:'));
  log('  --help, -h    Show this help message');
  log('');
  log(color.bold('Compatibility:'));
  log('  OS:       Linux, macOS (Windows not supported)');
  log('  OpenClaw: v2026.2.0 or later');
  log('  Node.js:  v16 or later');
  log('');
  log(color.dim('Docs: https://podwatch.app/docs'));
  log('');
}

// ── Config file discovery ───────────────────────────────────────────────────

function findConfigPath() {
  // 1. Env var
  const envPath = process.env.OPENCLAW_CONFIG;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const home = os.homedir();

  // 2. Default location
  const defaultPath = path.join(home, '.openclaw', 'openclaw.json');
  if (fs.existsSync(defaultPath)) return defaultPath;

  // 3. XDG config
  const xdgPath = path.join(home, '.config', 'openclaw', 'openclaw.json');
  if (fs.existsSync(xdgPath)) return xdgPath;

  // 4. If none exist, use the default path (we'll create it)
  return defaultPath;
}

// ── API key validation ──────────────────────────────────────────────────────

function validateApiKeyRemote(apiKey) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ apiKey });
    const url = new URL('https://podwatch.app/api/validate-key');

    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ valid: true });
        } else if (res.statusCode === 401 || res.statusCode === 404) {
          resolve({ valid: false, reason: 'Invalid or expired API key' });
        } else {
          // Server error or unexpected — skip validation, don't block install
          resolve({ valid: true, skipped: true });
        }
      });
    });

    req.on('error', () => {
      // Network error — skip validation, don't block install
      resolve({ valid: true, skipped: true });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: true, skipped: true });
    });

    req.write(postData);
    req.end();
  });
}

// ── Version parsing ─────────────────────────────────────────────────────────

// OpenClaw versions look like "2026.2.3-1" — we need >= 2026.2.0
function parseOpenClawVersion(versionStr) {
  if (!versionStr) return null;
  const match = versionStr.match(/^(\d{4})\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    year: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function isVersionCompatible(version) {
  if (!version) return null; // unknown — proceed with warning
  // Minimum: 2026.2.0 (plugin system introduced)
  if (version.year > 2026) return true;
  if (version.year < 2026) return false;
  if (version.minor >= 2) return true;
  return false;
}

// ── Steps ───────────────────────────────────────────────────────────────────

function stepValidateApiKey() {
  log('');
  info('🔍 Validating API key format...');

  const apiKey = process.argv[2];

  if (!apiKey) {
    fail('No API key provided.\n\n   Usage: npx podwatch <api-key>\n   Get your key at: https://podwatch.app/dashboard');
  }

  if (apiKey === '--help' || apiKey === '-h') {
    showHelp();
    process.exit(0);
  }

  if (!apiKey.startsWith('pw_')) {
    fail(`Invalid API key format: "${apiKey}"\n   API keys must start with "pw_"\n   Get your key at: https://podwatch.app/dashboard`);
  }

  if (apiKey.length < 8) {
    fail('API key is too short. Check that you copied the full key.');
  }

  success('✅ API key format valid');
  return apiKey;
}

async function stepValidateApiKeyRemote(apiKey) {
  info('🔍 Validating API key with server...');

  const result = await validateApiKeyRemote(apiKey);

  if (result.skipped) {
    warn('⚠️  Could not reach Podwatch server — skipping key validation');
    warn('   (key will be validated when the plugin connects)');
    return;
  }

  if (!result.valid) {
    fail(`API key is invalid: ${result.reason}\n   Check your key at: https://podwatch.app/dashboard`);
  }

  success('✅ API key validated');
}

function stepCheckPlatform() {
  if (process.platform === 'win32') {
    fail(
      'Windows is not supported yet.\n' +
      '   Podwatch requires a Unix-like environment (Linux or macOS).\n' +
      '   If you\'re using WSL, run this command inside WSL instead.'
    );
  }
}

function stepCheckPrerequisites() {
  info('🔍 Checking prerequisites...');

  try {
    exec('command -v openclaw');
  } catch {
    fail('OpenClaw not found. Install it first: https://docs.openclaw.ai');
  }

  success('✅ OpenClaw found');
}

function stepCheckVersion() {
  info('🔍 Checking OpenClaw version...');

  let versionStr = null;
  try {
    versionStr = exec('openclaw --version', { allowFail: true, timeout: 10000 });
  } catch {
    // ignore
  }

  if (!versionStr) {
    warn('⚠️  Could not determine OpenClaw version — proceeding anyway');
    return;
  }

  log(color.dim(`   Version: ${versionStr}`));

  const version = parseOpenClawVersion(versionStr);
  const compatible = isVersionCompatible(version);

  if (compatible === false) {
    fail(
      `OpenClaw ${versionStr} is too old.\n` +
      '   Podwatch requires OpenClaw v2026.2.0 or later.\n' +
      '   Update OpenClaw: openclaw update'
    );
  }

  if (compatible === null) {
    warn('⚠️  Unrecognized version format — proceeding anyway');
    return;
  }

  success('✅ OpenClaw version compatible');
}

async function stepCheckGateway() {
  info('🔍 Checking gateway status...');

  let running = isGatewayRunning();

  if (!running) {
    warn('⚠️  Gateway not running. Starting it...');
    try {
      exec('openclaw gateway start', { timeout: 15000, allowFail: true });
      await sleep(5000);
      running = isGatewayRunning();
    } catch {
      // ignore, we'll check below
    }
  }

  if (!running) {
    fail(
      'Could not start the OpenClaw gateway.\n' +
      '   Try manually:\n' +
      '     openclaw gateway start\n' +
      '   Then re-run this installer.'
    );
  }

  success('✅ Gateway running');
}

function isGatewayRunning() {
  // Try openclaw status first
  try {
    const out = exec('openclaw status --json', { allowFail: true, timeout: 10000 });
    if (out) {
      try {
        const status = JSON.parse(out);
        if (status.running || status.gateway?.running || status.status === 'running') {
          return true;
        }
      } catch {
        // If output contains "running" loosely
        if (out.toLowerCase().includes('running')) return true;
      }
    }
  } catch {
    // fall through
  }

  // Fallback: pgrep
  try {
    const result = exec('pgrep -f openclaw', { allowFail: true });
    return !!result;
  } catch {
    return false;
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function stepInstallPlugin() {
  info('📦 Installing Podwatch plugin...');

  const packageRoot = path.resolve(__dirname, '..');
  const extensionsDir = path.join(os.homedir(), '.openclaw', 'extensions', 'podwatch');

  // Files/dirs to copy from this package into the extensions dir
  const distSrc = path.join(packageRoot, 'dist');
  const manifestSrc = path.join(packageRoot, 'openclaw.plugin.json');
  const pkgSrc = path.join(packageRoot, 'package.json');
  const skillsSrc = path.join(packageRoot, 'skills');

  // Validate source files exist
  if (!fs.existsSync(distSrc)) {
    fail('Plugin dist/ directory not found in package. The package may be corrupted.');
  }
  if (!fs.existsSync(manifestSrc)) {
    fail('openclaw.plugin.json not found in package. The package may be corrupted.');
  }

  // Create extensions dir
  fs.mkdirSync(extensionsDir, { recursive: true });

  // Copy dist/
  const distDest = path.join(extensionsDir, 'dist');
  if (fs.existsSync(distDest)) {
    fs.rmSync(distDest, { recursive: true, force: true });
  }
  copyDirSync(distSrc, distDest);
  log(color.dim('   Copied dist/'));

  // Copy openclaw.plugin.json
  fs.copyFileSync(manifestSrc, path.join(extensionsDir, 'openclaw.plugin.json'));
  log(color.dim('   Copied openclaw.plugin.json'));

  // Copy package.json
  if (fs.existsSync(pkgSrc)) {
    fs.copyFileSync(pkgSrc, path.join(extensionsDir, 'package.json'));
    log(color.dim('   Copied package.json'));
  }

  // Copy skills/ if present
  if (fs.existsSync(skillsSrc)) {
    const skillsDest = path.join(extensionsDir, 'skills');
    if (fs.existsSync(skillsDest)) {
      fs.rmSync(skillsDest, { recursive: true, force: true });
    }
    copyDirSync(skillsSrc, skillsDest);
    log(color.dim('   Copied skills/'));
  }

  success('✅ Plugin installed to ' + extensionsDir);
}

function stepBackupConfig(configPath) {
  if (!fs.existsSync(configPath)) return;

  info('💾 Backing up current config...');

  const backupPath = configPath + '.bak';
  try {
    fs.copyFileSync(configPath, backupPath);
    log(color.dim(`   Backup: ${backupPath}`));
    success('✅ Config backed up');
  } catch (err) {
    warn(`⚠️  Could not back up config: ${err.message}`);
    warn('   Proceeding anyway — your config will be merged, not replaced');
  }
}

function stepPatchConfig(apiKey) {
  info('⚙️  Configuring plugin...');

  const configPath = findConfigPath();

  // Backup before modifying
  stepBackupConfig(configPath);

  // Read existing config or start fresh
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(raw);
    } catch (err) {
      fail(`Failed to parse config file at ${configPath}\n   Error: ${err.message}\n   Fix the JSON manually or delete it to start fresh.`);
    }
  } else {
    // Ensure directory exists
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    log(color.dim(`   Creating config at ${configPath}`));
  }

  // Merge diagnostics (required for cost tracking)
  if (!config.diagnostics) config.diagnostics = {};
  config.diagnostics.enabled = true;

  // Merge plugins
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};

  // Merge podwatch entry (preserve other fields if they exist)
  if (!config.plugins.entries.podwatch) config.plugins.entries.podwatch = {};

  config.plugins.entries.podwatch.enabled = true;

  if (!config.plugins.entries.podwatch.config) config.plugins.entries.podwatch.config = {};
  config.plugins.entries.podwatch.config.apiKey = apiKey;
  config.plugins.entries.podwatch.config.endpoint = 'https://podwatch.app/api';
  config.plugins.entries.podwatch.config.enableBudgetEnforcement = true;
  config.plugins.entries.podwatch.config.enableSecurityAlerts = true;

  // Write back
  try {
    const output = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileSync(configPath, output, 'utf8');
  } catch (err) {
    fail(`Failed to write config file at ${configPath}\n   Error: ${err.message}\n   Check file permissions.`);
  }

  log(color.dim(`   Config: ${configPath}`));
  success('✅ Configuration saved');

  return configPath;
}

function stepVerifyConfig(configPath) {
  info('🔍 Verifying configuration...');

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);

    const checks = [
      [config.plugins?.entries?.podwatch, 'podwatch entry not found'],
      [config.plugins?.entries?.podwatch?.enabled, 'podwatch plugin not enabled'],
      [config.plugins?.entries?.podwatch?.config?.apiKey, 'API key not found'],
      [config.plugins?.entries?.podwatch?.config?.endpoint, 'endpoint not found'],
      [config.plugins?.entries?.podwatch?.config?.enableBudgetEnforcement === true, 'budget enforcement not enabled'],
      [config.plugins?.entries?.podwatch?.config?.enableSecurityAlerts === true, 'security alerts not enabled'],
      [config.diagnostics?.enabled === true, 'diagnostics not enabled'],
    ];

    for (const [condition, msg] of checks) {
      if (!condition) {
        fail(`Verification failed: ${msg} in config after writing.`);
      }
    }

    success('✅ Configuration verified');
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`Config file not found at ${configPath} after writing.`);
    }
    fail(`Verification failed: ${err.message}`);
  }
}

function stepRestartGateway() {
  info('🔄 Restarting gateway to load plugin...');
  log(color.dim('   Your agent will go quiet for ~10 seconds during restart.'));

  // Background the restart so the installer can exit cleanly
  // and the calling agent can relay the success message before dying
  const child = spawn('bash', [
    '-c',
    'sleep 2 && openclaw gateway stop 2>/dev/null; sleep 3 && openclaw gateway start 2>/dev/null',
  ], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  success('✅ Gateway restart scheduled (will happen in ~2 seconds)');
}

function stepFinalMessage() {
  log('');
  log(color.bold(color.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')));
  log('');
  success('🎉 Podwatch installed successfully!');
  log('');
  log(`   ${color.bold('Dashboard:')}  https://podwatch.app`);
  log(`   ${color.bold('Docs:')}       https://podwatch.app/docs`);
  log('');
  log(color.dim('   Your agent will restart in a few seconds.'));
  log(color.dim('   Events will appear on your dashboard within minutes.'));
  log('');
  log(color.bold('   Features enabled:'));
  log('   • Cost tracking & monitoring');
  log('   • Budget enforcement');
  log('   • Security alerts');
  log('   • Agent pulse (online status)');
  log('');
  log(color.bold(color.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')));
  log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  log('');
  log(color.bold('  🛡️  Podwatch Installer'));
  log(color.dim('  Agent security monitoring for OpenClaw'));
  log('');

  // Check for --help before anything
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    showHelp();
    process.exit(0);
  }

  // Step 1: Platform check
  stepCheckPlatform();

  // Step 2: Validate API key format
  const apiKey = stepValidateApiKey();

  // Step 3: Validate API key with server
  await stepValidateApiKeyRemote(apiKey);

  // Step 4: Check prerequisites
  stepCheckPrerequisites();

  // Step 5: Check version compatibility
  stepCheckVersion();

  // Step 6: Check gateway
  await stepCheckGateway();

  // Step 7: Install plugin
  stepInstallPlugin();

  // Step 8: Patch config (includes backup)
  const configPath = stepPatchConfig(apiKey);

  // Step 9: Verify config
  stepVerifyConfig(configPath);

  // Step 10: Restart gateway (backgrounded)
  stepRestartGateway();

  // Step 11: Final message
  stepFinalMessage();
}

module.exports = { run };
