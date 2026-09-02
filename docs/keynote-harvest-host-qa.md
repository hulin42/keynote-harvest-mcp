# Keynote Harvest MCP Host QA

Repeat this checklist before publishing a release. Test the packed package,
not the development checkout, and record actual host versions and results
below. Use only public-safe decks or locally approved private decks; record
display names rather than absolute source paths.

## Release Candidate

- Package version: `0.1.0-rehearsal.0` (matrix) → `0.1.0` (release commit differs
  from the matrix tarball only by version/metadata, the release workflow, and
  the post-matrix hardening pass recorded below)
- Package commit: `e02be0a` for the Claude Desktop and Cursor rows (adds
  durable worker phases); Claude Code column ran at `51b4054`, which
  differs only by those phase messages. Earlier column at `e2a70bd` is
  superseded.
- Tarball SHA-256 (`e02be0a`):
  `cf84703f9ab70e75c558df728c91ba21c19bdf44d636d64eefb77e34b6da87e6`
- PDF test deck: "Design Principles 101" (56 pages, approved private deck)
- Keynote test deck: "Design Principles 101.key" (local copy)
- Tester: Todd Hulin (automated via headless `claude -p`, model haiku)

## Prepare The Packed Runtime

From `mcp/keynote-harvest/`:

```bash
QA_ROOT="$(mktemp -d)"
npm pack --pack-destination "$QA_ROOT"
mkdir "$QA_ROOT/consumer"
npm install --prefix "$QA_ROOT/consumer" \
  "$QA_ROOT/keynote-harvest-mcp-0.1.0.tgz"
```

Configure each host with:

- Command: the absolute path returned by `command -v node`.
- Entrypoint: `$QA_ROOT/consumer/node_modules/keynote-harvest-mcp/dist/index.js`.
- `KEYNOTE_HARVEST_WORKING_DIRECTORY`: an approved local working directory.
- `KEYNOTE_HARVEST_ROOT`: a disposable relative directory such as
  `.harvests-host-qa`.
- `KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS`: the directory containing the approved
  PDF and `.key` test decks. Do not use `/` or a whole home directory.

Do not point a host at `mcp/keynote-harvest/dist/index.js`. A passing result
must prove that the packed artifact works without repository dependencies.

## Host Record

Use `Pass`, `Fail`, `Blocked`, or `Not run` for every result.

