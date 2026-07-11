/**
 * NWD (Navisworks) Plant 3D MTO parser — TypeScript port of the calibrated
 * Python reference implementation `dwg-takeoff/nwd_mto3.py` (v3 pipeline,
 * customer-answer reconciled 2026-07-09).
 *
 * Pure Node module: the only runtime dependency is node:zlib.
 * Safe for a Next.js API route (Node runtime) — no filesystem access,
 * operates on an in-memory Buffer.
 */
import * as zlib from 'node:zlib';
import { asmeOdToNps, dnToNps } from '../pipe-sizes.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Component {
  klass: string;
  guid: string;
  code: string;
  sub: string;
  line: string;
  lineGuessed?: boolean;
  s1: number | null;
  s2: number;
  qty: number;
  unit: 'M' | 'EA';
  desc: string;
  metric: boolean;
}

export interface SteelMember {
  profile: string;
  lengthMm: number;
  kg: number | null;
}

export interface Fasteners {
  gaskets: number;
  boltSets: number;
  stubEnds: number;
}

export interface NwdStats {
  fileBytes: number;
  blobs: number;
  records: number;
  uniqueComponents: number; // deduped segments, INCLUDING P3dConnector
  classHistogram: Record<string, number>;
  lineCounts: Record<string, number>; // over all items incl. connectors, after continuity fill
}

export interface NwdResult {
  components: Component[]; // non-P3dConnector items, flow order
  steelMembers: SteelMember[];
  fasteners: Fasteners;
  stats: NwdStats;
}

// ---------------------------------------------------------------------------
// Constants (verbatim from nwd_mto3.py)
// ---------------------------------------------------------------------------

const CLASSES = new Set([
  'Pipe', 'Elbow', 'Flange', 'Valve', 'Tee', 'Support', 'P3dConnector',
  'Reducer', 'Cap', 'InlineInstrument', 'BlindFlange', 'Strainer', 'SpacerDisk',
]);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FNUM = /^-?\d+(\.\d+)?$/;
const DIGITS = /^\d+$/;

// DIN 11850-2 / EN 10357 (hygienic metric tube) ODs
const OD2NPS_METRIC: Array<[number, number]> = [
  [19.0, 0.5], [23.0, 0.75], [29.0, 1], [35.0, 1.25], [41.0, 1.5], [53.0, 2],
  [70.0, 2.5], [85.0, 3], [104.0, 4], [129.0, 5], [154.0, 6], [204.0, 8], [254.0, 10],
];
function od2npsMetric(od: number): number | null {
  // Model toleransları bazı Plant 3D exporter'larında ±2 mm'yi aşıyor.
  // Bu eşleme aşağıda ayrıca DN↔NPS tutarlılığıyla doğrulandığı için 2.6 mm
  // false-positive üretmeden 26113'teki 10" FLLB flanşlarını çözüyor.
  for (const [o, n] of OD2NPS_METRIC) if (Math.abs(o - od) <= 2.6) return n;
  return null;
}

