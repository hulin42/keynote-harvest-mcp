import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-clean-install-'));

function runNpm(args) {
  const result = spawnSync('npm', args, {
    cwd: temporaryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit ${result.status}.`);
}

try {
  await cp(packageRoot, temporaryRoot, {
    recursive: true,
    filter(source) {
      const relativePath = path.relative(packageRoot, source);
      const firstSegment = relativePath.split(path.sep)[0];
      return firstSegment !== 'dist' && firstSegment !== 'node_modules';
    },
  });

  runNpm(['ci', '--ignore-scripts']);
  runNpm(['test']);
  console.log(`Clean-install rehearsal passed in ${temporaryRoot}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
