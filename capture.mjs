import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Chrome's DOM can exceed spawnSync's pipe buffer once snapshots grow.
// Stream it to disk and read only the root tag needed for screenshot height.
export function captureDomHeight(command, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opshnz-dom-'));
  const file = path.join(dir, 'dom.html');
  let fd;
  try {
    fd = fs.openSync(file, 'w');
    execFileSync(command, args, { stdio: ['ignore', fd, 'ignore'], timeout: 60000 });
    fs.closeSync(fd); fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096), size = fs.readSync(fd, head, 0, head.length, 0);
    const height = +(head.toString('utf8', 0, size).match(/data-h="(\d+)"/) || [])[1];
    return Math.min(4800, height || 2400);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
