import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readMarkdown } from '../../content.ts';
import { createMarkdownRenderer } from '../../markdown.ts';
import { createHomeTask } from './home-task.ts';
import { homeInput } from './home-source.ts';
export { homeInput } from './home-source.ts';
import type { HostContext, PackageDefinition, PackageInput, PackageRegistration } from '../../package-contract.ts';

const metadata = { id: 'home', version: '1.0.0', hostVersion: '1', label: 'Home', order: 10 } as const;

function createHomeHandler(source: () => string) {
  const renderer = createMarkdownRenderer();
  return async (_request, response, context: HostContext) => {
    const currentSource = source();
    const isHtml = /\.(html|htm)$/i.test(currentSource);
    const relativePath = context.resolveRepositoryPath(currentSource);
    if (!relativePath) {
      response.json(404, { error: 'Home source not found' });
      return;
    }
    try {
      const content = isHtml
        ? await readFile(path.join(context.repositoryRoot, relativePath), 'utf8')
        : await readMarkdown(context.repositoryRoot, relativePath);
      response.json(200, {
        path: relativePath.split(path.sep).join('/'),
        content,
        html: isHtml ? content : renderer.render(content),
      });
    } catch {
      response.json(404, { error: 'Home source not found' });
    }
  };
}

function register(context: HostContext, input: PackageInput): PackageRegistration {
  const { source } = homeInput(input);
  let configuredSource = source;
  return {
    metadata,
    routes: [{ method: 'GET', path: '/api/home', handler: createHomeHandler(() => configuredSource) }],
    assets: [
      { path: '/assets/home/home.js', file: 'src/packages/home/home.js', contentType: 'text/javascript; charset=utf-8' },
      { path: '/assets/home/home.css', file: 'src/packages/home/home.css', contentType: 'text/css; charset=utf-8' },
    ],
    navigation: [],
    browser: { id: 'home', entry: '/assets/home/home.js', stylesheet: '/assets/home/home.css' },
    tasks: [createHomeTask(context, input, { onSourceChanged: (source) => { configuredSource = source; } })],
  };
}

export const homePackage: PackageDefinition = { metadata, register };
export default homePackage;