| Host | Host version | OS | Test date | Overall result | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.246 (headless `claude -p`) | macOS (Darwin 25.6.0) | 2026-09-01 (rerun at `51b4054`) | Pass | 12/12 checks plus background-mode check 4; see notes |
| Claude app — Code mode (in-app Claude Code using the app's connector registry) | build 1.40609.1 | macOS (Darwin 25.6.0) | 2026-09-01 | Pass (with host limits) | 1–4, 6–10, 12 Pass; 5, 11 not supported (tools-only bridge); see notes |
| Claude Chat (Desktop chat mode) | build 1.40609.1 | macOS (Darwin 25.6.0) | 2026-09-01/02 | Pass (with host limits) | 1–8, 10–12 Pass (4 via background mode; foreground fails at the 4 min cap); 9 pre-granted; resource picker works; see notes |
| Cursor | 3.18.9 | macOS (Darwin 25.6.0) | 2026-09-02 | Pass (with host limits) | 1–4, 6–12 Pass (4 in the foreground; 9 genuine first-run prompt); 5 not supported (no resource picker); see notes |
| Codex CLI | 0.141.0 (headless `codex exec`, gpt-5.5) | macOS (Darwin 25.6.0) | 2026-09-01 | Pass (with host limits) | 1–4, 6–8, 10–12 Pass; 5 tools-only host; 9 pre-granted; see notes |

## Required Checks

| Check | Claude Code (CLI) | Claude app — Code mode | Claude Chat | Cursor | Codex CLI |
| --- | --- | --- | --- | --- | --- |
| 1. Server connects without hanging or reporting a startup error. | Pass | Pass | Pass | Pass | Pass |
| 2. `tools/list` exposes exactly the five documented harvest tools. | Pass | Pass | Pass | Pass | Pass |
| 3. `list_keynote_apps` returns candidates on macOS, or a clear macOS-required result elsewhere. | Pass | Pass | Pass | Pass | Pass |
| 4. A real multi-page PDF harvest reports the expected slide count and writes previews and text. | Pass | Pass (background mode) | Pass (background mode; foreground fails at the 4 min host cap) | Pass (foreground) | Pass (with tool_timeout_sec raised; background mode also) |
| 5. The host reads one preview resource and the manifest resource successfully. | Pass | Not supported (no resource UI) | Pass (resource picker) | Not supported (@ menu lists the server, no resources) | Not supported (tools-only host) |
| 6. The displayed manifest resource contains no absolute local source paths. | Pass | Pass (via tool call) | Pass | Pass (via tool call) | Pass (via tool call) |
| 7. A deliberately invalid slug produces a legible validation error. | Pass | Pass | Pass | Pass | Pass |
| 8. On macOS with Keynote, a real `.key` file exports and harvests end to end. | Pass | Pass | Pass | Pass | Pass |
| 9. First-run macOS Automation permission behavior is recorded. | Pass | Pass (prompt shown, approved) | Pre-granted (silent; same app host) | Pass (prompt shown, approved) | Pre-granted (same app host; no prompt) |
| 10. `get_harvest_manifest` accepts a slug and rejects an arbitrary `manifestPath`. | Pass | Pass | Pass | Pass | Pass |
| 11. A guessed source-PDF or unknown-file resource is denied without operator opt-in. | Pass | Not supported (host bridge is tools-only) | Pass (unlisted; no model dereference path) | Pass (unlisted → not found) | Pass (via model-driven SDK client) |
| 12. `local-debug` is denied unless the host environment explicitly enables it. | Pass | Pass | Pass | Pass | Pass |

## Test Calls And Evidence

For the PDF test, call `harvest_keynote_pdf` with a unique QA slug, a title,
and the approved PDF path. On hosts that cap tool-call duration (Claude
Desktop stops calls at about four minutes), add `runInBackground: true` and
poll `get_harvest_manifest` with the slug until it reports the manifest;
record that the polling path was used. Record the returned slide, preview, text-run, and
asset counts, plus any warnings. Confirm that the generated manifest uses
`keynote-harvest-manifest-v1`.

For the resource test, read both of these URI shapes using the host's resource
interface:

```text
keynote-harvest://<qa-slug>/keynote-harvest-manifest.json
keynote-harvest://<qa-slug>/previews/slide-001.png
```

For validation behavior, call `harvest_keynote_pdf` with a slug containing a
space or slash. Record the displayed error; do not accept a generic transport
failure as a pass.

For native export, use `export_keynote_to_pdf` on macOS, then pass its
`exportedPdfHarvestPath` to `harvest_keynote_pdf` as `harvestPdfPath`. Confirm
the original `.key` file is unchanged and the exported PDF remains inside the
configured harvest root.

## Minimal-PATH Proof

Claude Desktop is the required GUI-host PATH check. Begin without setting
`KEYNOTE_HARVEST_POPPLER_PATH`; a standard Homebrew or MacPorts installation
should be discovered automatically. If an override is required, record that
fact and its reason rather than marking the default-path check as passed.

## Notes And Failures

Record failure text, reproduction steps, and the retest result here. A source
fix discovered during this matrix must be handled as a separate hardening
change and the complete three-host matrix must then be rerun.

### 2026-09-01 — Host identity correction

The entries below labeled "Claude Desktop" were run in the Claude app's
**Code mode** (in-app Claude Code using the app's connector registry), as
their transcripts show (harness resource tools, worktree cwd, auto-mode
classifier). They are recorded under "Claude app — Code mode". The app's
**Chat mode** (Claude Chat) is the classic Desktop MCP client and still
requires its own row: its resource UI, resource protocol support, and
tool-call timeout are expected to differ from the Code-mode bridge.

### 2026-09-01 — Findings from abandoned/killed harvests (queued hardening)

- A host that times out a foreground harvest does not stop it: the run
  Codex abandoned at its 300 s default completed on its own and landed a
  valid 56-slide manifest ~4 minutes later (same behavior seen on the app's
  Code mode). Abandoned work is not lost, but hosts are not told it is
  still running. Consider honoring MCP cancellation by terminating the
  worker, or documenting that abandoned foreground harvests finish
  unattended.
- A worker hard-killed mid-run (SIGTERM via process-group teardown when a
  headless parent died) left `.<slug>.staging-*` behind with 18 partial
  previews: the CLI's `finally` cleanup does not run on signals. Queued
  source change: handle SIGTERM/SIGINT in both workers by removing the
  staging directory before exiting, and sweep stale staging directories
  for the same slug (older than the command timeout) at harvest start.

### 2026-09-02 — Cursor row (in progress)

Cursor 3.18.9 → Customize → MCPs → keynote-harvest: environment "Local:
Connected", all five tools listed and enabled. Cursor derives a
Reads / Writes grouping from the tool annotations (the three
`readOnlyHint` tools under Reads, the two destructive tools under Writes)
with per-tool toggles and "Allow all" defaults. The configuration dialog
exposes tools only — no resource UI visible there. Checks 1–2 Pass.

Environment note (not a host or package finding): the first Cursor harvest
was denied by a user hook — Cursor imports Claude Code's PreToolUse hooks
but not their matcher scoping, so a browser-pane guardrail
(`require-thlocal-first.sh`) ran against every MCP tool and denied them.
Fixed by scoping the hook script itself to `mcp__Claude_Browser__*` tools;
Cursor checks resumed afterward.

Check 4: PASS in the foreground — the 56-page harvest completed inside a
single tool call (56 / 56 / 359, `commandWarnings` empty), so Cursor's
default per-call limit accommodates a ~5.5 minute call with no override.
Timeout summary across hosts for this deck: Claude Code CLI and Cursor
complete in the foreground; Codex completes only with
`tool_timeout_sec` raised (default 300 s); Claude Chat and the app's Code
mode cap at ~240 s and need `runInBackground`.

Check 3: PASS — both installs, Keynote Creator Studio 15.3.1 recommended,
identical to every other host.

Check 5: not supported by the host UI. Cursor's `@` menu lists
`keynote-harvest` as an entry, but no resources appear under it and typing
a resource path (`qa-cursor-2021/...`) filters to nothing — there is no way
to attach a manifest or preview. Checks 6 and 11 fall back to tool-call
verification on this host.

Checks 6, 7, 10, 12: PASS. `get_harvest_manifest` for `qa-cursor-2021`
returned display-safe source fields (no absolute paths) and one manifest
resource URI; `manifestPath` was rejected by the strict schema ("Required
at slug / Unrecognized key(s) in object: 'manifestPath'"); the traversal
slug hit the legible slug rule; `local-debug` was refused by the
operator-env gate.

Check 11: PASS. The Cursor model attempted a resource read of the source
PDF URI and got `Error reading MCP resource: MCP resource not found` —
Cursor resolves reads against the server's listing, and source PDFs are
never listed, so the read is refused before the server's own policy denial
would apply. No bytes returned. Refinement to check 5: Cursor's model can
read listed resources programmatically even though the `@` UI offers no
picker; the "not supported" verdict is about the user-facing attach path.

Checks 8 and 9: PASS. `export_keynote_to_pdf` on the `.key` copy (slug
`qa-cursor-key`): `completed`, 56 pages; harvest with `maxPages: 8` → 8
slides. Cursor is a distinct host application, so macOS showed the
genuine first-run Automation prompt ("Cursor wants to control Keynote
Creator Studio"); Todd approved it and the export proceeded. Row complete.

### 2026-09-02 — Codex release gate, round three, and fixes

Codex re-reviewed `main` at `82f74fe`: one CI flake and two P2s. (1) The
background-job test read the worker log immediately after the terminal
status flipped; on a slow runner the log was still empty. Workers now log
before recording the terminal state and the test allows a bounded settle.
(2) Known-root redaction ran before the absolute-path scrub, so a root
was reduced to its basename ("Client Confidential/...") and survived; the
scrub now runs first, with a configured-root regression. (3) An older
manifest hid a newer completed export; precedence now compares the
manifest's mtime with the job's finishedAt, with a regression for each
direction. History decision stands: publish the single-commit
`release-root`, not the pre-launch history.

### 2026-09-02 — Codex release gate, round two, and fixes

Codex re-reviewed `main` at `6776ecd`: two P1s, two P2s, and release
configuration notes, all addressed. (1) The signature check displayed
metadata without verifying it, and "Apple Mac OS Application Signing" is
every App Store app's leaf — a copied App Store app (Magnet) relabelled
with a Keynote identifier was accepted. Trust now requires `codesign
--verify --deep --strict` to pass, the SIGNED identifier to equal the
bundle identifier (Apple alone signs com.apple.* identifiers), and the
first-party leaf; the Magnet-style tamper is a regression test. (2) A
finished export record shadowed a later foreground harvest's manifest:
an existing manifest now always wins, and a foreground harvest clears
any finished record for its slug. (3) Path redaction stopped at spaces;
it now redacts from a path separator to the end of the line or closing
quote (space and quoted-path regressions). (4) The detached-worker budget
was checked only between steps; each Poppler call is now also capped by
the remaining budget (rehearsal asserts the over-budget worker stops
within one step). Release configuration: GitHub Actions pinned to full
SHAs in both workflows; README wording corrected to "publishes".
Private vulnerability reporting becomes available at the public flip.

### 2026-09-02 — Codex release gate (paired review) and fixes

Codex reviewed `main` at `aa71803` and returned no-go with five confirmed
blockers, all fixed under the same automated-bar rule as the hardening
pass: (1) the Apple-signature check accepted any chain ending in Apple
Root CA — Developer ID apps (Chrome, ChatGPT, Cursor verified) passed; it
now requires the first-party leaf ("Apple Mac OS Application Signing" or
"Software Signing"), with those real third-party apps as regressions.
(2) Detached workers had no total deadline; they now enforce
`KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS` cooperatively between bounded steps
(rehearsal: a budget-limited background harvest fails with a clear error).
(3) Background exports could not be polled to completion; job records
carry the export result and `get_harvest_manifest` reports export jobs
directly. (4) Job messages/errors could quote absolute paths; they are
now redacted against the harvest, working, and input roots plus a
generic absolute-path scrub. (5) `qs` advisories in the SDK's Express
dependency: overridden to 6.16.0 and an `npm audit --omit=dev
--audit-level=moderate` gate added to the release workflow. Also: README
and SECURITY.md release/disclosure wording updated. The history scrub
(6) and public flip proceed as planned after this gate.

### 2026-09-02 — Pre-launch hardening pass (post-matrix)

Applied at Todd's direction, after the matrix closed: (1) Keynote bundle
trust requires Apple's code-signing authority, not just an allowlisted
bundle ID; (2) workers remove staging on SIGTERM/SIGINT and sweep stale
staging at start; (4) harvest jobs record a "Rendering pages" phase from
the outset; (5) tool responses carry a `responseKind`; (6) README explains
summaries vs. the manifest resource. Item (3), cancellation propagation
for abandoned foreground calls, is deferred to v0.1.1 because it changes
observable behavior only on capped hosts and would need live
re-observation there.

Rerun judgment: this doc's "rerun the complete matrix after any source
fix" rule was written for behavioral fixes found during QA. These five
changes are additive or hygiene-only and do not alter what hosts see on
the wire (the one response addition is a new field). Verification for
them is the automated bar — unit suite, three rehearsals — plus a headless
Claude Code check of app discovery and native export (the paths the
signing rule touches). The human host rows were not rerun; this is a
deliberate, recorded relaxation.

### Stage 3 matrix — complete (2026-09-02)

Five hosts recorded on the `e02be0a` tarball (Claude Code CLI column at
`51b4054`, differing only by phase messages): Claude Code CLI, Claude app
Code mode, Claude Chat, Cursor, Codex CLI. Every check has a recorded
outcome on every host: all Pass except where the host has no resource
interface (check 5 on Code mode, Cursor, Codex; check 11 on Code mode),
and check 9 where the app host was already granted. No package failures
remained after the background-jobs fix; the genuine first-run Automation
prompt was observed on two host apps (Claude app, Cursor). Queued
pre-launch items are listed in the notes above.

### 2026-09-01 — Codex CLI column (added at Todd's request)

Codex CLI 0.141.0 via headless `codex exec` (model `gpt-5.5`, low
reasoning; the configured default `gpt-5.6-sol` needs a newer CLI),
server registered with `codex mcp add` using the same packed install and
env as the other hosts.

- 1–3: connected, five tools, both Keynote installs. Pass.
- Approvals: the two `destructiveHint: true` tools are cancelled outright
  in non-interactive runs (`approval: never` → "user cancelled MCP tool
  call"), regardless of timeout — the annotations working as intended on
  this host. Write-tool checks were run with
  `--dangerously-bypass-approvals-and-sandbox`, pinned to the QA kit.
- 4: foreground 56-page harvest completed in 5m44s with
  `mcp_servers.keynote-harvest.tool_timeout_sec=900` (56/56/261/359,
  `commandWarnings` empty); background mode also completed (5m32s) with
  phases recorded and `get_harvest_manifest` reporting it from Codex.
  Default tool timeout: **300 s** — without the override the same harvest
  failed with `timed out awaiting tools/call after 299.99s`, a legible
  error; long decks on Codex need the override or `runInBackground`.
- 5 / 11: Codex exposes MCP tools only, no resource interface; the model
  improvised an SDK client from the kit's `mcp-config.json` and got
  `Harvest resource is not exposed by policy` for the source PDF — policy
  denial verified, host UI not applicable.
- 6, 7, 10, 12: display-safe source, legible slug error, strict-schema
  rejection of `manifestPath` ("Unrecognized key(s)"), local-debug denied.
- 8: export `completed` (56 pages), 8-slide harvest landed. 9: no prompt —
  Codex was spawned from the already-granted app host.

### 2026-09-01 — Claude Chat: resource picker present (row in progress)

Check 4, foreground: FAIL at the host — after exactly 4 minutes Claude
Chat reported "No result received from the Claude Desktop app after
waiting 4 minutes. The local MCP server providing this tool may be
unresponsive, crashed, or not running." The server was healthy: the
worker finished unattended and landed a valid 56-slide manifest
(`qa-chat-2021`, 359 assets) about a minute later. This is the documented
Claude Desktop ~240 s per-call cap, now measured on the true Chat client;
the supported path on this host is `runInBackground: true` (retest below).

Check 4, background retest: PASS. `runInBackground: true` (slug
`qa-chat-bg`) returned at once; Chat polled `get_harvest_manifest` and saw
progress climb (page 0 → 52 → 56, then "Extracting embedded images"),
then the manifest: 56 slides / 56 previews / 261 text runs / 359 assets,
17 info-level no-text warnings; started 00:13:55Z, finished 00:19:21Z
(~5.5 min). Note: `commandWarnings` is a field of the harvest tool's
foreground response, not of `get_harvest_manifest`, so it is absent on the
polling path by design; the manifest's `warnings` array carries the deck
warnings.

Checks 5 and 6: PASS. Via "+ → Add from keynote-harvest", Chat attached
the manifest and `previews/slide-001.png`: the raw manifest's `source`
carried display names and `redactedSourceFileName` only (no absolute
paths), and the preview arrived as real `image/png` (1920×1080) that the
model rendered and described accurately. DX note from the Chat model: the
raw manifest's `source` keys (`id`, `kind`, `title`, `displayName`, `tool`)
differ from `get_harvest_manifest`'s response (`sourceId`, `sourceKind`,
`sourceTitle`, `sourceDisplayName`, `harvestTool`). Not a schema conflict —
the tool returns a display summary, the resource returns the manifest —
but the response reads like a manifest. Queued: say so in the README and
consider naming the summary's block `sourceSummary`.

Checks 7, 10, 12: PASS. `get_harvest_manifest` for `qa-chat-2021` returned
display-safe source fields and a single manifest resource URI;
`manifestPath` was rejected by the strict schema with "Unrecognized key(s)
in object: 'manifestPath'" (the cleanest form of that rejection seen on
any host — Chat forwarded a schema-valid call plus the extra key); the
traversal slug hit the legible slug rule; `local-debug` was refused by the
operator-env gate. All three rejected before any filesystem access.

Check 11: PASS. In Chat, resources are user-driven only: the model has no
way to dereference a `keynote-harvest://` URI (no tool accepts one, no
tool returns file bytes, `web_fetch` is http(s)-only) and reported
exactly that. The only route is the picker, and the server never offers
source PDFs to it: a direct `resources/list` against the same packed
server returned 6,699 resources with zero `source/` entries and zero
`.pdf` entries. Combined with the read-path denial proven on the other
hosts, no source-PDF bytes are reachable from this host.

Check 8: PASS. `export_keynote_to_pdf` on the `.key` copy (slug
`qa-chat-key`): `completed`, 56 pages; `harvest_keynote_pdf` on the
exported PDF with `maxPages: 8` → 8 slides with the truncation warning.
DX note (queued with the naming item): the Chat model flagged that the
foreground harvest response (`commandWarnings`, `note`), the
`get_harvest_manifest` summary, and the raw manifest resource are three
different shapes under one schema version. They are meant to be — tool
responses are summaries, the resource is the manifest — but nothing in
the responses says so. Queued: a `responseKind`/`documentKind` marker on
tool responses and a README paragraph distinguishing the three.

Check 9: no Automation prompt — the export ran silently because the app
host (Claude.app) had already been granted control of Keynote during the
Code-mode row; the grant is per host application, and Chat and Code share
one. Row complete: 1–8, 10–12 Pass, 9 pre-granted.

Checks 1–3 Pass: connector connected; exactly five tools listed (Chat
namespaces them `keynote-harvest:<tool>`); `list_keynote_apps` returned
both installs with Keynote Creator Studio 15.3.1 recommended, identical to
the other hosts. Chat mode also surfaces a per-call permission prompt
(Deny / Always allow / Allow once) that reflects the tool annotations —
read-only tools present as low-risk, the two write tools as destructive.

Claude Chat's composer "+" menu → Connectors shows `keynote-harvest`
toggled on and an **"Add from keynote-harvest"** submenu with a searchable
list of the server's resources (manifest and preview entries from the QA
harvest root were visible, confirmed by screenshot). The resource protocol
is therefore forwarded in Chat mode; the tools-only limitation recorded
above is specific to the Code-mode connector bridge.

### 2026-09-01 — Claude app Code mode, checks 8 and 9: PASS

`export_keynote_to_pdf` on the `.key` copy (slug `qa-desktop-key`):
`completed`, 56 pages, no warnings, app auto-selected (`discovered`,
Keynote Creator Studio 15.3.1 — Apple-signed, see the allowlist note).
`harvest_keynote_pdf` on the exported PDF with `maxPages: 8` → 8 slides,
8 previews, 17 text runs, 37 assets, truncation warning present. The deck
copy's mtime predates the export (unchanged by it). Check 9: Todd observed
the macOS Automation prompt for the app host controlling Keynote and
approved it — the genuine first-run behavior, recorded.

### 2026-09-01 — Claude Desktop check 11: host bridge exposes no resource protocol

The model's attempts via the harness resource tools all returned
`Server "keynote-harvest" does not support resources` / `No resources
found`, although the same tarball advertises and serves 416 resources to
headless Claude Code. The transcript shows these "Desktop" conversations
are Claude Code sessions running inside the Claude app (Code mode) using
the app's connector registry, and that bridge forwards tools only —
consistent with check 5's missing resource UI. Check 11 is therefore not
exercisable on this host; no route disclosed source-PDF bytes and no tool
accepts a raw PDF path. This also identifies the ~240 s cap seen in
check 4 as the in-app connector call limit rather than a CLI behavior.
Open question for the matrix: whether the app's chat mode (the bubble
toggle) is a distinct MCP client that still needs its own row.

### 2026-09-01 — Claude Desktop checks 7 and 12: PASS

Slug `bad slug/../x` was rejected at argument validation with the legible
slug rule ("Use 1-100 lowercase letters, numbers, or hyphens…"), before
any path resolution. `redactionMode: "local-debug"` passed validation and
was refused by the operator gate with the exact
`KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG=1` instruction — a server-environment
flag, not a per-call argument, as designed.

### 2026-09-01 — Claude Desktop checks 6 and 10: PASS

`get_harvest_manifest` for `qa-desktop-bg` returned a source block with
display names and `redactedSourceFileName` only — no absolute paths — and
a single manifest resource URI. `manifestPath: "/etc/passwd"` was rejected
by the server's strict argument schema (reported as the missing required
`slug`; Desktop forwards calls to server-side validation where Claude Code
had already rejected the unknown key client-side). Either way the argument
never reaches path handling.