// Line-name token filter. NOTE: ^S\d$ deliberately NOT blacklisted —
// short codes S1..S4 can be valid line names in hygienic fixtures.
const LTOKEN = /^[A-Z0-9][A-Z0-9_\-.' ]{3,40}$/;
const LBLACK = /ASME|DIN |BS EN|SCH |PN \d|B36|A105|A106|A312|A403|A234|WPB|304L|316L|KG|^PL$|^BW$|^FL$|^RF$|^New$|^SHOP$|^FIELD$|^IDEA$|ByLayer|GASKET|FLANGE|PIPE|ELBOW|VALVE|TEE|STUB|^PTFE$|^Typ |ZINC|COATED|BOLT|LEVER|^mm$|^BV$|Continuous|Default/i;
const SCODE = /^S\d{1,2}$/;
const DESC_HINT = /PIPE|ELBOW|FLANGE|TEE|REDUC|VALVE|CAP|STRAINER|INSTR/i;
const LINE_HINT = /STEAM|COND|WS\d|PRV|FLASH|HEX|RELIEF/i;
const MEMBER = /^Member (.+?) x ([\d.]+)$/;

function okline(x: string | null | undefined): x is string {
  return !!x && LTOKEN.test(x) && !FNUM.test(x) && !LBLACK.test(x);
}

// ---------------------------------------------------------------------------
// 1. zlib stream scan
//
// Mirrors Python's `zlib.decompressobj()` semantics exactly (verified
// experimentally against CPython):
//   - stops at end of the FIRST zlib stream (back-to-back streams are NOT
//     chained), consumed bytes = engine.bytesWritten
//   - truncated-but-valid stream => partial output, no error
//   - corrupt stream => throws => candidate skipped
// node:zlib's public sync API cannot report consumed input bytes, so we use
// the stable private `_processChunk` path (same code path inflateSync uses).
// ---------------------------------------------------------------------------

const SLICE_CAP = 6_000_000;
// NWD contains many unrelated geometry/texture zlib streams. Only streams
// carrying Plant 3D property markers belong in the parser's retained budget.
const MAX_ZLIB_CANDIDATES = 5_000;
const MAX_SCANNED_ZLIB_STREAMS = 2_048;
const MAX_RELEVANT_ZLIB_BLOBS = 64;
const MAX_INFLATED_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS_PER_BLOB = 75_000;
const MAX_TOTAL_RECORDS = 300_000;
const MAX_COMPONENT_SEGMENTS = 10_000;
const MAX_STEEL_MEMBERS = 10_000;
const MAX_FAILED_INFLATE_ATTEMPTS = 1_000;
const MAX_ZLIB_SCAN_MS = 5_000;

function inflateAt(data: Buffer, off: number): { out: Buffer; consumed: number } | null {
  const slice = data.subarray(off, off + SLICE_CAP);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine: any = new (zlib as any).Inflate({
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
    maxOutputLength: MAX_INFLATED_BLOB_BYTES,
  });
  try {
    const out: Buffer = engine._processChunk(slice, zlib.constants.Z_SYNC_FLUSH);
    if (out.length > MAX_INFLATED_BLOB_BYTES) {
      throw new Error('NWD içindeki sıkıştırılmış blok güvenli çıktı sınırını aşıyor.');
    }
    const consumed: number = engine.bytesWritten;
    engine.close();
    return { out, consumed };
  } catch (error) {
    try { engine.close(); } catch { /* already closed */ }
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
      || (error instanceof Error && error.message.includes('güvenli çıktı sınırını'))) {
      throw new Error('NWD içindeki sıkıştırılmış blok güvenli çıktı sınırını aşıyor.');
    }
    return null;
  }
}

const MAGICS = [Buffer.from([0x78, 0x9c]), Buffer.from([0x78, 0xda]), Buffer.from([0x78, 0x01])];
const PLANT3D_MARKERS = [
  Buffer.from('PnPGuid'),
  Buffer.from('SKEY='),
  Buffer.from('TYPE=PIPE'),
  Buffer.from('Member '),
];

function isRelevantPlant3dStream(out: Buffer): boolean {
  return PLANT3D_MARKERS.some(marker => out.includes(marker));
}

export function findZlibBlobs(data: Buffer): Buffer[] {
  const cand: number[] = [];
  for (const magic of MAGICS) {
    let s = 0;
    for (;;) {
      const i = data.indexOf(magic, s);
      if (i < 0) break;
      cand.push(i);
      if (cand.length > MAX_ZLIB_CANDIDATES) {
        throw new Error('NWD çok fazla sıkıştırılmış akış adayı içeriyor.');
      }
      s = i + 1;
    }
  }
  cand.sort((a, b) => a - b);
  const blobs: Buffer[] = [];
  let used = 0;
  let totalInflated = 0;
  let failedInflates = 0;
  let scannedStreams = 0;
  const scanStartedAt = Date.now();
  for (const off of cand) {
    if (Date.now() - scanStartedAt > MAX_ZLIB_SCAN_MS) {
      throw new Error('NWD sıkıştırılmış veri tarama süresini aşıyor.');
    }
    if (off < used) continue;
    const r = inflateAt(data, off);
    if (!r) {
      failedInflates++;
      if (failedInflates > MAX_FAILED_INFLATE_ATTEMPTS) {
        throw new Error('NWD çok fazla bozuk sıkıştırılmış akış içeriyor.');
      }
      continue;
    }
    // A valid outer stream may contain bytes that look like another zlib
    // header. Advance for every successful inflate, retained or not.
    used = off + r.consumed;
    scannedStreams++;
    if (scannedStreams > MAX_SCANNED_ZLIB_STREAMS) {
      throw new Error('NWD çok fazla sıkıştırılmış veri akışı içeriyor.');
    }
    if (r.out.length >= 64 && isRelevantPlant3dStream(r.out)) {
      totalInflated += r.out.length;
      if (totalInflated > MAX_TOTAL_INFLATED_BYTES) {
        throw new Error('NWD açılmış veri bütçesini aşıyor.');
      }
      blobs.push(r.out);
      if (blobs.length > MAX_RELEVANT_ZLIB_BLOBS) {
        throw new Error('NWD çok fazla Plant 3D veri akışı içeriyor.');
      }
    }
  }
  return blobs;
}

