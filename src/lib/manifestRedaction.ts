import { redactDisplayText } from './securityPolicy.js';

const LOCAL_PATH_KEYS = new Set([
  'sourceFilePath',
  'sourcePath',
  'sourceKeynotePath',
  'sourceKeynoteLocalPath',
  'exportedPdfPath',
  'exportedPdfLocalPath',
  'selectedKeynoteAppPath',
  'selectedKeynoteAppLocalPath',
  'keynoteAppPath',
  'summaryPath',
  'exportSummaryPath',
  'exportSummaryLocalPath',
]);

function collectLocalPaths(value: unknown, paths: string[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectLocalPaths(entry, paths));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (LOCAL_PATH_KEYS.has(key) && typeof entry === 'string') paths.push(entry);
    collectLocalPaths(entry, paths);
  }
}

function redactValue(value: unknown, sensitivePaths: string[]): unknown {
  if (typeof value === 'string') return redactDisplayText(value, sensitivePaths);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, sensitivePaths));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !LOCAL_PATH_KEYS.has(key))
      .map(([key, entry]) => [key, redactValue(entry, sensitivePaths)])
  );
}

export function redactLocalPathsForResource(value: unknown): unknown {
  const sensitivePaths: string[] = [];
  collectLocalPaths(value, sensitivePaths);
  return redactValue(value, sensitivePaths);
}
