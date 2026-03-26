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
  log('  npx podwatch <api-key>     Install / configure with API key');
  log('  podwatch update            Update to the latest version');
  log('  podwatch uninstall         Remove Podwatch from this machine');
  log('');
  log(color.bold('Arguments:'));
  log('  api-key    Your Podwatch API key (starts with pw_)');
  log('             Get one at https://podwatch.app/dashboard');
  log('');
  log(color.bold('Commands:'));
  log('  update       Check for and install the latest Podwatch version');
  log('  uninstall    Remove plugin files, clean config, restart gateway');
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

  // Add podwatch to allow list if one exists
  if (Array.isArray(config.plugins.allow)) {
    if (!config.plugins.allow.includes('podwatch')) {
      config.plugins.allow.push('podwatch');
      log(color.dim('   Added podwatch to plugins.allow list'));
    }
  }

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
  // and the calling agent can relay the success message before dying.
  // Use `gateway restart` (atomic systemctl restart) instead of stop+sleep+start
  // to avoid race conditions and silent failures.
  const child = spawn('bash', [
    '-c',
    'sleep 2 && openclaw gateway restart >> /tmp/openclaw-plugin-restart.log 2>&1 || ' +
    '(sleep 5 && openclaw gateway start >> /tmp/openclaw-plugin-restart.log 2>&1)',
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

// ── Update command ──────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    https.get({
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname,
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Failed to parse JSON response'));
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Request timed out')); });
  });
}

