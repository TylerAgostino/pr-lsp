# Pull Request Review (Zed extension)

Review GitHub pull requests and respond to review feedback directly in your
Zed buffers. When the checked-out branch has an open PR, its inline review
comments appear as wavy-underline highlights in the affected files, with
rich tooltips, quick-fix menus (react / resolve / reply / open on GitHub),
and file-based draft flows for writing new comments and submitting reviews.

The editor UX is driven by a standalone LSP server, so it can also be run
outside Zed — see [Using with editors other than Zed](#using-with-editors-other-than-zed-kiro-vs-code-) below.

## How it works

The extension is a thin WASM adapter that launches a companion language
server (`pr-review-lsp`, published to npm) with Zed's bundled Node. All
editor UX is delivered over standard LSP, so the heavy logic stays in
TypeScript and updates land without extension republishing:

| Editor surface        | LSP mechanism                                        |
| --------------------- | ---------------------------------------------------- |
| Comment highlighting  | `textDocument/publishDiagnostics` (information)      |
| Comment tooltips      | `textDocument/hover` (author, time, reactions, body) |
| Reply / react / resolve | Code actions (`Ctrl-.` on a commented line)        |
| New comment / reply / review submission | Draft files under `.pr-review/` — edit, then save **or** run `pr-review.postDrafts` |
| Command palette actions | `workspace/executeCommand`                       |
| "PR: N comments" badges | Inlay hints (toggle via `inlayHints`)              |

Only GitHub is supported (github.com and GitHub Enterprise via
`githubBaseUrl`). GitLab/Bitbucket are out of scope.

## Requirements

- Zed (latest stable). Buffer-level PR features require Zed's support for
  LSP `workspace/executeCommand` and `window/showDocument` (1.21+).
- A GitHub token, resolved in this order:
  1. `GITHUB_TOKEN` in your shell environment
  2. `GH_TOKEN` in your shell environment
  3. [`gh`](https://cli.github.com) fallback — the adapter runs
     `gh auth token` when neither variable is set
- No token is required to use Zed normally: the server stays silent until
  one is available.

## Extension capabilities

The capabilities this extension uses are declared in `extension.toml`
(`gh auth token` for the token fallback, `npm:install` for the language
server package). Nothing to configure — see
[Extension Capabilities](https://zed.dev/docs/extensions/capabilities)
for how Zed surfaces these to you.

## Settings

```json
"lsp": {
  "pr-review-lsp": {
    "settings": {
      "githubBaseUrl": "",        // GHE root, e.g. "https://ghe.example.com"
      "inlayHints": true,         // "◈ PR: N comments" badges
      "draftsDir": ".pr-review", // where draft files live (auto-added to .git/info/exclude)
      "pollIntervalMs": 30000     // background refresh interval
    }
  }
}
```

New comments, resolutions, and branch switches are picked up
automatically on the poll interval (and on save / when opening files).

## Commands

Run via Zed's LSP command picker (see "Triggering these commands in Zed"),
or from code actions on a commented line. The last two commands take
arguments (comment id) and are therefore only offered as code actions:

| Command id                       | What it does                                  |
| -------------------------------- | --------------------------------------------- |
| `pr-review.refresh`              | Re-fetch PR state and republish annotations   |
| `pr-review.summary`              | PR overview (messages shown via notifications)|
| `pr-review.draftReview`          | Create a review draft (comment/approve/request changes) |
| `pr-review.createCommentDraft`   | Comment on the selected range (from code action) |
| `pr-review.react`                | Add a reaction to the comment under the cursor |
| `pr-review.resolveThread`        | Resolve / unresolve the thread                |
| `pr-review.viewOnGithub`         | Open the comment's permalink in the browser   |
| `pr-review.listComments`         | Write & open an all-comments listing across every file |
| `pr-review.postDrafts`           | Post every edited draft on disk (explicit signal; see "Draft files") |
| `pr-review.deleteComment`        | Delete your review comment or reply (code action "Delete comment (you)") |
| `pr-review.removeReaction`       | Remove your own reaction (code action "Remove 👍 (you)" etc.) |

### Triggering these commands in Zed

Zed does not list language-server commands in the palette individually.
Zed ≥ 1.21 ships a dedicated picker: run
**`lsp command selector: toggle`** (search "lsp command" in the palette)
with the cursor in a file this server handles — it opens
"Select a language server command…" listing `pr-review.refresh`,
`pr-review.summary`, `pr-review.draftReview`, `pr-review.listComments`,
`pr-review.postDrafts`,
and friends; selecting one executes it immediately. The picker only
appears when the active buffer actually has servers advertising commands.
Optional key binding (`keymap.json`):

```json
[{ "context": "Workspace", "bindings": { "f1": "lsp_command_selector:toggle" } }]
```

Every command also remains reachable without the picker: the code-action
menu on a comment line covers react/reply/resolve/view, and selection →
"Add review comment" covers new comments.

## Draft files

Writing is deliberately file-based so you can compose in the editor:

1. Trigger a draft (code action or palette command).
2. A Markdown file appears under **`.pr-review/`** at the project root,
   with frontmatter (`type`, `pr`, and for inline comments `path` +
   `line`, or `event` for reviews) and a seed body. The folder is added
   to `.git/info/exclude` automatically, so it never appears in
   `git status` and is never committed.
3. Edit it, then post it with either explicit signal:
   - **Save the file** in the editor, or
   - run **`pr-review.postDrafts`** (palette), which posts every edited
     draft on disk — useful when your editor doesn't route buffer saves
     to the language server, or you edited drafts outside it.

The server posts, deletes the file, and refreshes annotations. Nothing is
ever posted automatically — untouched seed templates are ignored by both
paths, so autosave can't post a half-written comment.

If posting fails you'll get an error notification (`pr-review: failed to
post …`) — common causes: a fine-grained PAT without **Pull requests:
Write** permission (reads still work!), or a classic token missing the
`repo` scope. If a draft sits on disk for 45+ seconds after you edited
it, the server also nudges you about it.

### See every comment across all files

Two complementary mechanisms:

- **Project diagnostics**: the server publishes annotations for files even
  when no editor has them open, so Zed's project-diagnostics surfaces
  aggregate PR comments across the whole PR, not just visible buffers.
  Whether closed-file, information-severity entries appear in a given
  client's panel is up to the client — in Zed check
  `editor: project diagnostics`. The listing below never depends on it.
- **`pr-review.listComments`** (palette): writes a Markdown digest of every
  review thread grouped by file — path, `Lnn`, author, first line, reply
  count, resolved/outdated markers, and a GitHub permalink per thread —
  into `.pr-review/` and opens it. Saving it posts nothing; delete the
  file when done.

## Using with editors other than Zed (Kiro, VS Code, …)

Everything this extension shows in Zed is produced by `pr-review-lsp`, a
standard stdio LSP server with no Zed dependency. Any editor that can run
an external language server can use it directly:

```sh
cd server && npm install && npm run build
node "$PWD/dist/server.js" --stdio   # the LSP launch command
```

- **The `--stdio` flag is required** — launched without it the server exits
  with "Connection input stream is not set" (verified against the built
  bundle: with the flag it answers `initialize` with
  hover/code-action/inlay-hint/execute-command capabilities).
- **Auth**: set `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment that
  launches the server. The `gh auth token` fallback lives in the Zed
  adapter, so non-Zed clients need the env var.
- **Settings** (same keys as the Zed `settings` block above) are passed as
  LSP `initializationOptions` in the shape `{ "settings": { ... } }`.

### Kiro CLI — custom LSP config (`lsp.json`)

Kiro CLI supports workspace-scoped custom language servers; the config
below follows the schema documented in Kiro's
[code intelligence docs](https://kiro.dev/docs/tools/code-intelligence/).
From the project root:

```text
/code init
```

`/code init` creates `.kiro/settings/lsp.json` (Kiro CLI auto-loads it on
startup when present). Merge in an entry per language you want reviewed,
since Kiro matches servers by language:

```json
{
  "languages": {
    "rust": {
      "name": "pr-review-lsp",
      "command": "node",
      "args": ["C:/absolute/path/pr-lsp/server/dist/server.js", "--stdio"],
      "file_extensions": ["rs"],
      "project_patterns": [".git"],
      "initialization_options": { "settings": { "inlayHints": true } }
    }
  }
}
```

Copy that entry for each language (change `file_extensions`), then
`/code init -f` and check with `/code status` / `/code logs`. The server
itself is verified to speak LSP over stdio (see above), but this exact
`lsp.json` wiring has not been exercised end-to-end inside Kiro CLI — if
diagnostics arrive but hover or code actions don't, that's a Kiro
custom-LSP limitation, not a server bug.

### Kiro IDE / VS Code — needs a client extension (not shipped yet)

Kiro IDE (Code OSS-based, extensions from Open VSX) and VS Code have **no
built-in way to register an arbitrary external LSP server** — they only
run LSP servers that a client extension registers. No `pr-review-lsp`
client extension exists yet, so there is currently no supported setup in
Kiro IDE/VS Code. A wrapper is a small, well-understood extension
(`vscode-languageclient` around the same `dist/server.js`); if you want
one, open an issue on this repo.

### Neovim / Helix / Sublime / Emacs — standard LSP clients

Neovim (0.10+):

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "rust", "python", "go", "typescript", "javascript" },
  callback = function()
    vim.lsp.start({
      cmd = { "node", "/absolute/path/pr-lsp/server/dist/server.js", "--stdio" },
    })
  end,
})
```

Helix (`~/.config/helix/languages.toml`, attach `pr-review-lsp` to your
language scopes):

```toml
[language-server.pr-review-lsp]
command = "node"
args = ["/absolute/path/pr-lsp/server/dist/server.js", "--stdio"]
```

Sublime Text (LSP package, via `LSP.sublime-settings`) and Emacs
(`lsp-mode`) take the same `node …/dist/server.js --stdio` command in
their client configs.

Feature notes for all non-Zed clients: diagnostics/hover/code actions work
wherever the client renders them; palette commands
(`pr-review.refresh`, `pr-review.draftReview`, `pr-review.summary`) need
the client to expose `workspace/executeCommand`; drafts are always written
to `.pr-review/` even when a client ignores `window/showDocument` —
open and save them manually, or run `pr-review.postDrafts`, and they
post the same way.

## Development

```sh
# 1. Server (TypeScript LSP)
cd server && npm install && npm run build && npm test

# 2. Adapter (WASM)
cargo build --target wasm32-wasip2 --release

# 3. Install as dev extension: point `zed: install dev extension` at this
#    directory, then reload Zed.
```

### Running the server without an npm publish

The adapter installs `pr-review-lsp` from the npm registry at startup. For
local testing before the package is published, install a packed build into
the extension's work directory once — the adapter then keeps running that
local install (registry lookups are only fatal when no server is present):

```sh
cd server && npm pack
npm install --prefix "$LOCALAPPDATA/Zed/extensions/work/pr-review-lsp" \
  ./pr-review-lsp-0.1.0.tgz   # macOS: ~/Library/Application\ Support/Zed/extensions/work/...
```

To iterate on server code against a running Zed: rebuild, copy the bundle
into the extension's work directory, then fully quit and reopen Zed (the
adapter launches the server at startup):

```sh
npm run build
cp dist/server.js "$LOCALAPPDATA/Zed/extensions/work/pr-review-lsp/node_modules/pr-review-lsp/dist/server.js"
```

Rebuild the extension (reload Zed) after changing `src/lib.rs`.

Repository layout:

```
extension.toml   Zed extension manifest (id: pr-review-lsp)
src/lib.rs       WASM adapter: installs + launches the server, forwards env
server/          pr-review-lsp npm package (TypeScript LSP server + tests)
```

Tests run against a local fake GitHub API fixture (`server/test/`), so no
token or network is needed for `npm test`.

## License

MIT (extension code). See `LICENSE`.
