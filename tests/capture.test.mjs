import assert from 'node:assert/strict';
import { captureDomHeight } from '../capture.mjs';
assert.equal(captureDomHeight(process.execPath, ['-e', `process.stdout.write('<html data-h="957">' + 'x'.repeat(70 * 1024 * 1024))`]), 957);
assert.equal(captureDomHeight(process.execPath, ['-e', `process.stdout.write('<html data-h="9999">')`]), 4800);
assert.throws(() => captureDomHeight(process.execPath, ['-e', 'process.exit(1)']));
console.log('Chrome capture: oversized DOM streams without ENOBUFS; height bounded; failures propagate.');