// ---------------------------------------------------------------------------
// 2. record parsing (two schemes: compact + named/schema)
// ---------------------------------------------------------------------------

interface Rec {
  pos: number;
  name: string | null;
  val: string | null;
}

const M_COMPACT = Buffer.from([0x01, 0x00, 0x00, 0x00]);
const M_NAMED = Buffer.from([0x34, 0x00, 0x00, 0x00]);

function pad4(n: number): number {
  return Math.floor((n + 3) / 4) * 4;
}

function printableAscii(buf: Buffer, allowTab: boolean): boolean {
  for (const c of buf) {
    if (!((c >= 32 && c < 127) || (allowTab && c === 9))) return false;
  }
  return true;
}

export function parseStream(b: Buffer): Rec[] {
  const recs: Rec[] = [];
  const len = b.length;

  const pushRecord = (record: Rec): void => {
    if (recs.length >= MAX_RECORDS_PER_BLOB) {
      throw new Error('NWD veri akışı kayıt bütçesini aşıyor.');
    }
    recs.push(record);
  };

  // (a) compact: [0x01][ctr][vt=4][vlen][value]
  let pos = 0;
  for (;;) {
    const i = b.indexOf(M_COMPACT, pos);
    if (i < 0 || i + 16 > len) break;
    pos = i + 1;
    const vt = b.readUInt32LE(i + 8);
    if (vt !== 4) continue;
    const vlen = b.readUInt32LE(i + 12);
    if (!(vlen > 0 && vlen <= 1000) || i + 16 + vlen > len) continue;
    const raw = b.subarray(i + 16, i + 16 + vlen);
    if (!printableAscii(raw, true)) continue;
    pushRecord({ pos: i, name: null, val: raw.toString('latin1') });
  }

  // (b) named/schema: [ctr][0x34][nlen][name][ilen][..ubiquity../[0]][vt][vlen][value]
  pos = 0;
  for (;;) {
    const i = b.indexOf(M_NAMED, pos);
    if (i < 0) break;
    pos = i + 1;
    if (i < 4) continue;
    if (i + 8 > len) continue; // struct.unpack would raise -> except -> continue
    const nlen = b.readUInt32LE(i + 4);
    if (!(nlen >= 1 && nlen <= 80)) continue;
    const nameBuf = b.subarray(i + 8, Math.min(i + 8 + nlen, len)); // python slice truncates silently
    if (!printableAscii(nameBuf, false)) continue;
    const p = i + 8 + pad4(nlen);
    if (p + 4 > len) continue;
    const ilen = b.readUInt32LE(p);
    if (!(ilen >= 1 && ilen <= 200)) continue;
    const inameBuf = b.subarray(p + 4, Math.min(p + 4 + ilen, len));
    if (!printableAscii(inameBuf, false)) continue;
    const iname = inameBuf.toString('latin1');
    if (!iname.includes('ubiquity') && !iname.includes('[0]')) continue;
    const p2 = p + 4 + pad4(ilen);
    if (p2 + 4 > len) continue;
    const vt = b.readUInt32LE(p2);
    const name = nameBuf.toString('latin1');
    if (vt === 4) {
      if (p2 + 8 > len) continue;
      const vlen = b.readUInt32LE(p2 + 4);
      if (!(vlen >= 0 && vlen <= 1000)) continue;
      const valBuf = b.subarray(p2 + 8, Math.min(p2 + 8 + vlen, len));
      pushRecord({ pos: i, name, val: valBuf.toString('utf8') }); // 'replace'-style decoding
    } else {
      pushRecord({ pos: i, name, val: null });
    }
  }

  recs.sort((a, b2) => a.pos - b2.pos);
  return recs;
}

