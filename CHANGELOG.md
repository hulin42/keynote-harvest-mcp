# Changelog

## 0.1.0 - 2026-09-02

- Exposes five harvest-first MCP tools: `list_keynote_apps`,
  `export_keynote_to_pdf`, `harvest_keynote_pdf`, `get_harvest_manifest`, and
  `list_harvest_outputs`.
- Exposes versioned manifests, slide previews, extracted PDF text, and
  embedded-image assets through `keynote-harvest://` resources.
- Defines and validates the portable `keynote-harvest-manifest-v1` contract in
  TypeScript, at runtime, and as a distributable JSON Schema.
- Uses the official Model Context Protocol SDK over stdio with protocol
  negotiation and host-compatible newline-delimited JSON-RPC.
- Contains writes and resource reads within the configured harvest root,
  including symbolic-link checks, while redacting local paths from display
  responses by default. Escaping the harvest root requires both the
  `allowOutsideHarvestRoot` argument and the `KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT`
  environment opt-in, so a calling agent cannot escape containment on its own.
- Stages and validates exports and harvests before transactional replacement,
  preserving the previous successful output when a run fails while still
  removing stale slides from successful shorter re-harvests.
- Restricts source inputs, manifest reads, resource paths, debug disclosure,
  source-PDF access, and Keynote application path and identity through
  operator-owned policies rather than client-controlled arguments.
- Supports PDF-first harvesting on macOS and Linux, with optional native
  Keynote-to-PDF export on macOS.
- Hardens GUI-host execution with Node worker resolution, standard Poppler
  search paths, an explicit Poppler override, process-group and Poppler
  timeouts, minimal subprocess environments, input/output/resource quotas,
  page and asset limits, validated tool arguments, and MCP tool annotations.

- Preserves user documents during native export: decks already open in
  Keynote are never closed by the exporter, and only documents the exporter
  opened are closed without saving.
- Verifies exports before they replace a previous PDF: marker checks
  (header, trailing xref/EOF) always apply, pdfinfo confirms a readable
  page count when Poppler is present, and output written after an export
  error or timeout is promoted only when that real verification passes —
  otherwise the previous export is preserved.
- Applies `--max-pages` to embedded-image extraction, bounds preview
  rendering with a per-page pixel budget (`KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS`,
  applied to each page's own dimensions) before Poppler runs, serializes output replacement with a per-destination lock,
  and retains the backup copy with its path in the error if a rollback
  cannot restore previous outputs.
- Validates manifests at runtime by compiling the distributed JSON Schema
  (ajv with full-mode format checks, so impossible calendar dates are
  rejected), plus referential checks the schema cannot express: slide
  counts, identifier uniqueness, and slide/asset cross-references.
- Requires Node.js 22 or newer; Node 20 reached end of life in April 2026.
- Keynote app trust now requires an Apple first-party code signature
  (`codesign` leaf authority "Apple Mac OS Application Signing" or
  "Software Signing" — Developer ID chains are rejected) in addition to an
  allowlisted bundle identifier, since a bundle identifier alone is only a
  claim; `KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE=1`
  restores identifier-only trust for unusual setups.
- Detached background workers enforce the total `KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS`
  budget themselves; background exports report their result through
  `get_harvest_manifest`; job messages and errors are path-redacted.
- Workers remove their staging directory when terminated by SIGTERM/SIGINT
  and sweep stale staging directories for the same destination at start,
  so hard-killed runs no longer leak partial output.
- Tool responses carry a `responseKind` (`harvest-summary`,
  `export-summary`, `manifest-summary`, `job-record`, `job-status`) to make
  clear they are summaries, distinct from the manifest resource; harvest
  jobs record a "Rendering pages" phase from the start.
- Adds `runInBackground` to `harvest_keynote_pdf` and `export_keynote_to_pdf`:
  the call returns at once with a job record and the worker runs detached,
  surviving hosts that abandon long tool calls (Claude Desktop caps every
  call at about four minutes). `get_harvest_manifest` reports the job as
  running with page progress, then returns the manifest; failed jobs surface
  their error. Job records live under `<harvest root>/.jobs/`.
- Streams MCP progress notifications when the caller supplies a
  progressToken: per-page updates during harvests and a time-based
  heartbeat during Keynote exports (`KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS`,
  default 10s), so hosts with reset-on-progress timeouts survive long
  decks.

