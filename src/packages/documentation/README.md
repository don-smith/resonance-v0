# Documentation package

The Documentation package provides the repository Markdown workspace. It discovers configured document types, projects them into a tree, reads selected files, renders Markdown, and exposes canonical namespaced routes. Its optional local agent receives the active document and highlighted text, and can make bounded Markdown edits.

## Responsibilities

- Discover files using configured `extensions` and `ignoredDirectories` inputs.
- Build the sorted folder/file tree shown in the Documentation mount.
- Read and render selected Markdown documents.
- Navigate relative links between discovered Markdown documents without leaving the Documentation workspace.
- Remember the Documentation agent panel visibility, selected document, and collapsed document-tree folders in the Documentation package's browser local storage area.
- Enforce the Markdown extension policy after host repository containment.
- Serve `/api/documentation/tree` and `/api/documentation/document`.
- Provide the Documentation agent state, SSE events, prompt, credential, stop, and reset routes.
- Serve the Documentation browser entrypoint and stylesheet.

## Configuration

Configure Documentation as an entry in the repository manifest’s `packages` object:

```json
{
  "version": 1,
  "packages": {
    "documentation": {
      "module": "src/packages/documentation/index.ts",
      "extensions": [".md", ".markdown"],
      "ignoredDirectories": [".git", "node_modules"],
      "provider": "openrouter",
      "model": "deepseek/deepseek-v4-flash"
    }
  }
}
```

- `module` is required at load time and must be a non-empty path relative to the Resonance application root.
- `enabled` is an optional common package flag; `false` omits Documentation from the host.
- `extensions` is optional and defaults to `[".md", ".markdown"]`. Every value must be a dotted string.
- `ignoredDirectories` is optional and defaults to `[".git", "node_modules"]`. Every value must be a non-empty directory name.
- `provider` is optional and defaults to `openrouter`; `openai` and `openrouter` are supported.
- `model` is optional and defaults to `deepseek/deepseek-v4-flash`.

Documentation uses `extensions` when discovering and reading documents, and applies `ignoredDirectories` during discovery, document access, and agent edits. Omit either option to use its default; provide both when the repository uses a different Markdown extension policy or needs additional directories excluded.

## Agent

The agent routes are:

- `GET /api/documentation/agent/state`
- `GET /api/documentation/agent/events` (snapshot-first SSE)
- `POST /api/documentation/agent/prompt` with `{ prompt, selectedPath, selectedText? }`
- `POST /api/documentation/agent/credential`
- `POST /api/documentation/agent/stop`
- `POST /api/documentation/agent/reset`

The browser captures a text selection within the rendered document and includes it with the active document path on every prompt. The agent can read, replace, or edit configured Markdown files only. Changes emit a mutation event and the Documentation view reloads the active document without a page reload. The provider key is stored in gitignored `.resonance/documentation-agent.env` with mode `0600`.

## Ownership boundary

`src/packages/documentation/` contains reusable package implementation. Discovery and document reads continue from the viewed repository root supplied by `HostContext`; shared `src/content.ts` and `src/markdown.ts` remain outside this package because Home uses them too.