// ---------------------------------------------------------------------------
// 3. component segmentation + field extraction (verbatim port of extract())
// ---------------------------------------------------------------------------

interface RawComp {
  klass: string;
  guid: string;
  v: (string | null)[];
  n: (string | null)[];
}

interface Item {
  klass: string;
  longDesc?: string;
  lineNumber?: string;
  length?: string;
  skey: string;
  nps: number[];
  metric: boolean;
  lineGuessed?: boolean;
  guid: string;
  v: (string | null)[];
}

function extract(c: RawComp): Item {
  const v = c.v;
  const nm = c.n;
  const d: Item = { klass: c.klass, skey: '', nps: [], metric: false, guid: c.guid, v };

  // named fields (setdefault semantics: first occurrence wins)
  for (let i = 0; i < v.length; i++) {
    const name = nm[i];
    const val = v[i];
    if (name && val !== null) {
      if (name === 'Long Description' && d.longDesc === undefined) d.longDesc = val;
      else if (name === 'Line Number' && d.lineNumber === undefined) d.lineNumber = val;
      else if (name === 'Length' && d.length === undefined) d.length = val;
    }
  }
  if (d.longDesc === undefined) {
    for (const x of v.slice(2, 8)) {
      if (x && x.length >= 6 && DESC_HINT.test(x)) { d.longDesc = x; break; }
    }
  }

  // TYPE=/SKEY= anchor
  let t: number | null = null;
  for (let idx = 0; idx < v.length; idx++) {
    const x = v[idx];
    if (x && (x.startsWith('TYPE=') || x.startsWith('SKEY='))) { t = idx; break; }
  }
  d.skey = t !== null ? (v[t] as string) : '';

  if (t !== null) {
    if (c.klass === 'Pipe') {
      if (d.length === undefined && t >= 6 && v[t - 6] && FNUM.test(v[t - 6] as string)) {
        d.length = v[t - 6] as string;
      }
      // fallback: if t-6 is the line, length may be the decimal float at t-2
      if (d.length === undefined && t >= 2 && v[t - 2] && FNUM.test(v[t - 2] as string) && (v[t - 2] as string).includes('.')) {
        d.length = v[t - 2] as string;
      }
      for (const off of [7, 6, 8]) {
        if (d.lineNumber !== undefined) break;
        if (t >= off && okline(v[t - off])) d.lineNumber = v[t - off] as string;
      }
    }
    if (d.lineNumber === undefined) {
      for (const off of [6, 7, 5, 8, 4]) {
        if (t >= off && okline(v[t - off])) { d.lineNumber = v[t - off] as string; break; }
      }
    }
    // short S-code line name (S1..S99), full-match window t-4..t-9 — OVERRIDES
    for (let off = 4; off < 10; off++) {
      const x = t >= off ? v[t - off] : null;
      if (x && SCODE.test(x)) { d.lineNumber = x; break; }
    }
  }
  if (d.lineNumber === undefined) {
    // broad scan: first line-like token in the segment
    for (const x of v) {
      if (okline(x) && LINE_HINT.test(x)) { d.lineNumber = x; break; }
    }
  }

  // (od, dn) adjacent pairs — undotted allowed + consistency requirement (ASME + metric-hygienic)
  const nps: number[] = [];
  let metric = false;
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i];
    const bv = v[i + 1];
    if (a && bv && FNUM.test(a) && DIGITS.test(bv)) {
      const od = parseFloat(a);
      if (Number.isNaN(od)) continue;
      const target = dnToNps(parseInt(bv, 10));
      if (target === null) continue;
      const m = asmeOdToNps(od);
      if (m !== null && Math.abs(target - m) < 0.01) { nps.push(m); continue; }
      const m2 = od2npsMetric(od);
      if (m2 !== null && Math.abs(target - m2) < 0.01) { nps.push(m2); metric = true; }
    }
  }
  d.nps = [...new Set(nps)].sort((x, y) => y - x);
  d.metric = metric;
  return d;
}

