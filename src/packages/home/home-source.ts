import path from 'node:path';
import type { PackageInput } from '../../package-contract.ts';

const DEFAULT_PROVIDER = 'openrouter' as const;
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

export function homeInput(input: PackageInput): { source: string } {
  const source = input.source === undefined ? 'README.md' : input.source;
  if (typeof source !== 'string' || !source || path.posix.isAbsolute(source) || path.win32.isAbsolute(source) || /\\/.test(source)) {
    throw new Error('Home source must be a non-empty relative path.');
  }
  if (!/\.(md|markdown|html|htm)$/i.test(source)) throw new Error('Home source must be a Markdown file or an HTML file.');
  return { source };
}

export function homeAgentInput(input: PackageInput): { provider: 'openai' | 'openrouter'; model: string } {
  const provider = input.provider === undefined ? DEFAULT_PROVIDER : input.provider;
  if (provider !== 'openai' && provider !== 'openrouter') throw new Error('Home provider must be openai or openrouter.');
  const model = input.model === undefined ? DEFAULT_MODEL : input.model;
  if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new Error('Home model must be a non-empty string.');
  return { provider, model };
}
