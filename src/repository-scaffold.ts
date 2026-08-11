import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PACKAGE_FILES = {
  backlog: {
    'backlog/todo.yaml': `version: 1\ndecisions:\n  - title: Establish the backlog\n    plan: plans/establish-backlog.md\n    status: in-planning\n    priority: P2\n`,
    'backlog/plans/establish-backlog.md': '# Establish the backlog\n\nUse this backlog to record repository decisions and their supporting plans.\n',
  },
  architecture: {
    'architecture/model.c4': `specification {\n  element system\n}\n\nmodel {\n}\n\nviews {\n  view systemContext {\n    include *\n  }\n}\n`,
    'architecture/model.json': '{\n  "version": 1,\n  "entities": [],\n  "relationships": []\n}\n',
    'architecture/views.json': '{\n  "version": 1,\n  "views": []\n}\n',
    'architecture/rules.json': '{\n  "version": 1,\n  "rules": []\n}\n',
    'architecture/patterns.json': '{\n  "version": 1,\n  "patterns": []\n}\n',
    'architecture/decisions.json': '{\n  "version": 1,\n  "decisions": []\n}\n',
  },
} as const;

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isSelected(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as { enabled?: unknown; artifactRoot?: unknown };
  return config.enabled !== false && (config.artifactRoot === undefined || config.artifactRoot === 'architecture');
}

async function writeIfMissing(root: string, relative: string, content: string): Promise<void> {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  try { await writeFile(filename, content, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (!isAlreadyExists(error)) throw error; }
}

export async function scaffoldRepositoryPackages(root: string, selection: Record<string, unknown>): Promise<void> {
  for (const [packageId, files] of Object.entries(PACKAGE_FILES)) {
    if (!isSelected(selection[packageId])) continue;
    for (const [relative, content] of Object.entries(files)) await writeIfMissing(root, relative, content);
  }
}
