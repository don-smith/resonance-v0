---
name: edit-docs
description: Safely improve repository Markdown documents from an active document and optional highlighted passage.
---

# Edit Docs

- Treat the active document path and its contents as the primary context.
- If the user highlights text, address that passage first and preserve surrounding intent.
- Read the document with `read_document` before editing.
- Use `edit_document` for a focused replacement. Use `replace_document` only when a complete rewrite is requested.
- Make the smallest change that satisfies the request and report the affected document.
- Never invent a successful edit: rely on the document tool result.
