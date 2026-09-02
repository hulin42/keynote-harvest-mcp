import path from 'node:path';

// GUI-launched MCP hosts start servers with a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) that misses Homebrew and MacPorts, where
// Poppler is almost always installed.
const FALLBACK_TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

export function augmentedToolPath(currentPath = process.env.PATH ?? '') {
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  const override = process.env.KEYNOTE_HARVEST_POPPLER_PATH;
  const prepend = override ? [path.resolve(override)].filter((dir) => !parts.includes(dir)) : [];
  const append = FALLBACK_TOOL_DIRS.filter((dir) => !parts.includes(dir) && !prepend.includes(dir));
  return [...prepend, ...parts, ...append].join(path.delimiter);
}

export function applyAugmentedToolPath() {
  process.env.PATH = augmentedToolPath();
}
