# PR Buddy JS

Review Git changes in JavaScript, TypeScript, JSX, and TSX projects. PR Buddy distinguishes code changes from formatting-only edits and reports review findings with file and line locations. It can inspect staged changes, including partial staging, without modifying the index.

## Install

Use **Node.js 22.5 or later**, npm, and Git.

~~~sh
git clone https://github.com/anefiox/pr-buddy-js.git
cd pr-buddy-js
npm ci
~~~

Use `node /path/to/pr-buddy-js/bin/prbuddy.mjs` directly. To install the `prbuddy-js` command locally, run `npm link` from the checkout. The examples below use the linked command.

## Choose what to review

~~~sh
# Review a branch or pull request from its merge base with main
prbuddy-js main HEAD --repo /path/to/my-frontend

# Review exactly what the next commit would contain
prbuddy-js --staged --fail-on warning

# Review branch changes plus local staged, unstaged, and untracked work
prbuddy-js main --uncommitted --json
~~~

For a quick first run on Windows, substitute a path such as `C:/code/my-frontend`.

Run with `--repo PATH` or from the target Git repository. The default base is the first available ref among `origin/main`, `origin/master`, `main`, and `master`. The default head is `HEAD`. An explicit base is useful in repos with a different branch name.

- The default review compares committed changes from the merge base. `--uncommitted` compares the working tree from the merge base and includes new files that Git does not ignore.
- `--staged` compares the index with `HEAD`, including partially staged files. Use it without branch arguments. A first commit is needed for either mode.
- The report distinguishes declaration additions and removals, signature and body changes, module-level changes, and formatting or comment-only edits. Declaration matching is per file, with Git rename detection. JavaScript and TypeScript behavior changes are inferred from syntax.
- Findings cover recognizable credentials, empty catches, debugger statements, skipped or focused tests, TypeScript suppression directives, behavior changes with no test files touched, new npm dependencies, and CI/compiler/lint config changes.
- Use `--json` for automation, `--markdown` for review text, `--sarif` for code scanning, and `--fail-on info|warning|critical` for CI. Exit codes are 0 for a completed review, 1 for findings at or above the selected threshold, and 2 for invalid input or review errors.

Export findings as SARIF 2.1.0. Open the file in a SARIF viewer or upload it to a compatible code-scanning service.

~~~powershell
prbuddy-js main HEAD --sarif > prbuddy.sarif
~~~

SARIF contains finding messages and source locations. The semantic diff is available in the CLI, JSON, and Markdown reports.

## Rule reference

| Rule | Default | What it reports |
| --- | --- | --- |
| PRB001 | Warning | Newly added empty catch block |
| PRB005 | Warning | Added TypeScript checking suppression |
| PRB010 | Critical | A possible hard-coded credential |
| PRB011 | Warning | Added `debugger` statement |
| PRB101 | Warning | Changed behavior without a touched test file |
| PRB103 | Warning | Skipped, focused, or TODO test |
| PRB201 | Info | Changes to supported CI, compiler, lint, or PR Buddy configuration |
| PRB202 | Info | Added npm dependency. Online mode can raise this to a warning. |
| PRB301 | Warning | Unused module-local function or class |
| PRB302 | Warning or info | Exact or near-duplicate function body |
| PRB900 | Warning or info | Invalid or unused inline suppression |

### CI example

Check out enough Git history to resolve the base ref and merge base. With both repositories checked out and the tool's dependencies installed, run a review from the application checkout.

~~~sh
node /path/to/pr-buddy-js/bin/prbuddy.mjs origin/main HEAD --fail-on warning --markdown
~~~

The CLI writes the report to standard output and still exits with status 1 if that report crosses the threshold. For SARIF, redirect standard output to a file. Run the CLI with `--help` to see the accepted flags.

### Review configuration

Save a `prbuddy.json` at the Git repository root. Comments and trailing commas are accepted.

~~~jsonc
{
  "ignore": ["fixtures/", "**/*.generated.ts"],
  "failOn": "warning",
  "rules": {
    "PRB011": "info",
    "PRB202": "off"
  }
}
~~~

Rule values are `on`, `off`, or a severity. Use forward slashes in ignore globs. A pattern with no slash matches at any depth, and a trailing slash matches a directory from the repository root.

PR Buddy loads the configuration from the selected base branch or commit. For `--staged` it loads the config from `HEAD`. To try a local config, pass `--config PATH`. An explicit `--fail-on` overrides `failOn`.

### Inline suppressions

~~~ts
// prbuddy-ignore PRB011: Breakpoint used by the local debugger fixture.
debugger;
~~~

A standalone comment applies to the following line. A trailing comment applies to its own line. Use `prbuddy-ignore-file` for the entire file, and separate multiple IDs with commas. JS and TS use source comments. Other text files support standalone `#`, `//`, and HTML comments.

PR Buddy reports suppressed findings with their reasons and excludes them from `--fail-on`. SARIF marks them as in-source suppressions. Added directives with unknown rules, missing reasons, or no matching findings produce PRB900.

### Unused module-local declarations

PRB301 flags newly added, unexported top-level functions and classes in ES modules when no reference resolves to the declaration outside its own body. It recognizes JSX references, shorthand properties, and export lists. Test files, global scripts, decorated declarations, and modules with direct calls to `eval` are skipped. Prefix an intentionally unused name with `_` or use a documented suppression.

### Duplicate functions

PRB302 checks newly added functions and methods against code in the Git snapshot under review. Exact copies produce a warning. Similar bodies between 40 and 1,200 tokens produce an informational finding at 80% overlap or higher, measured using sequences of three adjacent tokens. Both checks require matching parameter tokens and ignore formatting and comments. It compares the index for staged review, the head tree for commit review, and actual tracked and untracked files for working-tree review. Tests, source files larger than 1 MiB, and ignored or generated folders are skipped.

### npm registry checks

Pass `--online` to look up newly added registry dependencies in the public npm registry. It sends eligible package names, including scoped names, to `registry.npmjs.org`. Version ranges are evaluated locally. Existing dependencies, local files, Git URLs, workspaces, and npm aliases skip lookup.

PRB202 warns if a package or matching version is missing, or if all matching published versions are deprecated. Network errors and timeouts leave the finding at its offline severity. The registry may return missing for private packages. Omit `--online` to keep all dependency review local.

Unused-export detection remains outside this release.

## Integrate with Code to Life JS

[Code to Life JS](https://github.com/anefiox/code-to-life-js) can run this checkout to show findings on a dependency graph. Clone the repositories as sibling folders and run `npm ci` in both. For a different layout, point Code to Life at this CLI with `PRBUDDY_JS_ENTRY`.

## Development

Run `npm test` from the checkout. Tests use temporary Git repositories and cover committed, staged, and working-tree reviews. Registry-response tests use local fixtures.

This is the JavaScript and TypeScript companion to the original [PR Buddy](https://github.com/anefiox/pr-buddy).
