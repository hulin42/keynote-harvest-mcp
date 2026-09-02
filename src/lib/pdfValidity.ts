import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Every PDF starts with the literal `%PDF-` version header. This check needs
// no external tools, so it applies even when Poppler is not installed.
export function hasPdfSignature(filePath: string) {
  try {
    const fileDescriptor = openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(5);
      const bytesRead = readSync(fileDescriptor, header, 0, header.length, 0);
      return bytesRead === header.length && header.toString('latin1') === '%PDF-';
    } finally {
      closeSync(fileDescriptor);
    }
  } catch {
    return false;
  }
}

// A structurally complete PDF ends with a cross-reference pointer and the
// end-of-file marker. This catches truncated exports that still start with
// the header, without requiring Poppler.
export function hasPdfStructure(filePath: string) {
  if (!hasPdfSignature(filePath)) return false;
  try {
    const fileDescriptor = openSync(filePath, 'r');
    try {
      const size = fstatSync(fileDescriptor).size;
      const tailLength = Math.min(size, 2048);
      const tail = Buffer.alloc(tailLength);
      const bytesRead = readSync(fileDescriptor, tail, 0, tailLength, size - tailLength);
      const text = tail.subarray(0, bytesRead).toString('latin1');
      return text.includes('startxref') && text.includes('%%EOF');
    } finally {
      closeSync(fileDescriptor);
    }
  } catch {
    return false;
  }
}
