import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { findZlibBlobs } from '../src/lib/parser/nwd-core.ts';

const payload = Buffer.from('metriq parser guard '.repeat(20));
const valid = findZlibBlobs(deflateSync(payload));
assert.equal(valid.length, 1);
assert.deepEqual(valid[0], payload);

const invalidCandidate = Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff]);
const corruptFlood = Buffer.concat(Array.from({ length: 1_001 }, () => invalidCandidate));
assert.throws(() => findZlibBlobs(corruptFlood), /bozuk sıkıştırılmış akış/);

const inflateBomb = deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x41));
assert.throws(() => findZlibBlobs(inflateBomb), /güvenli çıktı sınırını/);

console.log('parser guards: valid stream, corrupt-candidate flood, and inflate bomb verified');
