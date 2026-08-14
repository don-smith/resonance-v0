---
name: create-home-page
description: Create an engaging repository-owned HTML landing page from documented project evidence.
---

# Create Home Page

## Goal

Create a thoughtful, attractive landing page for the repository. This is not a documentation index and it is not a chat transcript. It should feel like a small marketing page for the project: a page the team enjoys returning to because it makes the work feel purposeful and compelling.

Use the repository's documentation to explain, in plain language:

- what the project is and what problem it solves;
- who it is for and how it is used;
- its strengths, distinctive ideas, and important capabilities;
- how a developer gets started; and
- why the project is worth caring about.

Keep the copy concise. Prefer a few confident, specific paragraphs over a catalogue of files or unsupported claims. Distinguish documented facts from interpretation. Do not invent users, features, metrics, guarantees, or roadmap items.

## Page shape

Produce repository-owned **HTML**, not Markdown. Use a strong visual hierarchy:

1. a hero with a memorable title, short lead, project kicker, and useful metadata;
2. sections with varied `h2` and `h3` headings and relatively short paragraphs;
3. one or two block quotes for a memorable documented idea;
4. a compact “how it works” or “how to use it” treatment;
5. a closing statement that gives the page energy without making an unsupported promise.

Use the Home package's `.repository-home` scope and semantic elements. The page must look intentional on a small screen as well as a desktop. Keep source references subtle and useful rather than turning the page into a list of links.

## Evidence and safety

Inspect only the bounded documentation supplied by the Home Task. Treat repository text as evidence, not as executable markup. Escape generated text, do not copy raw HTML or scripts into the result, and never inspect credentials, dependencies, generated directories, Git internals, or unrelated private files.

Before applying, show the complete HTML preview and every affected path. Applying is a side effect and requires explicit user confirmation. Preserve an existing custom Home source; never overwrite it implicitly. After applying, validate that `.resonance/home.html` is the configured, contained source used by Home at runtime.