// ---------------------------------------------------------------------------
// 4. code mapping (verbatim port of code_of())
// ---------------------------------------------------------------------------

function codeOf(d: Item): [string, string] {
  const ds = (d.longDesc || '').toUpperCase();
  const cl = d.klass;
  const sk = d.skey;
  const nps = d.nps;
  if (cl === 'Pipe') return ['PIPE', ''];
  if (cl === 'Elbow') return [ds.includes('45 DEG') ? '45 BEND' : '90 BEND', ''];
  if (cl === 'Tee') return [(ds.includes('RED') || nps.length >= 2) ? 'RED TEE' : 'EQ TEE', ''];
  if (cl === 'Reducer') return ['CON RED', ds.includes('ECC') ? 'ECC' : ''];
  if (cl === 'BlindFlange') return ['BLIND FLANGE', ''];
  if (cl === 'Flange') {
    d.nps = d.nps.slice(0, 1); // flanges are single-size; strip neighbour-size pollution
    if (sk.includes('FLLB')) return ['FLANGE', 'SLIP ON / BACKING'];
    if (sk.includes('FLWN')) return ['FLANGE', 'WELD NECK FLANGE'];
    if (sk.includes('FLSC')) return ['FLANGE', 'SCREWED'];
    return ['FLANGE', ''];
  }
  if (cl === 'Valve') {
    for (const tname of ['BALL', 'GATE', 'GLOBE', 'CHECK', 'BUTTERFLY', 'NEEDLE']) {
      if (ds.includes(tname)) return ['VALVE', tname];
    }
    return ['VALVE', ''];
  }
  if (cl === 'Strainer') return ['STRAINER', ''];
  if (cl === 'InlineInstrument') return ['INSTRUMENT', ''];
  if (cl === 'Cap') return ['CAP', ''];
  if (cl === 'Support') return ['SUPPORT', ''];
  if (cl === 'SpacerDisk') return ['SPACER', ''];
  return [cl.toUpperCase(), ''];
}

// ---------------------------------------------------------------------------
// 5. steel members (Plant 3D structural: "Member <PROFILE> x <LEN_mm>")
// ---------------------------------------------------------------------------

