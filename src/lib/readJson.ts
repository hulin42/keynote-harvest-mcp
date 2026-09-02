import { readFile, stat } from 'node:fs/promises';

const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;

export async function readJson<T>(filePath: string, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) throw new Error('JSON input is not a file.');
  if (fileInfo.size > maxBytes) {
    throw new Error(`JSON input is ${fileInfo.size} bytes, over the ${maxBytes}-byte JSON limit.`);
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}