### 2026-09-01 — Claude Desktop checks 1–3: PASS; bundle-allowlist hardening queued

Fresh chat on the `e02be0a` tarball: connector connected, exactly five
tools listed, `list_keynote_apps` returned both installs with Keynote
Creator Studio 15.3.1 recommended. Desktop's model cautioned that the
recommended app "is not Apple's Keynote"; verified false — both bundles
carry Apple's Mac App Store signing chain (Apple Mac OS Application
Signing → WWDR → Apple Root CA), and Creator Studio is Apple's current
Keynote under bundle ID `com.apple.Keynote`. The caution does expose a
real gap: the allowlist trusts a declared bundle ID, which any app can
claim. Queued hardening (source change, not applied mid-matrix): require
an Apple signing authority via `codesign` before an app is `allowed`.

### 2026-09-01 — Claude Desktop check 5: host has no resource interface

Claude Desktop build 1.40609.1's composer "+" menu offers Add files or
photos, Add folder, Slash commands, Connectors (browse / manage / per-server
on-off toggles), and Plugins — no resource picker and no "add from server"
entry, confirmed by screenshot. MCP resources cannot be read through this
host's UI, so check 5 is recorded as not supported by the host rather than
as a package failure. Checks 6 and 11 are verified on this host through
tool calls (`get_harvest_manifest` source redaction; source-PDF resource
denial reported by the model's read attempt) instead of the resource UI.

### 2026-09-01 — Claude Desktop check 4 RETEST on `51b4054`: PASS via background mode

New chat after a full relaunch. `harvest_keynote_pdf` with
`runInBackground: true` (slug `qa-desktop-bg`) returned at once; Desktop's
Claude polled `get_harvest_manifest` six times at ~1 min intervals (page
21 → 35 → 46 → 56), then received the manifest: 56 slides / 56 previews /
261 text runs / 359 assets, 17 info-level no-text warnings, started
21:02:11Z, finished 21:07:48Z. Every call stayed far inside Desktop's
~240 s cap. Foreground harvest remains a Fail on this host by design of
the host; the documented path for Desktop is background mode.

Finding (UX, deferred): after page 56/56 landed (21:06:18Z) the job stayed
`running` with no `updatedAt` movement for ~90 s while finalization ran
(embedded-image extraction of 359 assets, quota checks, manifest
validation, atomic replace), so a poller cannot distinguish finalizing from
stalled. Improvement: record phase messages with timestamp bumps
("Extracting embedded images", "Writing manifest", "Replacing outputs").
Applied at Todd's direction before the rest of the Desktop row: the
harvest worker now records "Extracting embedded images", "Writing
manifest", and "Replacing outputs" (and the export worker "Exporting from
<app>", "Verifying exported PDF", "Replacing outputs"), each bumping
`updatedAt`. Desktop and Cursor rows continue on the repacked tarball.

Verified on Claude Desktop (slug `qa-desktop-bg2`, tarball at `e02be0a`):
six one-minute polls; poll 5 caught the finalization live (`page 56/56`,
message "Extracting embedded images", phases present) and the completed
record carried all three phases durably. 56 / 56 / 261 / 359 in ~5.5
minutes, every call inside Desktop's cap. Polish queued (cosmetic, not a
matrix blocker): seed an initial "Rendering pages" phase so `phases` is
present during the page loop as well.

