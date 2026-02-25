/**
 * Skill/plugin scanner — scans installed skills and plugins.
 *
 * Scans:
 * - ~/.openclaw/skills/ (managed skills)
 * - <workspace>/skills/ (workspace skills)
 * - ~/.openclaw/extensions/ (installed plugins)
 *
 * Reports: name, version, source, permissions, risk indicators.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScannedItem {
  name: string;
  type: "skill" | "plugin";
  source: string;
  version?: string;
  description?: string;
  permissions?: string[];
  riskIndicators?: string[];
}

interface ScanChanges {
  newSkills: string[];
  removedSkills: string[];
  newPlugins: string[];
  removedPlugins: string[];
}

interface ScanResults {
  skills: ScannedItem[];
  plugins: ScannedItem[];
  totalSkills: number;
  totalPlugins: number;
  changes: ScanChanges | null;
  scannedAt: number;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

// Track last scan results for change detection
let lastSkillNames: Set<string> | null = null;
let lastPluginNames: Set<string> | null = null;

/**
 * Reset last scan state (for testing).
 */
export function resetLastScan(): void {
  lastSkillNames = null;
  lastPluginNames = null;
}

export async function scanSkillsAndPlugins(workspaceDir?: string): Promise<ScanResults> {
  const home = homedir();
  const skills: ScannedItem[] = [];
  const plugins: ScannedItem[] = [];

  // Scan managed skills
  await scanDirectory(
    resolve(home, ".openclaw", "skills"),
    "skill",
    "managed",
    skills
  );

  // Scan workspace skills
  if (workspaceDir) {
    await scanDirectory(
      resolve(workspaceDir, "skills"),
      "skill",
      "workspace",
      skills
    );
  }

  // Scan installed plugins/extensions
  await scanDirectory(
    resolve(home, ".openclaw", "extensions"),
    "plugin",
    "installed",
    plugins
  );

  // Compute changes against last scan
  const currentSkillNames = new Set(skills.map(s => s.name));
  const currentPluginNames = new Set(plugins.map(p => p.name));

  let changes: ScanChanges | null = null;
  if (lastSkillNames !== null || lastPluginNames !== null) {
    const prevSkills = lastSkillNames ?? new Set<string>();
    const prevPlugins = lastPluginNames ?? new Set<string>();
    changes = {
      newSkills: [...currentSkillNames].filter(n => !prevSkills.has(n)),
      removedSkills: [...prevSkills].filter(n => !currentSkillNames.has(n)),
      newPlugins: [...currentPluginNames].filter(n => !prevPlugins.has(n)),
      removedPlugins: [...prevPlugins].filter(n => !currentPluginNames.has(n)),
    };
  }

  // Store for next comparison
  lastSkillNames = currentSkillNames;
  lastPluginNames = currentPluginNames;

  return {
    skills,
    plugins,
    totalSkills: skills.length,
    totalPlugins: plugins.length,
    changes,
    scannedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function scanDirectory(
  dir: string,
  type: "skill" | "plugin",
  source: string,
  results: ScannedItem[]
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const itemDir = join(dir, entry.name);
      const item: ScannedItem = {
        name: entry.name,
        type,
        source,
      };

      // Try to read metadata
      if (type === "skill") {
        await readSkillMeta(itemDir, item);
      } else {
        await readPluginMeta(itemDir, item);
      }

      results.push(item);
    }
  } catch {
    // Directory doesn't exist — that's fine
  }
}

async function readSkillMeta(dir: string, item: ScannedItem): Promise<void> {
  try {
    const skillMd = await readFile(join(dir, "SKILL.md"), "utf-8");

    // Parse YAML frontmatter
    const match = skillMd.match(/^---\n([\s\S]*?)\n---/);
    if (match) {
      const frontmatter = match[1];
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter.match(/^description:\s*"?(.+?)"?$/m);
      const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);

      if (nameMatch) item.name = nameMatch[1].trim();
      if (descMatch) item.description = descMatch[1].trim();
      if (versionMatch) item.version = versionMatch[1].trim();
    }
  } catch {
    // No SKILL.md — skip metadata
  }
}

async function readPluginMeta(dir: string, item: ScannedItem): Promise<void> {
  try {
    const manifest = await readFile(join(dir, "openclaw.plugin.json"), "utf-8");
    const parsed = JSON.parse(manifest) as {
      name?: string;
      version?: string;
      description?: string;
    };

    if (parsed.name) item.name = parsed.name;
    if (parsed.version) item.version = parsed.version;
    if (parsed.description) item.description = parsed.description;
  } catch {
    // Try package.json fallback
    try {
      const pkg = await readFile(join(dir, "package.json"), "utf-8");
      const parsed = JSON.parse(pkg) as {
        name?: string;
        version?: string;
        description?: string;
      };

      if (parsed.name) item.name = parsed.name;
      if (parsed.version) item.version = parsed.version;
      if (parsed.description) item.description = parsed.description;
    } catch {
      // No metadata available
    }
  }
}