async function runUpdate() {
  log('');
  log(color.bold('  🛡️  Podwatch Updater'));
  log('');

  const extensionsDir = path.join(os.homedir(), '.openclaw', 'extensions', 'podwatch');
  const installedPkgPath = path.join(extensionsDir, 'package.json');

  // Get current installed version
  let currentVersion = null;
  try {
    if (fs.existsSync(installedPkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
      currentVersion = pkg.version || null;
    }
  } catch {
    // ignore
  }

  if (!currentVersion) {
    fail('Podwatch is not installed.\n   Install it first: npx podwatch <api-key>');
  }

  info(`📦 Current version: v${currentVersion}`);
  info('🔍 Checking for updates...');

  // Fetch latest version from npm
  let latestData;
  try {
    latestData = await fetchJson('https://registry.npmjs.org/podwatch/latest');
  } catch (err) {
    fail(`Could not check for updates: ${err.message}\n   Check your internet connection and try again.`);
  }

  const latestVersion = latestData.version;
  const integrityHash = latestData.dist?.integrity || null;

  if (!latestVersion) {
    fail('Could not determine latest version from npm registry.');
  }

  if (currentVersion === latestVersion) {
    success(`✅ Already up to date (v${currentVersion})`);
    process.exit(0);
  }

  info(`📥 Updating v${currentVersion} → v${latestVersion}...`);

  // Download via npm pack
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podwatch-update-'));
    const packResult = execSync(`npm pack podwatch@${latestVersion} --pack-destination "${tmpDir}"`, {
      encoding: 'utf8',
      timeout: 120000,
      cwd: tmpDir,
    }).trim();

    const tarballName = packResult.split('\n').pop().trim();
    if (!tarballName) {
      fail('npm pack did not output a tarball filename.');
    }

    const tarballPath = path.join(tmpDir, tarballName);

    // Verify SRI integrity if available
    if (integrityHash) {
      info('🔒 Verifying integrity...');
      const sriMatch = integrityHash.match(/^(sha256|sha384|sha512)-(.+)$/);
      if (sriMatch) {
        const algo = sriMatch[1];
        const expectedDigest = sriMatch[2];
        const crypto = require('crypto');
        const content = fs.readFileSync(tarballPath);
        const actualDigest = crypto.createHash(algo).update(content).digest('base64');
        if (actualDigest !== expectedDigest) {
          fail(`Integrity check failed.\n   Expected: ${integrityHash}\n   Got:      ${algo}-${actualDigest}\n   The download may be corrupted. Try again.`);
        }
        success('✅ Integrity verified');
      }
    }

    // Backup old dist before replacing (rollback on failure)
    const distDir = path.join(extensionsDir, 'dist');
    const backupDir = path.join(extensionsDir, 'dist.backup');
    let hasBackup = false;

    if (fs.existsSync(distDir)) {
      info('💾 Backing up current dist/...');
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
      fs.renameSync(distDir, backupDir);
      hasBackup = true;
    }

    // Ensure extensions dir exists
    fs.mkdirSync(extensionsDir, { recursive: true });

    // Extract tarball (npm pack creates tarballs with "package/" prefix)
    try {
      execSync(`tar xzf "${tarballPath}" --strip-components=1 -C "${extensionsDir}"`, {
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch (extractErr) {
      // Rollback on extraction failure
      if (hasBackup) {
        warn('⚠️  Extraction failed — rolling back to previous version');
        try {
          if (fs.existsSync(distDir)) {
            fs.rmSync(distDir, { recursive: true, force: true });
          }
          fs.renameSync(backupDir, distDir);
          success('✅ Rollback successful — previous version restored');
        } catch (rollbackErr) {
          fail(`Extraction AND rollback failed: ${rollbackErr.message}\n   Manual reinstall needed: npx podwatch <api-key>`);
        }
      }
      fail(`Extraction failed: ${extractErr.message}`);
    }

    // Clean up backup on success
    if (hasBackup && fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    success(`✅ Updated to v${latestVersion}`);
  } catch (err) {
    if (err.message && !err.message.startsWith('\n❌')) {
      fail(`Update failed: ${err.message}`);
    }
    throw err;
  } finally {
    // Clean up temp dir
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // Restart gateway
  stepRestartGateway();

  log('');
  success(`🎉 Podwatch updated: v${currentVersion} → v${latestVersion}`);
  log('');
}

// ── Uninstall command ───────────────────────────────────────────────────────

function confirm(question) {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function runUninstall() {
  log('');
  log(color.bold('  🛡️  Podwatch Uninstaller'));
  log('');

  const confirmed = await confirm(color.yellow('Are you sure you want to uninstall Podwatch? (y/N) '));
  if (!confirmed) {
    log('');
    log(color.dim('  Cancelled. Nothing was changed.'));
    log('');
    process.exit(0);
  }

  log('');

  const home = os.homedir();
  const extensionsDir = path.join(home, '.openclaw', 'extensions', 'podwatch');

  // 1. Remove plugin files
  info('🗑️  Removing plugin files...');
  if (fs.existsSync(extensionsDir)) {
    try {
      fs.rmSync(extensionsDir, { recursive: true, force: true });
      success('✅ Plugin files removed');
    } catch (err) {
      warn(`⚠️  Could not fully remove ${extensionsDir}: ${err.message}`);
    }
  } else {
    log(color.dim('   Plugin directory already gone — skipping'));
  }

  // 2. Clean openclaw.json config
  info('⚙️  Cleaning config...');
  const configPath = findConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      let changed = false;

      // Remove from plugins.allow list
      if (Array.isArray(config.plugins?.allow)) {
        const idx = config.plugins.allow.indexOf('podwatch');
        if (idx !== -1) {
          config.plugins.allow.splice(idx, 1);
          changed = true;
          log(color.dim('   Removed podwatch from plugins.allow list'));
        }
      }

      // Remove from plugins.entries
      if (config.plugins?.entries?.podwatch) {
        delete config.plugins.entries.podwatch;
        changed = true;
        // Clean up empty parents
        if (Object.keys(config.plugins.entries).length === 0) {
          delete config.plugins.entries;
        }
        if (Object.keys(config.plugins).length === 0) {
          delete config.plugins;
        }
      }

      if (changed) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
        success('✅ Config cleaned');
      } else {
        log(color.dim('   No podwatch config entry found — skipping'));
      }
    } catch (err) {
      warn(`⚠️  Could not clean config: ${err.message}`);
    }
  } else {
    log(color.dim('   Config file not found — skipping'));
  }

  // 3. Remove cache files
  info('🧹 Removing cache files...');
  const cacheFiles = [
    path.join(home, '.openclaw', '.last-update-check'),
    path.join(home, '.openclaw', '.podwatch-update-check'),
  ];
  let cacheRemoved = 0;
  for (const cachePath of cacheFiles) {
    if (fs.existsSync(cachePath)) {
      try {
        fs.unlinkSync(cachePath);
        cacheRemoved++;
      } catch { /* ignore */ }
    }
  }
  if (cacheRemoved > 0) {
    success(`✅ Removed ${cacheRemoved} cache file${cacheRemoved > 1 ? 's' : ''}`);
  } else {
    log(color.dim('   No cache files found — skipping'));
  }

  // 4. Restart gateway
  stepRestartGateway();

  // 5. Success message
  log('');
  success('🎉 Podwatch uninstalled.');
  log('');
  log('   Your dashboard data at ' + color.bold('podwatch.app') + ' is preserved —');
  log('   reinstall anytime with ' + color.cyan('npx podwatch <api-key>'));
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

  // Subcommands
  if (arg === 'update') {
    return runUpdate();
  }
  if (arg === 'uninstall') {
    return runUninstall();
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
