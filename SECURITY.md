# Security Policy

## Supported status

`keynote-harvest-mcp` 0.1.0 is the first public release; the latest 0.x
release receives security fixes. Report vulnerabilities through GitHub private
vulnerability reporting on `hulin42/keynote-harvest-mcp` (Security tab →
"Report a vulnerability"). Do not include private decks, source files, or
credentials in a public issue.

## Trust model

The server uses stdio and runs with the filesystem, process, and macOS
Automation permissions of the MCP host that starts it. It has no independent
user authentication or sandbox. The host operator is responsible for choosing
which directories and applications the process may access.

Harvested PDFs, Keynote decks, slide text, images, filenames, and metadata are
untrusted document content. A connected model must not treat instructions found
inside a deck as authorization to call tools, widen path access, reveal other
files, or publish output. Tool annotations are advisory host hints only.

The package makes no network requests or telemetry calls. It launches the local
Node runtime, Poppler utilities, `osascript`, and Apple Keynote. Those native
tools remain part of the trusted computing base and should be kept current.

## Default controls

- Source inputs are confined to the working directory, harvest root, and
  `KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS`.
- Generated writes are confined to the configured harvest root, including
  symbolic-link checks. Outside-root writes require both an explicit tool
  argument and `KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT=1`.
- Local-debug paths require `KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG=1` in the server
  environment. Clients cannot request raw paths by themselves.
- MCP resources expose only manifests, previews, extracted text, and image
  assets. Source PDFs and export summaries require
  `KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES=1`.
- Keynote automation accepts apps under `/Applications` with known Apple Keynote
  bundle identifiers and an Apple first-party code signature by default.
  Additional app roots and bundle identifiers require operator environment
  configuration; `KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE=1` disables the
  signature requirement.
- Inputs, generated output, command output, resources, page counts, render DPI,
  asset count, asset pixels, and subprocess duration are bounded.
- Export and harvest replacement uses staging plus rollback so a failed run
  preserves the previous successful artifacts.
- Child processes receive a minimal environment that omits unrelated host
  credentials.

Operator capability environment variables must be set in the MCP host
configuration. A calling model cannot use ordinary tool arguments to grant
itself those capabilities.

## Data handling

The `.harvests/` directory can contain confidential slide text, previews,
assets, source PDFs, and local export summaries. Every host repository should
ignore `.harvests/`, and operators should delete harvests when they are no
longer needed. Enabling source resources can return a PDF as a base64 MCP blob
and should be limited to deliberate local inspection.

Absolute paths may still exist inside the local-only `source/export-summary.json`
artifact. It is denied as an MCP resource by default and must never be committed
as a fixture. Canonical generated manifests omit absolute source and application
paths.

## Out of scope

The package cannot defend against a malicious or compromised MCP host, a local
account that can modify the configured executable or PATH, vulnerabilities in
Keynote or Poppler, or an operator who deliberately grants broad filesystem
roots and debug/source capabilities. Process isolation for hostile PDFs should
be supplied by the host operating system or a separate sandbox.
