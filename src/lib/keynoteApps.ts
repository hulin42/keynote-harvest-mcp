import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isKeynoteAppPathAllowed, subprocessEnvironment } from './securityPolicy.js';

export type KeynoteAppCandidate = {
  name: string;
  path: string;
  bundleId?: string;
  version?: string;
  modifiedAt?: string;
  exists: boolean;
  allowed: boolean;
  appleSigned?: boolean;
  selected?: boolean;
  recommended?: boolean;
};

export const DEFAULT_KEYNOTE_BUNDLE_IDS = ['com.apple.iWork.Keynote', 'com.apple.Keynote'] as const;

export function allowedKeynoteBundleIds() {
  const configured = (process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_KEYNOTE_BUNDLE_IDS, ...configured]);
}

export function isAllowedKeynoteBundleId(bundleId: string | undefined) {
  return Boolean(bundleId && allowedKeynoteBundleIds().has(bundleId));
}

// A bundle identifier is only a claim — any app can declare com.apple.Keynote.
// Require Apple's signing chain (`codesign` reports an Apple authority) before
// an app counts as allowed. Operators can disable this for unusual setups
// with KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE=1.
// Trust requires three things codesign can prove, not one it merely displays:
// 1. `codesign --verify --deep --strict` succeeds (the bundle is unmodified —
//    a copied app with an edited Info.plist fails this);
// 2. the SIGNED identifier equals the bundle identifier we were shown (a
//    tampered plist cannot change what Apple sealed into the signature); and
// 3. the leaf authority is Apple first-party ("Apple Mac OS Application
//    Signing" for App Store builds, "Software Signing" for system apps).
// Developer ID chains also end in Apple Root CA, so the root proves nothing,
// and "Apple Mac OS Application Signing" alone only proves App Store origin;
// (2) is what ties the signature to Apple's own com.apple.* identifiers.
const APPLE_FIRST_PARTY_LEAF_PATTERN = /^Authority=(Apple Mac OS Application Signing|Software Signing)$/;

export function appleSignatureRequired() {
  return process.env.KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE !== '1';
}

type SignatureReport = { verified: boolean; identifier?: string; leafAuthority?: string };

function readSignature(appPath: string): SignatureReport {
  if (process.platform !== 'darwin') return { verified: false };
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: 60000,
  });
  if (verify.error || verify.status !== 0) return { verified: false };
  const display = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: 10000,
  });
  if (display.error || display.status !== 0) return { verified: false };
  // codesign writes its report to stderr.
  const lines = `${display.stderr}\n${display.stdout}`.split('\n').map((line) => line.trim());
  const identifier = lines.find((line) => line.startsWith('Identifier='))?.slice('Identifier='.length);
  const leafAuthority = lines.find((line) => line.startsWith('Authority='));
  return { verified: true, identifier, leafAuthority };
}

export function isAppleSignedBundle(appPath: string, expectedBundleId?: string) {
  const report = readSignature(appPath);
  if (!report.verified || !report.leafAuthority || !APPLE_FIRST_PARTY_LEAF_PATTERN.test(report.leafAuthority)) return false;
  if (expectedBundleId !== undefined && report.identifier !== expectedBundleId) return false;
  return true;
}

export function isKeynoteBundleTrusted(appPath: string, bundleId: string | undefined) {
  if (!isAllowedKeynoteBundleId(bundleId)) return false;
  return !appleSignatureRequired() || isAppleSignedBundle(appPath, bundleId);
}

export type KeynoteAppDiscovery = {
  candidates: KeynoteAppCandidate[];
  recommendedAppPath?: string;
  warnings: string[];
  configuredAppPath?: string;
  note: string;
};

