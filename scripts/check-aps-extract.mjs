import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Next.js uzantısız TypeScript importlarını çözer; bu bağımsız Node kontrolü de
// aynı kaynak grafiğini build aracı olmadan yükleyebilsin.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)
        && !/\.\w+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const [{ extractFromApsProps }, { DEFAULT_RULES }] = await Promise.all([
  import('../src/lib/parser/aps-extract.ts'),
  import('../src/lib/types.ts'),
]);

const rules = DEFAULT_RULES['steel-plant'];
const item = (Type, Name, Source = 'anonymous-model') => ({ Type, Name, 'Source File': Source });

// Native Revit property extraction remains deterministic and does not activate
// name-based fallback extractors.
const revit = extractFromApsProps([{
  objectid: 1,
  name: 'anonymous pipe',
  properties: {
    Item: item('Geometry', 'anonymous pipe'),
    Element: { Id: 'e-1', Category: 'Pipes', Size: '100', Length: '10', 'System Name': 'S-1' },
    Custom: { 'Description BOM': 'PIPE', Vic_Area_PT: 'AREA-A' },
  },
}], rules);
assert.equal(revit.family, 'revit');
assert.equal(revit.quality, 'structured');
assert.equal(revit.rows.length, 1);
assert.equal(revit.rows[0].qty, 3.048);
assert.equal(revit.candidates.length, 0);
assert.equal(revit.coverage.measurableObjects, 1);
assert.equal(revit.provenance[0]?.extractor, 'revit-properties');

// A real ACPP signature owns vendor Insert blocks too; generic fallback must not
// relabel a Plant3D collection as mixed.
const p3d = extractFromApsProps([{
  objectid: 2,
  properties: {
    Item: item('ACPPPIPE', 'pipe', 'line-a.dwg'),
    AutoCAD: { Class: 'Pipe', Port1_NominalDiameter: '100', Length: '2500' },
  },
}, {
  objectid: 3,
  name: 'BLIND FLANGE DN100',
  properties: {
    Item: item('Insert', 'BLIND FLANGE DN100', 'line-a.dwg'),
    'AutoCAD Geometry': { 'Insertion point X': '0.000 mm' },
  },
}, {
  objectid: 4,
  name: '90 BEND',
  properties: {
    Item: item('Insert', '90 BEND', 'line-a.dwg'),
    'AutoCAD Geometry': { 'Insertion point X': '10.000 mm' },
  },
}, {
  objectid: 5,
  name: '200mm x 250mm Concentric',
  properties: {
    Item: item('Insert', '200mm x 250mm Concentric', 'line-a.dwg'),
    'AutoCAD Geometry': { 'Insertion point X': '20.000 mm' },
  },
}, {
  objectid: 6,
  properties: {
    Item: item('ACPPPIPEINLINEASSET', 'explicit inline valve', 'line-a.dwg'),
    AutoCAD: {
      Class: 'InlineInstrument', Port1_NominalDiameter: '100',
      ShortDescription: 'Inline Instrument', 'Long Description': 'Metric inline (VALVE)',
    },
  },
}], rules);
assert.equal(p3d.family, 'plant3d-dwg');
assert.equal(p3d.quality, 'structured');
assert.equal(p3d.totals.pipeM, 2.5);
assert.equal(p3d.rows.find(row => row.code === 'BLIND FLANGE')?.qty, 1);
assert.equal(p3d.rows.find(row => row.code === '90 BEND')?.s1, null);
assert.equal(p3d.rows.find(row => row.code === 'CON RED')?.s1, 10);
assert.equal(p3d.rows.find(row => row.code === 'CON RED')?.s2, 8);
assert.equal(p3d.rows.find(row => row.code === 'MV')?.qty, 1);
assert.equal(p3d.coverage.candidateObjects, 0);

