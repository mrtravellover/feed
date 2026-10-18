// Shah Jewellers — "Create with AI" poster generator
// Vercel Serverless Function — place at /api/ai-poster.js (same Vercel project as feed.js)
//
// The browser sends the prompt (+ logo). THIS function adds your secret Gemini
// key, calls Google, and returns the finished image. The key never reaches
// the website code.
//
// ── SETUP (Vercel dashboard → this project → Settings → Environment Variables)
//   GEMINI_API_KEY        (required) your Google AI Studio key
//   FIREBASE_WEB_API_KEY  (required) the "apiKey" value from your app's firebase config.
//                         Used only to check that the caller is a signed-in staff member.
//   GEMINI_IMAGE_MODEL    (optional) image model id. Default gemini-nano-banana-2.1.
//   GEMINI_API_MODE       (optional) 'interactions' (default) or 'generate'. Change it here
//                         (no code change) when you want a different model.
//   ALLOWED_ORIGINS       (optional) comma separated, default https://tool.shahjewellers.co.in
// After adding or changing variables, redeploy the project.

export const config = { maxDuration: 60 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
// 'interactions' (Google's newer API, same as the sample code in AI Studio) or 'generate' (older generateContent).
// If the first one fails with a 400/404, the other is tried automatically.
const API_MODE = (process.env.GEMINI_API_MODE || 'interactions').toLowerCase();
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://tool.shahjewellers.co.in')
  .split(',').map(s => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin || '';
  const ok = ALLOWED.includes(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return ok;
}

// Confirms the Firebase login token is real (signed-in staff only), so nobody
// else can spend your Gemini quota.
async function verifyUser(idToken) {
  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(FIREBASE_WEB_API_KEY),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  if (!r.ok) return false;
  const j = await r.json().catch(() => null);
  return !!(j && Array.isArray(j.users) && j.users.length);
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, ok: r.ok, json, text };
}

// Google's newer Interactions API (what the AI Studio sample code uses).
function callInteractions(prompt, logoB64, withFormat) {
  const input = [{ type: 'text', text: prompt }];
  if (logoB64) input.push({ type: 'image', mime_type: 'image/png', data: logoB64 });
  const body = { model: MODEL, input };
  if (withFormat) body.response_format = { type: 'image', mime_type: 'image/png', aspect_ratio: '4:5', image_size: '1K' };
  return postJson('https://generativelanguage.googleapis.com/v1beta/interactions', body);
}

// Older generateContent API.
function callGenerate(prompt, logoB64, withFormat) {
  const parts = [{ text: prompt }];
  if (logoB64) parts.push({ inlineData: { mimeType: 'image/png', data: logoB64 } });
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (withFormat) generationConfig.imageConfig = { aspectRatio: '4:5' };
  return postJson(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent',
    { contents: [{ role: 'user', parts }], generationConfig }
  );
}

// Finds the first generated image anywhere in the reply, whichever API shape it uses.
function pickImage(node, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const inl = node.inlineData || node.inline_data;
  if (inl && typeof inl.data === 'string' && inl.data.length > 100) return { mime: inl.mimeType || inl.mime_type || 'image/png', data: inl.data };
  if (node.type === 'image' && typeof node.data === 'string' && node.data.length > 100) return { mime: node.mime_type || node.mimeType || 'image/png', data: node.data };
  if (node.output_image && typeof node.output_image.data === 'string') return { mime: node.output_image.mime_type || 'image/png', data: node.output_image.data };
  for (const k of Object.keys(node)) {
    const v = node[k];
    const hit = Array.isArray(v) ? v.map(x => pickImage(x, depth + 1)).find(Boolean) : pickImage(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function generate(prompt, logo) {
  const order = API_MODE === 'generate' ? [callGenerate, callInteractions] : [callInteractions, callGenerate];
  let last = null;
  for (const fn of order) {
    let out = await fn(prompt, logo, true);
    // Unknown size/aspect options: retry once without them (the prompt already asks for 4:5).
    if (out.status === 400) out = await fn(prompt, logo, false);
    if (out.ok && pickImage(out.json)) return out;
    last = out;
    // Bad key / quota / blocked: the other API will not help, stop here.
    if ([401, 403, 429].includes(out.status)) break;
  }
  return last;
}

export default async function handler(req, res) {
  const originOk = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(originOk ? 204 : 403).end();
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });
  if (!originOk) return res.status(403).json({ success: false, error: 'This website is not allowed to use the AI poster service' });
  if (!GEMINI_API_KEY) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not set in Vercel settings' });
  if (!FIREBASE_WEB_API_KEY) return res.status(500).json({ success: false, error: 'FIREBASE_WEB_API_KEY is not set in Vercel settings' });

  try {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !(await verifyUser(token))) {
      return res.status(401).json({ success: false, error: 'Please sign in again' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const prompt = String(body.prompt || '').slice(0, 6000);
    const logo = String(body.logo || '');
    if (!prompt.trim()) return res.status(400).json({ success: false, error: 'Empty prompt' });
    if (logo.length > 1500000) return res.status(400).json({ success: false, error: 'Logo is too large' });

    const out = await generate(prompt, logo);

    if (!out.ok) {
      const msg = (out.json && out.json.error && out.json.error.message) || out.text.slice(0, 300);
      console.error('[ai-poster] Gemini error', out.status, msg);
      return res.status(502).json({ success: false, error: 'Gemini said (' + out.status + '): ' + msg, model: MODEL });
    }

    const img = pickImage(out.json);
    if (!img) {
      const cand = out.json && out.json.candidates && out.json.candidates[0];
      const why = (cand && cand.finishReason) || (out.json && out.json.promptFeedback && out.json.promptFeedback.blockReason) || 'no image in reply';
      console.error('[ai-poster] no image:', out.text.slice(0, 400));
      return res.status(502).json({ success: false, error: 'No image returned (' + why + '). Check that GEMINI_IMAGE_MODEL is an image model.', model: MODEL });
    }
    return res.status(200).json({ success: true, mime: img.mime, image: img.data, model: MODEL });
  } catch (e) {
    console.error('[ai-poster] error', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
}
