# Obsidian-native vault assets

Second Brain generates plain Markdown, `.base` views, and a small navigation
Canvas so the vault is pleasant to browse and edit in a stock Obsidian install.
No community plugin, Dataview, or image-generation dependency is required for
anything documented here.

## Installing the navigation assets

The service installs navigation assets with a create-only policy:

```sh
node dist/cli.js obsidian init --create-only
node dist/cli.js obsidian init --create-only --vault /path/to/vault
```

A routine install never overwrites a page, a view, a Canvas, or a setting. Each
asset is classified as `created` (newly written), `unchanged` (already present
and byte-identical), or `conflict` (present but different, so it was preserved
untouched). A personal `Home.md` or a modified `.base` therefore shows up as a
`conflict` rather than being silently replaced. The installer never reads or
writes `.obsidian`, so user settings are always preserved.

## Generated assets

| Path | Purpose |
|---|---|
| `Home.md` | Navigation to projects, active decisions, tasks, the review queue, recent notes, and the daily-notes view. Created only when absent. |
| `Views/Projects.base` | Selects `note.type == "project"` and excludes `Templates`. |
| `Views/Active decisions.base` | Selects `note.type == "decision"` with `note.status == "active"` and excludes `Templates`. |
| `Views/Review queue.base` | Selects `note.status == "candidate"` and excludes `Templates`. |
| `Views/Tasks.base` | Selects `note.type == "task"`, grouped by `note.task_status`. |
| `Views/Recent notes.base` | Sorts the user-facing `updated` property descending, with the second `file.mtime` sort acting as the fallback for plain notes that have no `updated` property. Also contains a `Daily notes` view filtered to the `Daily` folder. |
| `Views/Project notes.base` | Filters on `note.project == this.file.asLink()` and excludes the embedding page with `file.path != this.file.path`, so a project page lists its own notes. |
| `Views/Projects.canvas` | Optional navigation Canvas: unique node IDs and file nodes that resolve to installed assets. |
| `Templates/*.md` | Native templates for project, decision, architecture, research, reference, lesson, playbook, concept, fact, preference, task, person, meeting, daily, and session notes. |

All generated filenames are valid on Windows and Linux, preserve Unicode
(including Norwegian letters), and never use a UUID as a collision fallback.
Project pages are written from the real project display name and path; the page
links to itself with `project: "[[Projects/<name>/<name>]]"` and embeds
`![[Views/Project notes.base]]`, so membership updates without rewriting a
human's overview.

### Bases rendering baseline

Only built-in Bases layouts are used. Table and card layouts shipped in Obsidian
1.9 are the compatibility baseline; list views arrived in 1.10 and Kanban views
in 1.14, and maps require the Maps plugin. A base whose filter or sort
configuration is not understood by the installed Obsidian release degrades to
the raw YAML view rather than corrupting the file. YAML parsing success alone
does not prove rendering; the manual check below is the release gate.

`Views/Project notes.base` is meaningful when it is embedded in a project page:
`this.file` then refers to that page, and `this.file.asLink()` compares against
the link-valued `project` property. Opened directly, it reflects the base file
itself and shows nothing.

### Templates

The core **Templates** plugin can apply any file under `Templates/` to a new
note. Template bodies use only supported core variables (`{{title}}`,
`{{date:YYYY-MM-DD}}`). They intentionally contain no static identifier and no
`{{uuid}}` variable, because core Templates cannot generate one and a plain note
stays usable until it is explicitly adopted with `brain_review(action: "adopt")`.
A note created by any template is an ordinary Markdown file; the service does not
rewrite or adopt it unless asked.

## Recommended Obsidian settings

Enable these core plugins/settings; this document does not change them for you.
The installer never edits `.obsidian`, so existing user settings are preserved.

- **Templates** — choose the `Templates` folder.
- **Daily notes** — set the new-file location and format to `Daily/YYYY-MM-DD.md`.
  To change an existing configuration is a user action; the service only suggests
  this path.
- **Properties** — show the properties view so `type`, `status`, `project`,
  `task_status`, `tags`, `aliases`, `created`, and `updated` are readable.
- **Backlinks** — show linked mentions and backlinks.
- **Outgoing links** — show resolved and unresolved outgoing links.
- **Graph view** — browse the relationship graph.
- **Bases** — render `.base` files and embeds.

## Renames

Renames performed inside Obsidian can update internal links automatically when
the matching setting is enabled; that is Obsidian-local behavior. Renames and
moves performed by the service are different: they are journaled, rewrite only
genuine resolvable references while preserving aliases and fragments, and are
covered by the Task 8 move contract. Do not treat Obsidian's link maintenance as
the service's migration strategy.

## Agent writing policy

Agents that write to the vault follow these rules:

- Resolve an existing note before creating a near-duplicate; prefer an existing
  canonical link over a new page.
- Title files descriptively so the generated filename is readable, and keep the
  collision suffix human-readable rather than an opaque identifier.
- Prefer canonical vault-relative links (`[[canonical/path|alias]]`) and
  meaningful aliases. A bare alias is not an unambiguous file target.
- Use the `type` property for the category and a small set of topic `tags`; do
  not encode the category as a tag.
- Record supported sources in the `## Sources` section instead of machine-only
  blobs.
- Preserve explicit supersession; never infer approval or supersession from a
  model score.
- Do not create an "adopt Laya" decision note merely because the implementation
  plan exists.

## Manual GUI check

Check Reading view, Properties, Bases, backlinks, heading/block links, alias
display, and a rename in the user's supported Obsidian version before relying on
the Bases configuration in production.

Status: **NOT RUN** in this environment. No supported Obsidian desktop build is
available on the headless Linux host, so the GUI check could not be executed
without faking evidence.

Exact steps that remain for the release gate:

1. Install a supported Obsidian desktop release and open a disposable generated
   vault (run `node dist/cli.js obsidian init --create-only --vault <vault>`).
2. Record the exact Obsidian version in this file.
3. Confirm Reading view, the Properties panel, each `.base` view (including
   `Recent notes` sorting and `Project notes` when embedded in a project page),
   backlinks, a heading/block link, alias display, and an in-app rename.

Until this is recorded, the manual Bases-rendering gate remains open.
