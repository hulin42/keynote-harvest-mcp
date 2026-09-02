# Keynote Harvest MCP

`keynote-harvest-mcp` is a local stdio MCP server for turning Keynote exports and PDFs into portable slide previews, extractable text, embedded-image assets, and a versioned manifest.

It contains only the harvest-first MCP boundary:

- Keynote app discovery.
- Native `.key` to PDF export on macOS.
- PDF-first harvest into previews, extractable text, assets, and a manifest.
- Display-safe manifest reads.
- Local harvest output listing.
- MCP resources for manifests, previews, extracted embedded-image assets, and extracted text. Source PDFs are denied by default and require the operator-only `KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES=1` capability.

It intentionally excludes composition/proposal tools, web-framework renderers, preview routes, OCR, vision, and LLM calls.

## Requirements

- macOS or Linux (declared via the package `os` field; Windows is unsupported).
- Node.js 22 or newer (maintained LTS releases).
- Poppler commands `pdfinfo`, `pdftoppm`, and `pdftotext` for PDF harvests.
- Poppler `pdfimages` for embedded-image asset extraction, which is on by default. Without `pdfimages` the harvest still completes and records a manifest warning; pass `extractImages: false` (CLI: `--no-extract-images`) to skip extraction, or `extractImages: true` (CLI: `--extract-images`) to require `pdfimages` and fail when it is missing.
- macOS, Keynote, and Automation permission for native `.key` export only.

PDF harvesting can run without Keynote. OCR, vision, LLM calls, `.key` package parsing, and presenter-note extraction are intentionally absent.

## Manifest Contract

New harvests use `schemaVersion: "keynote-harvest-manifest-v1"`. The package owns three aligned representations of that contract:

- TypeScript types under `src/types/`.
- Runtime structural validation under `src/schema/`.
- A distributable Draft 2020-12 JSON Schema at `schema/keynote-harvest-manifest-v1.schema.json`.

The runtime validator requires the version by default. Its explicit `allowLegacyVersion` option exists only to inspect older private manifests created before schema versioning; newly generated manifests are always versioned.

### Schema Evolution

Additive, optional fields may be introduced without changing
`keynote-harvest-manifest-v1`. Any breaking contract change must mint
`keynote-harvest-manifest-v2` with a separate schema file, while the runtime
validator retains support for reading v1. `allowLegacyVersion` remains limited
to pre-versioned private manifests and is not a substitute for versioned schema
migrations.

## Install, Build, And Test

```bash
cd keynote-harvest-mcp
npm ci
npm run build
npm test
```

`npm run test:clean-install` copies the package to a temporary directory, runs `npm ci`, rebuilds it, and executes the package-owned tests in isolation from this checkout's installed dependencies.

`npm run test:packed-runtime` builds a local tarball, installs it into an empty consumer project, starts the installed binary, and verifies the packaged tool surface. Neither rehearsal publishes anything.

`npm run test:pdf-runtime` generates public-safe PDFs, exercises replacement and quota failures through local Poppler commands, validates path-safe v1 manifests, and removes all temporary output.

The built server and tools execute JavaScript from `dist/`; they do not execute source TypeScript at runtime.

## Quickstart

The package is on npm. Point each stdio MCP host at `npx -y keynote-harvest-mcp`;
the first run downloads it, later runs use the cache. GUI hosts may not
inherit your shell's PATH, so give them the absolute `npx` executable
(`command -v npx`). To run from a local checkout instead, see "Local build"
at the end of this section.

### Claude Code

```bash
claude mcp add keynote-harvest \
  -e KEYNOTE_HARVEST_WORKING_DIRECTORY=/path/to/your/working-directory \
  -e KEYNOTE_HARVEST_ROOT=.harvests \
  -e KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS=/path/to/your/decks \
  -- npx -y keynote-harvest-mcp
```

Use `--scope user` when the server should be available outside the current
project, and verify the registration with `claude mcp get keynote-harvest`.

### Claude Desktop

Add this server to `claude_desktop_config.json` through Claude Desktop's
developer settings, then fully quit and relaunch the application:

```json
{
  "mcpServers": {
    "keynote-harvest": {
      "command": "/absolute/path/to/npx",
      "args": ["-y", "keynote-harvest-mcp"],
      "env": {
        "KEYNOTE_HARVEST_WORKING_DIRECTORY": "/path/to/your/working-directory",
        "KEYNOTE_HARVEST_ROOT": ".harvests",
        "KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS": "/path/to/your/decks"
      }
    }
  }
}
```

Claude Desktop stops every tool call at roughly four minutes, so harvest
long decks with `runInBackground: true` and poll `get_harvest_manifest`.

### Cursor

