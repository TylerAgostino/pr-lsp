# Pull Request Review (Zed extension)

Review GitHub pull requests and respond to review feedback directly in your
Zed buffers. When the checked-out branch has an open PR, its inline review
comments appear as wavy-underline highlights in the affected files, with
rich tooltips, quick-fix menus (react / resolve / reply / open on GitHub),
and file-based draft flows for writing new comments and submitting reviews.

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
| New comment / reply / review submission | Draft files under `.git/pr-review/` — edit, save, auto-posted |
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
[Extension Capabilities](https://zed.dev/docs/extensions/extension-capabilities)
for how Zed surfaces these to you.

## Settings

```json
"lsp": {
  "pr-review-lsp": {
    "settings": {
      "githubBaseUrl": "",        // GHE root, e.g. "https://ghe.example.com"
      "inlayHints": true,         // "◈ PR: N comments" badges
      "draftsDir": ".git/pr-review", // where draft files live
      "pollIntervalMs": 30000     // background refresh interval
    }
  }
}
```

New comments, resolutions, and branch switches are picked up
automatically on the poll interval (and on save / when opening files).

## Commands

Run via the LSP command picker (`workspace: run language server command`)
or, where available, from code actions on a commented line:

| Command id                       | What it does                                  |
| -------------------------------- | --------------------------------------------- |
| `pr-review.refresh`              | Re-fetch PR state and republish annotations   |
| `pr-review.summary`              | PR overview (messages shown via notifications)|
| `pr-review.draftReview`          | Create a review draft (comment/approve/request changes) |
| `pr-review.createCommentDraft`   | Comment on the selected range (from code action) |
| `pr-review.react`                | Add a reaction to the comment under the cursor |
| `pr-review.resolveThread`        | Resolve / unresolve the thread                |
| `pr-review.viewOnGithub`         | Open the comment's permalink in the browser   |

## Draft files

Writing is deliberately file-based so you can compose in the editor:

1. Trigger a draft (code action or palette command).
2. A Markdown file appears under `.git/pr-review/` with frontmatter
   (`type`, `pr`, and for inline comments `path` + `line`, or `event` for
   reviews) and a seed body.
3. Edit it and **save** — the server posts it to GitHub, deletes the file,
   and refreshes annotations.

Inline drafts post as single review comments on save; the review draft
submits the PR-level review with the event from its frontmatter.

## Development

```sh
# 1. Server (TypeScript LSP)
cd server && npm install && npm run build && npm test

# 2. Adapter (WASM)
cargo build --target wasm32-wasip2 --release

# 3. Install as dev extension: point `zed: install dev extension` at this
#    directory, then reload Zed.
```

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