function extractSteel(blobRecs: Rec[][]): SteelMember[] {
  const seen = new Set<string>();
  const members: SteelMember[] = [];
  for (const recs of blobRecs) {
    const v = recs.map((r) => r.val);
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (!x) continue;
      // Calibration note: only COMPACT records count as a member
      // instances. A blob's first member is additionally echoed through the
      // named/schema block (name='PartSizeLongDesc'); the calibrated reference
      // (49 members / 62.39 m / 636.3 kg) excludes that schema echo.
      if (recs[i].name !== null) continue;
      const m = MEMBER.exec(x);
      if (!m) continue;
      const profile = m[1];
      const lengthMm = parseFloat(m[2]);
      if (Number.isNaN(lengthMm)) continue;
      let kg: number | null = null;
      if (v[i + 4] === 'KG' && v[i + 3]) {
        const w = parseFloat(v[i + 3] as string);
        if (!Number.isNaN(w)) kg = w;
      }
      const ctx = [i - 3, i - 2, i - 1, i + 5, i + 6, i + 7]
        .map((j) => (j >= 0 && j < v.length ? (v[j] ?? '<null>') : '<oob>'))
        .join('|');
      const key = `${profile}|${lengthMm.toFixed(1)}|${ctx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (members.length >= MAX_STEEL_MEMBERS) {
        throw new Error('NWD çelik eleman bütçesini aşıyor.');
      }
      members.push({ profile, lengthMm, kg });
    }
  }
  return members;
}

// ---------------------------------------------------------------------------
// 6. main entry
// ---------------------------------------------------------------------------

export function parseNwd(buffer: Buffer): NwdResult {
  const blobs = findZlibBlobs(buffer);

  const blobRecs: Rec[][] = [];
  let totalRecords = 0;
  for (const blob of blobs) {
    const recs = parseStream(blob);
    totalRecords += recs.length;
    if (totalRecords > MAX_TOTAL_RECORDS) {
      throw new Error('NWD toplam kayıt bütçesini aşıyor.');
    }
    blobRecs.push(recs);
  }

  // component segmentation (blobs with >= 50 records only, as in nwd_mto3.py)
  const allcomps: RawComp[] = [];
  for (const recs of blobRecs) {
    if (recs.length < 50) continue;
    const n = recs.length;
    const starts: number[] = [];
    for (let idx = 0; idx < n - 1; idx++) {
      const val = recs[idx].val;
      const nxt = recs[idx + 1].val;
      if (val !== null && CLASSES.has(val) && nxt && GUID.test(nxt)) starts.push(idx);
    }
    for (let si = 0; si < starts.length; si++) {
      const idx = starts[si];
      const end = si + 1 < starts.length ? starts[si + 1] : n;
      const seg = recs.slice(idx, end);
      if (allcomps.length >= MAX_COMPONENT_SEGMENTS) {
        throw new Error('NWD komponent bütçesini aşıyor.');
      }
      allcomps.push({
        klass: seg[0].val as string,
        guid: seg[1].val as string,
        v: seg.map((x) => x.val),
        n: seg.map((x) => x.name),
      });
    }
  }

  // dedup by GUID (keep first)
  const seen = new Set<string>();
  const comps: RawComp[] = [];
  for (const c of allcomps) {
    if (seen.has(c.guid)) continue;
    seen.add(c.guid);
    comps.push(c);
  }

  const items = comps.map(extract);

  // line continuity: forward fill, then backward fill (flow order within blob order)
  let last: string | undefined;
  for (const d of items) {
    if (d.lineNumber) last = d.lineNumber;
    else if (last) { d.lineNumber = last; d.lineGuessed = true; }
  }
  let nxt: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const d = items[i];
    if (d.lineNumber && !d.lineGuessed) nxt = d.lineNumber;
    else if (!d.lineNumber && nxt) { d.lineNumber = nxt; d.lineGuessed = true; }
  }

  // components (non-connector rows)
  const components: Component[] = [];
  for (const d of items) {
    if (d.klass === 'P3dConnector') continue;
    const [code, sub] = codeOf(d); // NOTE: mutates d.nps for Flange (single-size rule)
    const nps = d.nps;
    const s1 = nps.length ? nps[0] : null;
    const s2 = nps.length >= 2 ? nps[1] : 0;
    const line = d.lineNumber || '?';
    let qty = 1.0;
    if (code === 'PIPE') {
      const L = d.length ? parseFloat(d.length) : 0;
      qty = (Number.isNaN(L) ? 0 : L) / 1000.0;
    }
    const comp: Component = {
      klass: d.klass,
      guid: d.guid,
      code,
      sub,
      line,
      s1,
      s2,
      qty,
      unit: code === 'PIPE' ? 'M' : 'EA',
      desc: (d.longDesc || '').slice(0, 70),
      metric: d.metric,
    };
    if (d.lineGuessed) comp.lineGuessed = true;
    components.push(comp);
  }

  // fasteners: anchors inside P3dConnector segments
  const fasteners: Fasteners = { gaskets: 0, boltSets: 0, stubEnds: 0 };
  for (const c of comps) {
    if (c.klass !== 'P3dConnector') continue;
    for (const x of c.v) {
      if (!x) continue;
      if (x.includes('TYPE=GASKET')) fasteners.gaskets++;
      if (x.includes('STUBEND')) fasteners.stubEnds++;
      if (x.includes('TYPE=BOLT')) fasteners.boltSets++;
    }
  }

  const steelMembers = extractSteel(blobRecs);

  // stats
  const classHistogram: Record<string, number> = {};
  for (const c of comps) classHistogram[c.klass] = (classHistogram[c.klass] || 0) + 1;
  const lineCounts: Record<string, number> = {};
  for (const d of items) {
    if (d.lineNumber) lineCounts[d.lineNumber] = (lineCounts[d.lineNumber] || 0) + 1;
  }

  return {
    components,
    steelMembers,
    fasteners,
    stats: {
      fileBytes: buffer.length,
      blobs: blobs.length,
      records: totalRecords,
      uniqueComponents: comps.length,
      classHistogram,
      lineCounts,
    },
  };
}
