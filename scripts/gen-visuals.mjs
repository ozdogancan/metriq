// Gemini ile marka görselleri: logo, login hero, OG thumbnail
// KULLANIM: node scripts/gen-visuals.mjs   (GEMINI_API_KEY .env.local'dan okunur)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const env = readFileSync('.env.local', 'utf8');
const KEY = (env.match(/^GEMINI_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!KEY) { console.error('GEMINI_API_KEY yok'); process.exit(1); }

const MODEL = 'gemini-2.5-flash-image';

async function gen(prompt, outfile, { aspect = '1:1' } = {}) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${outfile}: HTTP ${res.status} ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error(`${outfile}: görüntü yok — ${JSON.stringify(j).slice(0, 300)}`);
  writeFileSync(outfile, Buffer.from(part.inlineData.data, 'base64'));
  console.log('OK', outfile, part.inlineData.mimeType);
}

mkdirSync('public', { recursive: true });
mkdirSync('src/app', { recursive: true });

const brand = `Deep charcoal navy background (#0b0e13), refined copper/bronze accents (#d08a45), subtle steel-blue (#7fa6c9). Aesthetic: precision technical drawing, CAD blueprint, engineering elegance. No text unless specified. Premium, minimal, high-end SaaS.`;

const jobs = [
  // 1) Logo: kare, M monogramı + ölçü çizgisi motifi
  [`Minimal geometric logo mark for "Metriq", an engineering quantity-takeoff platform. A bold letter "M" constructed from technical drawing elements: dimension lines with arrow terminators and a subtle pipe-elbow curve integrated into one stroke. Flat vector style, crisp edges, copper (#d08a45) strokes on deep charcoal-navy (#0b0e13) square background with a faint blueprint grid. Centered, generous margins, no words, no gradients on the mark itself. ${brand}`,
   'public/logo.png', { aspect: '1:1' }],
  // 2) Login hero: dikey görsel
  [`Vertical hero illustration for a login screen of an engineering takeoff platform. An elegant isometric technical drawing of an industrial piping system: pipes, flanged joints, valves and a steel channel frame, drawn as glowing copper and steel-blue linework on deep charcoal-navy, with faint dimension annotations and a subtle blueprint grid. Composition flows diagonally, calm and premium, plenty of dark negative space at edges. No text. ${brand}`,
   'public/login-hero.png', { aspect: '3:4' }],
  // 3) OG thumbnail 1200x630
  [`Wide social preview banner for "METRIQ" engineering takeoff platform. Left side: the word "METRIQ" in a clean modern geometric sans-serif, copper color, with a thin dimension-line underline with arrow ends; small subtitle "MODEL → METRAJ" in light gray monospace. Right side: elegant isometric piping and steel-profile linework in copper and steel blue on deep charcoal-navy with faint blueprint grid. Balanced, premium, minimal. ${brand}`,
   'src/app/opengraph-image.png', { aspect: '16:9' }],
];

for (const [prompt, out, opts] of jobs) {
  try { await gen(prompt, out, opts); }
  catch (e) { console.error('FAIL', out, e.message); }
}
console.log('bitti');