// Inventor hierarchy: Instance is the placement; Part/Mesh siblings must not be
// double counted. Catalog DN range is ignored, final explicit DN is used.
const inventor = extractFromApsProps([{
  objectid: 10,
  name: 'Collar PN10 (DN10-500)_DN 100_701',
  properties: { Item: item('Instance', 'opaque-placement-701', 'assembly-a') },
}, {
  objectid: 11,
  name: 'part duplicate',
  properties: { Item: item('Part', 'Collar PN10 (DN10-500)_DN 100', 'assembly-a') },
}, {
  objectid: 12,
  name: 'placed reducer',
  properties: { Item: item('Instance', 'Concentric Reducer DN 100x50_702', 'assembly-a') },
}, {
  objectid: 13,
  name: 'placed pipe',
  properties: { Item: item('Instance', 'Pipe DN 100_703', 'assembly-a') },
}, {
  objectid: 15,
  name: 'placed eccentric reducer',
  properties: { Item: item('Instance', 'Rid.Eccentrica PN10 350x200_705', 'assembly-a') },
}, {
  objectid: 16,
  name: 'catalog-coded reducer',
  properties: { Item: item('Instance', 'Reduzierstück 2060.100.065_706', 'assembly-a') },
}], rules);
assert.equal(inventor.family, 'inventor-assembly');
assert.equal(inventor.quality, 'partial');
assert.equal(inventor.rows.find(row => row.code === 'COLLAR')?.qty, 1);
assert.equal(inventor.rows.find(row => row.code === 'CON RED')?.s2, 2);
assert.equal(inventor.rows.find(row => row.code === 'ECC RED')?.s1, 14);
assert.equal(inventor.rows.find(row => row.code === 'ECC RED')?.s2, 8);
assert.equal(inventor.rows.some(row => row.code === 'PIPE'), false);
assert.equal(inventor.candidates.find(c => c.kind === 'pipe-without-length')?.count, 1);
assert.equal(inventor.candidates.find(c => c.code === 'CON RED')?.s1, null);
assert.equal(inventor.coverage.measurableObjects, 3);
assert.equal(inventor.coverage.candidateObjects, 2);
assert.equal(inventor.provenance[0]?.extractor, 'inventor-nameplate');

// Calibration lifecycle is fail-closed: only legacy (status absent) and active
// rules can affect future output. Quantity factors compose just like vocab.ts.
const calibratedRules = structuredClone(rules);
const collarMatch = { code: 'COLLAR', s1: 4, s2: 0, unit: 'EA' };
calibratedRules.itemCorrections = [
  { id: 'legacy', match: collarMatch, set: { qtyFactor: 3 }, source: 'custom', evidenceCount: 2 },
  { id: 'active', match: collarMatch, set: { qtyFactor: 2 }, source: 'custom', evidenceCount: 2, status: 'active' },
  { id: 'candidate', match: collarMatch, set: { qtyFactor: 5 }, source: 'custom', evidenceCount: 1, status: 'candidate' },
  { id: 'rejected', match: collarMatch, set: { code: 'SHOULD NOT APPLY', qtyFactor: 7 }, source: 'custom', evidenceCount: 2, status: 'rejected' },
];
const calibratedInventor = extractFromApsProps([{
  objectid: 14,
  name: 'placed collar',
  properties: { Item: item('Instance', 'Collar DN 100_704', 'assembly-a') },
}], calibratedRules);
assert.equal(calibratedInventor.rows.find(row => row.code === 'COLLAR')?.qty, 6);
assert.equal(calibratedInventor.rows.some(row => row.code === 'SHOULD NOT APPLY'), false);

// IFC/Tekla quantities are candidates, not piping totals. GlobalId de-duplicates
// repeated hierarchy nodes and explicit units are preserved.
const ifcNode = {
  name: 'anonymous member',
  properties: {
    Item: item('IfcBeam: SHS100*100*10.0', 'anonymous member', 'structure.ifc'),
    Element: { GlobalId: 'ifc-global-1' },
    BaseQuantities: { GlobalId: 'ifc-global-1', Length: '2500.000 mm', NetWeight: '42.500 kg' },
    'Tekla Quantity': { GlobalId: 'ifc-global-1', Length: '2500.000 mm', Weight: '43.000 kg' },
  },
};
const ifc = extractFromApsProps([
  { objectid: 20, ...ifcNode },
  { objectid: 21, ...ifcNode }, // same GlobalId: hierarchy duplicate
  {
    objectid: 22,
    name: 'non section',
    properties: { Item: item('IfcBeam: SPHERE75', 'non section'), Element: { GlobalId: 'ifc-global-2' } },
  },
], rules);
assert.equal(ifc.family, 'ifc-tekla');
assert.equal(ifc.rows.length, 0);
assert.equal(ifc.candidates.length, 1);
assert.equal(ifc.candidates[0].count, 1);
assert.equal(ifc.candidates[0].lengthM, 2.5);
assert.equal(ifc.candidates[0].weightKg, 42.5);
assert.equal(ifc.quality, 'partial');
assert.equal(ifc.coverage.measurableObjects, 0);
assert.equal(ifc.coverage.candidateObjects, 1);
assert.equal(ifc.provenance[0]?.extractor, 'ifc-tekla-quantities');

