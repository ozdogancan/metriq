import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { findZlibBlobs, is45DegreeBendDescription } from '../src/lib/parser/nwd-core.ts';

assert.equal(is45DegreeBendDescription('ELBOW 45 DEG LR'), true);
assert.equal(is45DegreeBendDescription('Pressed Elbows 45Deg 1.5xD'), true);
assert.equal(is45DegreeBendDescription('ELBOW 45, METRIC LR'), true);
assert.equal(is45DegreeBendDescription('Bend DIN 2605-1-45-3'), true);
assert.equal(is45DegreeBendDescription('ELBOW 90 DEG, ASTM A234 WPB'), false);
assert.equal(is45DegreeBendDescription('PIPE ASTM A312 TP 304L'), false);

// Plant 3D imzası taşıyan akışlar tutulur…
const payload = Buffer.from('PnPGuid metriq parser guard '.repeat(20));
const valid = findZlibBlobs(deflateSync(payload));
assert.equal(valid.length, 1);
assert.deepEqual(valid[0], payload);

// …imza taşımayan (geometri/doku) akışlar sessizce atlanır (bütçe koruması).
const irrelevant = findZlibBlobs(deflateSync(Buffer.from('no marker here '.repeat(30))));
assert.equal(irrelevant.length, 0);

const invalidCandidate = Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff]);
const corruptFlood = Buffer.concat(Array.from({ length: 1_001 }, () => invalidCandidate));
assert.throws(() => findZlibBlobs(corruptFlood), /bozuk sıkıştırılmış akış/);

// 32 MB/akış çıktı tavanını aşan tek akış reddedilir (inflate-bomb koruması).
const inflateBomb = deflateSync(Buffer.alloc(33 * 1024 * 1024, 0x41));
assert.throws(() => findZlibBlobs(inflateBomb), /güvenli çıktı sınırını/);

console.log('parser guards: valid stream, corrupt-candidate flood, and inflate bomb verified');
