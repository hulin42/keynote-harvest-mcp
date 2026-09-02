import path from 'node:path';

export type PathExposureKind =
  | 'local-debug-path'
  | 'redacted-display-name'
  | 'host-route'
  | 'resource-uri'
  | 'public-safe-relative-path'
  | 'internal-output-path';

export type PathExposureMap = Record<string, PathExposureKind>;

export type LocalPathRedactionMode = 'display' | 'local-debug';

export function localPathRedactionMode(value: unknown): LocalPathRedactionMode {
  if (value === undefined || value === 'display') return 'display';
  if (value === 'local-debug') return 'local-debug';
  throw new Error(`Invalid redactionMode: ${String(value)}`);
}

export function pathExposureForMode(pathExposure: PathExposureMap, mode: LocalPathRedactionMode) {
  if (mode === 'local-debug') return pathExposure;
  return Object.fromEntries(
    Object.entries(pathExposure).filter(([, exposure]) => exposure !== 'local-debug-path')
  ) as PathExposureMap;
}

export function redactLocalPath(value: string | null | undefined) {
  return value ? path.basename(value) : undefined;
}

export function toDisplaySourceName(value: string | null | undefined) {
  if (!value) return undefined;
  const basename = path.basename(value);
  return basename.replace(path.extname(basename), '') || basename;
}

export function toHarvestRelativePath(filePath: string, harvestRoot: string) {
  const relativePath = path.relative(path.resolve(harvestRoot), path.resolve(filePath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
  return relativePath.split(path.sep).join('/');
}

export const exportResponsePathExposure = {
  sourceDisplayName: 'redacted-display-name',
  redactedSourceFileName: 'redacted-display-name',
  exportedPdfHarvestPath: 'public-safe-relative-path',
  summaryHarvestPath: 'public-safe-relative-path',
  localDebug: 'local-debug-path',
  exportedPdfLocalPath: 'internal-output-path',
  exportSummaryLocalPath: 'internal-output-path',
} satisfies PathExposureMap;

export const harvestResponsePathExposure = {
  manifestHarvestPath: 'public-safe-relative-path',
  outputHarvestPath: 'public-safe-relative-path',
  localDebug: 'local-debug-path',
  harvestRoot: 'local-debug-path',
  harvestRootDisplayName: 'redacted-display-name',
  outputRelativePath: 'public-safe-relative-path',
  resourceUris: 'resource-uri',
} satisfies PathExposureMap;

export const manifestSourcePathExposure = {
  sourceDisplayName: 'redacted-display-name',
  redactedSourceFileName: 'redacted-display-name',
  redactedExportedPdfFileName: 'redacted-display-name',
  sourceFilePath: 'local-debug-path',
  sourcePath: 'local-debug-path',
  exportedPdfPath: 'internal-output-path',
  selectedKeynoteAppPath: 'local-debug-path',
  localDebug: 'local-debug-path',
} satisfies PathExposureMap;