function readPlistValue(plistPath: string, key: string) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: 5000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function appCandidate(appPath: string): KeynoteAppCandidate {
  const exists = existsSync(appPath);
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const stats = exists ? statSync(appPath) : undefined;
  const bundleId = exists ? readPlistValue(plistPath, 'CFBundleIdentifier') : undefined;
  const appleSigned = exists ? isAppleSignedBundle(appPath, bundleId) : undefined;
  return {
    name: exists ? readPlistValue(plistPath, 'CFBundleDisplayName') ?? readPlistValue(plistPath, 'CFBundleName') ?? path.basename(appPath, '.app') : path.basename(appPath, '.app'),
    path: appPath,
    bundleId,
    version: exists ? readPlistValue(plistPath, 'CFBundleShortVersionString') : undefined,
    modifiedAt: stats?.mtime.toISOString(),
    exists,
    allowed: exists && isKeynoteAppPathAllowed(appPath) && isKeynoteBundleTrusted(appPath, bundleId),
    appleSigned,
  };
}

function compareVersions(a?: string, b?: string) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function discoverKeynoteApps(options?: {
  searchApplicationsDir?: boolean;
  includeMissingDefaults?: boolean;
  configuredAppPath?: string;
}): KeynoteAppDiscovery {
  const searchApplicationsDir = options?.searchApplicationsDir ?? true;
  const includeMissingDefaults = options?.includeMissingDefaults ?? true;
  const configuredAppPath = options?.configuredAppPath ?? process.env.KEYNOTE_APP_PATH;
  const candidatePaths = new Set<string>();
  const defaults = ['/Applications/Keynote.app', '/Applications/Keynote Creator Studio.app'];

  for (const defaultPath of defaults) {
    if (includeMissingDefaults || existsSync(defaultPath)) candidatePaths.add(defaultPath);
  }

  if (searchApplicationsDir && existsSync('/Applications')) {
    for (const entry of readdirSync('/Applications')) {
      if (entry.toLowerCase().includes('keynote') && entry.endsWith('.app')) {
        candidatePaths.add(path.join('/Applications', entry));
      }
    }
  }

  if (configuredAppPath) candidatePaths.add(path.resolve(configuredAppPath));

  const candidates = [...candidatePaths].map(appCandidate).sort((a, b) => a.path.localeCompare(b.path));
  const warnings: string[] = [];
  const existing = candidates.filter((candidate) => candidate.exists && candidate.allowed);
  let recommendedAppPath: string | undefined;

  if (configuredAppPath) {
    const configured = path.resolve(configuredAppPath);
    const configuredCandidate = candidates.find((candidate) => candidate.path === configured);
    if (configuredCandidate?.exists && configuredCandidate.allowed) recommendedAppPath = configured;
    else if (configuredCandidate?.exists) warnings.push(`Configured app is not an allowed Keynote bundle: ${configuredCandidate.name}`);
    else warnings.push(`Configured Keynote app path does not exist: ${configured}`);
  }

  const disallowed = candidates.filter((candidate) => candidate.exists && !candidate.allowed);
  if (disallowed.length > 0) {
    warnings.push(`Ignored ${disallowed.length} Keynote-like app bundle${disallowed.length === 1 ? '' : 's'} with an unapproved bundle identifier or a non-Apple code signature.`);
  }

  if (!recommendedAppPath) {
    const withVersions = existing.filter((candidate) => candidate.version);
    const sortedByVersion = [...withVersions].sort((a, b) => compareVersions(b.version, a.version));
    if (sortedByVersion.length > 0) {
      const best = sortedByVersion[0];
      const tied = sortedByVersion.filter((candidate) => compareVersions(candidate.version, best.version) === 0);
      if (tied.length === 1) recommendedAppPath = best.path;
      else warnings.push(`Multiple Keynote apps share the newest version ${best.version}; pass keynoteAppPath explicitly.`);
    } else if (existing.length > 1) {
      warnings.push('Multiple Keynote-like apps were found but no versions could be compared; pass keynoteAppPath explicitly.');
    } else if (existing.length === 1) {
      recommendedAppPath = existing[0].path;
    }
  }

  return {
    candidates: candidates.map((candidate) => ({
      ...candidate,
      selected: Boolean(configuredAppPath && candidate.path === path.resolve(configuredAppPath)),
      recommended: candidate.path === recommendedAppPath,
    })),
    recommendedAppPath,
    warnings,
    configuredAppPath: configuredAppPath ? path.resolve(configuredAppPath) : undefined,
    note: 'Export tools accept keynoteAppPath to avoid ambiguous AppleScript app-name lookup.',
  };
}