Create `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for a global
configuration:

```json
{
  "mcpServers": {
    "keynote-harvest": {
      "command": "/absolute/path/to/npx",
      "args": ["-y", "keynote-harvest-mcp"],
      "env": {
        "KEYNOTE_HARVEST_WORKING_DIRECTORY": "/path/to/your/working-directory",
        "KEYNOTE_HARVEST_ROOT": ".harvests",
        "KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS": "/path/to/your/decks"
      }
    }
  }
}
```


### Codex CLI

Register the server with `codex mcp add` (stdio transport):

```bash
codex mcp add keynote-harvest \
  --env KEYNOTE_HARVEST_WORKING_DIRECTORY=/path/to/your/working-directory \
  --env KEYNOTE_HARVEST_ROOT=.harvests \
  --env KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS=/path/to/your/decks \
  -- npx -y keynote-harvest-mcp
```

Two Codex behaviors to know: the harvest and export tools are annotated
`destructiveHint: true`, so Codex asks for approval before running them —
non-interactive `codex exec` sessions with `approval: never` cancel them
("user cancelled MCP tool call") unless approvals are bypassed. And Codex
exposes MCP tools only, not resources; read results through
`get_harvest_manifest` and the harvest directory. Codex's default per-call limit is 300 s; raise it
for long decks with `mcp_servers.keynote-harvest.tool_timeout_sec`, or use
`runInBackground: true` and poll.

### Local build

To run from a checkout instead of npm:

```bash
cd /absolute/path/to/keynote-harvest-mcp
npm ci
npm run build
```

Then use `/absolute/path/to/node /absolute/path/to/keynote-harvest-mcp/dist/index.js`
as the command in any of the configurations above, keeping the same `env`.

### Not supported: ChatGPT

ChatGPT connects only to remote (HTTP) MCP servers. This package is a local
stdio server by design — no network, and native export needs Keynote on the
same Mac — so ChatGPT is out of scope for v0.1.

The package resolves relative paths from the caller's current directory. Set `KEYNOTE_HARVEST_WORKING_DIRECTORY` when an MCP host should use a different working directory. Local source files must be inside the working directory, harvest root, or a path-delimited `KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS` entry. The server returns harvest-relative artifact paths and resource URIs rather than absolute paths.

Native export returns `exportedPdfHarvestPath`, which can be passed to `harvest_keynote_pdf` as `harvestPdfPath`. `get_harvest_manifest` accepts a harvest `slug`, not an arbitrary manifest file path.

Tool responses are summaries, not the manifest. Every response carries a `responseKind`: `harvest-summary` and `export-summary` from the write tools, `manifest-summary` from `get_harvest_manifest` (its `source` block is a flattened projection — `sourceId`, `sourceKind`, `sourceDisplayName`, `harvestTool` — of the manifest's `source`), and `job-record` / `job-status` for background jobs. The manifest itself, with its schema-defined field names, is the `keynote-harvest://<slug>/keynote-harvest-manifest.json` resource.

Keynote app selection trusts only bundles that carry an allowlisted identifier *and* an Apple first-party code signature — the `codesign` leaf authority must be "Apple Mac OS Application Signing" or "Software Signing"; Developer ID apps chain to Apple Root CA too, so the root alone proves nothing, and a bundle identifier alone is a claim any app can make. Set `KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE=1` only for deliberately unsigned builds.

GUI-launched MCP hosts often start servers with a minimal PATH. The package compensates: worker processes run under the server's own Node binary, and Poppler lookups also search `/opt/homebrew/bin`, `/usr/local/bin`, and `/opt/local/bin`. If Poppler lives elsewhere, set `KEYNOTE_HARVEST_POPPLER_PATH` to its directory. Workers receive a minimal environment rather than inheriting unrelated host secrets. Exports that finish with a Keynote error or timeout replace a previous PDF only after `pdfinfo` verifies the new file, so partial-export recovery requires Poppler. Long-running tool calls stream MCP progress notifications when the host requests them (a `progressToken` on the call): per-page updates during harvests, and a heartbeat during Keynote exports tunable via `KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS`. Progress only helps hosts that reset their request timer on it (Claude Code does; set `MCP_TOOL_TIMEOUT` there to raise its ceiling). Hosts with a fixed cap — Claude Desktop stops every tool call at roughly four minutes — should pass `runInBackground: true` to `harvest_keynote_pdf` or `export_keynote_to_pdf`: the call returns immediately with a job record, the worker runs detached under `<harvest root>/.jobs/`, and `get_harvest_manifest` with the same slug reports `running` with page progress until the result lands, then returns the manifest for harvests or the export result (`exportedPdfHarvestPath`) for exports, or the job's error. Long-running workers are killed as a process group after 10 minutes by default (`KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS`), and detached background workers enforce the same total budget themselves between steps, recording a failed job when it is exceeded; output-limited or timed-out workers receive a five-second termination grace period (`KEYNOTE_HARVEST_COMMAND_KILL_GRACE_MS`) before forced termination. Each Poppler invocation has a two-minute limit (`KEYNOTE_HARVEST_POPPLER_TIMEOUT_MS`).