const ifcWithoutUnits = extractFromApsProps([{
  objectid: 23,
  properties: {
    Item: item('IfcColumn: UB203X133X25', 'anonymous member', 'structure.ifc'),
    Element: { GlobalId: 'ifc-global-3' },
    BaseQuantities: { Length: 2500, NetWeight: '42.5' },
  },
}], rules);
assert.equal(ifcWithoutUnits.candidates[0].lengthM, undefined);
assert.equal(ifcWithoutUnits.candidates[0].weightKg, undefined);

// Inventor steel nameplates expose profile/count candidates only; no member
// length is inferred from opaque part-number suffixes.
const inventorSteel = extractFromApsProps([{
  objectid: 30,
  name: 'Universal Beam - UB305x165x40-opaque.ipt',
  properties: {
    Item: item('Group', 'Universal Beam - UB305x165x40-opaque.ipt', 'assembly.iam'),
    Project: { 'Part Number': 'Universal Beam - UB305x165x40-opaque' },
  },
}], rules);
assert.equal(inventorSteel.family, 'inventor-assembly');
assert.equal(inventorSteel.rows.length, 0);
assert.equal(inventorSteel.candidates[0].label, 'UB305X165X40');
assert.equal(inventorSteel.candidates[0].lengthM, undefined);
assert.equal(inventorSteel.provenance[0]?.extractor, 'inventor-steel-nameplate');

// Generic AutoCAD: Block definition and solid children are ignored; only the
// placed Insert with explicit component/size evidence contributes.
const genericCad = extractFromApsProps([{
  objectid: 40,
  name: 'Valve-Mixproof-2.2-100-generic',
  properties: {
    Item: item('Block', 'Valve-Mixproof-2.2-100-generic', 'layout.dwg'),
    'AutoCAD Geometry': { 'Insertion point X': '0.000 mm' },
  },
}, {
  objectid: 41,
  name: 'Valve-Mixproof-2.2-100-generic',
  properties: {
    Item: { ...item('Insert', '', 'layout.dwg'), GUID: 'insert-guid-1' },
    'AutoCAD Geometry': { 'Insertion point X': '100.000 mm' },
  },
}, {
  objectid: 42,
  name: 'Reduzierstück-+-2060.100.065-generic',
  properties: {
    Item: { ...item('Insert', '', 'layout.dwg'), GUID: 'insert-guid-2' },
    'AutoCAD Geometry': { 'Insertion point X': '200.000 mm' },
  },
}, {
  objectid: 43,
  name: 'PIPE DN100',
  properties: { Item: item('3D Solid', 'PIPE DN100', 'layout.dwg') },
}, {
  objectid: 44,
  name: 'Reduzierstück DN 100x65',
  properties: {
    Item: { ...item('Insert', '', 'layout.dwg'), GUID: 'shared-block-definition-guid' },
    'AutoCAD Geometry': { 'Insertion point X': '300.000 mm' },
  },
}, {
  objectid: 45,
  name: 'Reduzierstück DN 100x65',
  properties: {
    Item: { ...item('Insert', '', 'layout.dwg'), GUID: 'shared-block-definition-guid' },
    'AutoCAD Geometry': { 'Insertion point X': '400.000 mm' },
  },
}], rules);
assert.equal(genericCad.family, 'generic-autocad');
assert.equal(genericCad.quality, 'partial');
assert.equal(genericCad.rows.some(row => row.code === 'MV'), false);
assert.equal(genericCad.candidates.find(candidate => candidate.code === 'MV')?.count, 1);
assert.equal(genericCad.rows.find(row => row.code === 'CON RED')?.qty, 2);
assert.equal(genericCad.rows.find(row => row.code === 'CON RED')?.s1, 4);
assert.equal(genericCad.rows.find(row => row.code === 'CON RED')?.s2, 2.5);
assert.equal(genericCad.candidates.find(candidate => candidate.code === 'CON RED')?.count, 1);
assert.equal(genericCad.rows.some(row => row.code === 'PIPE'), false);
assert.equal(genericCad.provenance[0]?.extractor, 'autocad-explicit-block');

// Unstructured mesh with persuasive-looking text remains fail-closed.
const mesh = extractFromApsProps([{
  objectid: 50,
  name: 'PIPE DN100',
  properties: { Item: item('Mesh', 'PIPE DN100', 'mesh-source') },
}], rules, 100);
assert.equal(mesh.family, 'none');
assert.equal(mesh.quality, 'none');
assert.equal(mesh.rows.length, 0);
assert.equal(mesh.candidates.length, 0);
assert.equal(mesh.coverage.totalObjects, 100);
assert.equal(mesh.coverage.recognizedRatio, 0);
assert.equal(mesh.confidence, 0);
assert.deepEqual(mesh.provenance, []);

console.log('APS extraction: native regressions, partial families, candidates, provenance, and fail-closed guards verified');
