// Metriq — TR/EN sözlük eşlik testi.
// "İngilizce ve Türkçe kısmı HEP düzgün çalışsın" güvencesi: iki sözlüğün
// anahtarları birebir aynı olmalı ve hiçbir değer boş olmamalı. Bir çeviri
// eklenip diğeri unutulursa CI burada kırmızıya döner (prod'a sızmaz).
import assert from 'node:assert/strict';
import { dict } from '../src/lib/i18n.ts';

const trKeys = Object.keys(dict.tr).sort();
const enKeys = Object.keys(dict.en).sort();

const missingInEn = trKeys.filter(k => !(k in dict.en));
const missingInTr = enKeys.filter(k => !(k in dict.tr));

assert.deepEqual(missingInEn, [], `EN'de eksik anahtarlar: ${missingInEn.join(', ')}`);
assert.deepEqual(missingInTr, [], `TR'de eksik anahtarlar: ${missingInTr.join(', ')}`);
assert.deepEqual(trKeys, enKeys, 'TR ve EN anahtar kümeleri birebir eşleşmeli');

for (const k of trKeys) {
  assert.equal(typeof dict.tr[k], 'string', `TR "${k}" bir string olmalı`);
  assert.notEqual(dict.tr[k].trim(), '', `TR "${k}" boş olmamalı`);
  assert.equal(typeof dict.en[k], 'string', `EN "${k}" bir string olmalı`);
  assert.notEqual(dict.en[k].trim(), '', `EN "${k}" boş olmamalı`);
}

console.log(`i18n eşlik OK: ${trKeys.length} anahtar, TR↔EN birebir, boş değer yok`);