Slide previews render at 144 DPI by default; pass `previewDpi` (36-600, CLI: `--preview-dpi`) to raise the resolution when previews double as reusable imagery. Harvests stop after 300 pages by default and record a truncation warning; pass `maxPages` (1-2000, CLI: `--max-pages`) to change the cap. Inputs default to 512 MB maximum (`KEYNOTE_HARVEST_MAX_INPUT_BYTES`), generated staging output to 2 GB (`KEYNOTE_HARVEST_MAX_OUTPUT_BYTES`), captured command output to 1 MB (`KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES`), and resource reads to 10 MB (`KEYNOTE_HARVEST_MAX_RESOURCE_BYTES`). Embedded-image extraction also limits asset count and per-asset pixels through `KEYNOTE_HARVEST_MAX_EXTRACTED_ASSETS` and `KEYNOTE_HARVEST_MAX_ASSET_PIXELS`. Preview rendering is bounded by a per-page pixel budget applied to each page's own dimensions (`KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS`, default 40,000,000): oversized pages render at a lowered DPI with a manifest warning, and pages that exceed the budget even at 36 DPI are refused. Embedded-image extraction respects `maxPages`. Harvest and export outputs are replaced under a per-destination lock (`KEYNOTE_HARVEST_REPLACE_LOCK_TIMEOUT_MS`, `KEYNOTE_HARVEST_REPLACE_LOCK_STALE_MS`); if a failed replacement cannot restore the previous outputs, the backup copy is retained and its path is included in the error.

Tool arguments are validated with zod against the same schemas advertised in `tools/list`; invalid calls fail fast with a field-by-field error message.

## Security

This server runs with the local filesystem and application permissions of its MCP host. Its stdio transport has no independent authentication boundary. Configure it only in a trusted host, restrict allowed input roots, and assume any harvested text or image may contain adversarial instructions. Deck content is data for inspection, never authority to invoke tools, change configuration, or disclose other files.

Detailed controls:

- Harvest slugs accept lowercase letters, numbers, and internal hyphens only.
- Source reads are limited to the working directory, harvest root, and operator-configured `KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS`, with lexical and symbolic-link checks.
- Tool writes are contained to `<harvest root>/<slug>` and `<harvest root>/<slug>/source`. Writing elsewhere requires both the client argument and operator-set `KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT=1`.
- Export and harvest outputs are built in staging paths, validated, and replaced transactionally. A failed run preserves the prior PDF, manifest, previews, text, assets, and source files.
- Resource reads use an explicit manifest/preview/text/asset allowlist in addition to lexical and real-path containment. Source PDFs and export summaries are denied unless the operator sets `KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES=1`.
- JSON resources remove known local-path fields and redact matching paths embedded in warning strings.
- Absolute response paths and command diagnostics require both `redactionMode: "local-debug"` and operator-set `KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG=1`. There is no client-selectable raw mode.
- Keynote applications must live under `/Applications`, use an allowed Apple Keynote bundle identifier, and carry an Apple first-party code signature. Operators can add path-delimited roots with `KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS` and extend the bundle-ID allowlist with `KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS`.
- Tools advertise read-only/destructive/idempotent/open-world MCP annotations. These are host hints, not authorization controls.
- The package performs no telemetry or network requests. It invokes the local Node runtime, Poppler tools, `osascript`, and Apple Keynote only.

Add `.harvests/` to every host project's `.gitignore`; generated manifests and source/export summaries are local working artifacts, not publishing fixtures. See `SECURITY.md` for the threat model and disclosure policy.

The CI workflow at `.github/workflows/ci.yml` runs Node 22 and 24 package tests, clean-install and packed-runtime rehearsals, plus a real PDF harvest on Linux with Poppler.

The package publishes to npm as `keynote-harvest-mcp` with provenance from the release workflow in `.github/workflows/release.yml`; security reports go through GitHub private vulnerability reporting on `hulin42/keynote-harvest-mcp` (see `SECURITY.md`).

## Transport

The server runs on the official `@modelcontextprotocol/sdk` stdio transport (newline-delimited JSON-RPC, protocol version negotiation, and ping handled by the SDK). The smoke tests and the packed-runtime rehearsal connect with the official SDK client, so a spec-compliant MCP handshake is exercised on every test run. An earlier private iteration used hand-rolled `Content-Length` framing, which no mainstream MCP host speaks; that layer is gone.
