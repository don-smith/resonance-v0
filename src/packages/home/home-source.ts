import path from 'node:path';
import type { PackageInput } from '../../package-contract.ts';

export function homeInput(input: PackageInput): { source: string } {
  const source = input.source === undefined ? 'README.md' : input.source;
  if (typeof source !== 'string' || !source || path.posix.isAbsolute(source) || path.win32.isAbsolute(source) || /\\/.test(source)) {
    throw new Error('Home source must be a non-empty relative path.');
  }
  if (!/\.(md|markdown|html|htm)$/i.test(source)) throw new Error('Home source must be a Markdown file or an HTML file.');
  return { source };
}