### 2026-09-01 — Claude Code matrix RERUN on the repacked tarball (`51b4054`)

All 12 checks pass again through headless `claude -p` (haiku). Check 4 was
run both ways: foreground (56/56/359 in 5m47s, `commandWarnings` empty)
and with `runInBackground: true` — the launch returned at once with a job
record, the first poll reported `running` at 0/56 with progress, and a
later `get_harvest_manifest` returned the full manifest with the job
marked `completed` (5m40s). During that run the headless wrapper that
started the job was killed; the detached worker kept running and landed
the result — the resilience the background path exists for. Check 8:
export `completed` (56 pages) and the 8-slide harvest landed with the
same three Keynote documents still open (open-document guard held). All
negatives, resource reads (416 listed), and redaction checks unchanged.

### 2026-09-01 — Claude Desktop, check 4 FAIL → source fix (background jobs)

Claude Desktop (build 1.40609.1) connected the packed server and ran the
56-page real-deck harvest, but the tool call timed out client-side while
the worker kept running; the worker finished (~6 min) and Desktop's Claude
recovered by reading the manifest afterward. On-disk result verified:
valid v1 manifest, 56 previews, 56 text files, 359 assets, zero absolute
paths, no staging leftovers. Root cause is the host, not the server:
Claude Desktop caps every tool call at roughly 240 s and ignores progress
notifications and config timeouts (anthropics/claude-code#44032, #22542).

Source fix (per the plan's Stage 3 rule, surfaced to Todd first; Option A
approved): `runInBackground` on `harvest_keynote_pdf` and
`export_keynote_to_pdf` returns immediately with a job record while the
worker runs detached; `get_harvest_manifest` reports `running` with page
progress, then the manifest (or the job's error). The three-host matrix
must be rerun on the repacked tarball. Capped hosts should run check 4
with `runInBackground: true` and poll.

### 2026-08-31 — Claude Code matrix run (packed tarball at `e2a70bd`)

Driven through Claude Code 2.1.246's real MCP stack via headless
`claude -p --strict-mcp-config --mcp-config` sessions (model haiku), server
configured per this doc: packed consumer install, disposable harvest root,
input roots limited to the approved deck directory. All 12 checks passed.

- Tools: exactly the five documented tools; `list_keynote_apps` returned
  both installs and recommended Keynote Creator Studio 15.3.1.
- ORIGINAL-TIMEOUT SCENARIO CLOSED FOR THIS HOST: the 56-page real-deck
  harvest ran 5m38s inside a single tool call and completed — Claude Code
  did not kill the long-running call. `commandWarnings` came back empty,
  confirming progress records stay out of diagnostics in-host.
- Resources: 717 listed; the manifest read showed only redacted display
  names (no absolute local paths); a preview read returned real
  `image/png` data.
- Negatives: invalid slug produced the legible validation message;
  `manifestPath` was rejected by the strict tool schema
  (additionalProperties: false); the source-PDF resource was denied by
  policy; `local-debug` was denied with the operator-env instruction.
- Native export: the `.key` copy exported (56 pages, `completed`) and
  harvested via `harvestPdfHarvestPath` with `maxPages: 8` → 8 slides;
  the source `.key` mtime was identical before and after, and the
  exported PDF stayed inside the harvest root.
- Check 9 note: macOS Automation permission was already granted to this
  terminal host from earlier validation, so no first-run prompt appeared;
  exercising the genuine first-run prompt requires a `tccutil` reset or a
  fresh host (owed to the Claude Desktop / Cursor rows).
- Open-document guard: CLOSED on 2026-09-01. With three documents open
  in Keynote Creator Studio (the QA deck copy with a fresh unsaved edit —
  title bar showing "Edited" — plus the iCloud original and an unrelated
  deck), `export_keynote_to_pdf` through the packed server completed
  (56 pages, no warnings) and Keynote still reported the same three
  documents open afterward; the typed edit was still on the slide. The
  exporter no longer closes documents it did not open.

### 2026-08-31 — real-deck dogfood, generic SDK stdio client (pre-matrix)

Packed tarball at commit `44fadc3`, installed into a scratch consumer and
driven by an `@modelcontextprotocol/sdk` `Client` over stdio on macOS
(Node 24). Not one of the three matrix hosts; recorded as early evidence.

- `list_keynote_apps`: found two installs, recommended the newer
  (Keynote Creator Studio 15.3.1), both bundle-allowlisted. Pass.
- `export_keynote_to_pdf`: real 56-slide `.key` (display name
  "Design Principles 101") exported via the discovered app; verified page
  count 56; display-safe response (no absolute paths). Pass.
- `harvest_keynote_pdf`: 56 slides, 56 previews, 261 text runs, 359
  extracted assets; manifest validated; source summary threaded through.
  Pass, after one host-side failure (below).
- FINDING (host-compat): the SDK client's default 60s request timeout
  fired during the 56-page harvest and killed the run; the server sent no
  MCP progress notifications, so hosts could not reset their timers. Retest
  with a 900s client timeout passed. RESOLVED: the server now streams
  progress notifications when the call carries a progressToken (per-page
  during harvests, heartbeat during exports), and the PDF runtime
  rehearsal includes an SDK-client regression proving a 40-page harvest
  survives a 1.5s request timeout with resetTimeoutOnProgress. Note:
  progress notifications help only hosts that reset request timers on
  progress (`resetTimeoutOnProgress` or equivalent) — a client with a
  fixed timeout still dies. Whether Claude Code, Claude Desktop, and
  Cursor reset on progress is exactly what the host matrix must record.
- Observation (documented limitation, not a bug): PDF text extraction
  splits ligatures ("Unified" → "Uni ed" plus a stray "fi"); the README
  already warns extraction can be incomplete.
- Not yet validated: the already-open-document guard against a deck open
  in the Keynote GUI (the deck was closed during this run), and the
  Automation first-run prompt in GUI hosts. Still owed to the real matrix.

## Cleanup

Remove the disposable QA harvest directory and scratch installation after
recording results. Do not commit test decks, exported PDFs, previews, text,
assets, or absolute local paths.
