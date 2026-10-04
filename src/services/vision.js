// Vision hook for job photos.
// Interface: analyzePhotos([{ path, mime }]) -> { mode, observations[], room_hint, risks[] }
//
// Two modes:
//  - "openai": if OPENAI_API_KEY is set, sends the photos to an OpenAI-compatible
//    chat-completions endpoint with image input and asks for a structured
//    assessment (room type, visible issues, scope hints). Uses native fetch.
//  - "heuristic": no key. Reads file metadata only (size, type) and returns a
//    documented fallback: asks the customer to classify the room via the scope
//    questionnaire (room_type) instead of auto-analyzing.
//
// The estimator consumes `risks` and `room_hint`; the UI must label AI output
// as preliminary (see frontend note + README).
const fs = require('fs');

const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

function mode() {
  return API_KEY ? 'openai' : 'heuristic';
}

async function analyzePhotos(photos) {
  if (!photos || photos.length === 0) {
    return { mode: mode(), observations: [], room_hint: null, risks: [] };
  }
  if (!API_KEY) return heuristic(photos);
  try {
    return await openaiAnalyze(photos);
  } catch (err) {
    // Never break job intake because vision failed: degrade gracefully.
    console.warn('[vision] provider failed, falling back to heuristic:', err.message);
    const h = heuristic(photos);
    h.provider_error = String(err.message).slice(0, 200);
    return h;
  }
}

// --- heuristic fallback: metadata only, honest about its limits ---
function heuristic(photos) {
  const observations = [];
  let totalBytes = 0;
  for (const p of photos) {
    let size = 0;
    try { size = fs.statSync(p.path).size; } catch (e) { /* ignore */ }
    totalBytes += size;
    observations.push(
      `Photo "${p.originalName || p.filename}": ${(size / 1024).toFixed(0)} KB, type ${p.mime || 'unknown'}. ` +
      'Content not analyzed (no vision key configured).'
    );
  }
  return {
    mode: 'heuristic',
    observations,
    room_hint: null, // frontend should ask room_type in the questionnaire
    risks: [
      { flag: 'vision_unavailable', note: 'Photos stored but not auto-analyzed. Ask the customer to classify the room and describe visible damage.' },
    ],
    meta: { photo_count: photos.length, total_kb: Math.round(totalBytes / 1024) },
  };
}

// --- OpenAI-compatible vision call ---
async function openaiAnalyze(photos) {
  const content = [
    {
      type: 'text',
      text: 'You are a home-improvement intake assistant. Look at these job-site photos and reply with JSON only: ' +
        '{"room_hint": "<kitchen|bathroom|living|bedroom|exterior|other>", ' +
        '"observations": ["<short factual observation>"], ' +
        '"risks": [{"flag": "<snake_case>", "note": "<why it matters for quoting>"}]}. ' +
        'Be conservative: only report what you can actually see. Max 6 observations, max 4 risks.',
    },
  ];
  for (const p of photos.slice(0, 4)) { // cap at 4 images per call
    const buf = fs.readFileSync(p.path);
    content.push({
      type: 'image_url',
      image_url: { url: `data:${p.mime || 'image/jpeg'};base64,${buf.toString('base64')}` },
    });
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 600, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`vision API ${res.status}`);
  const data = await res.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message.content) || '{}';
  const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText);
  return {
    mode: 'openai',
    observations: Array.isArray(parsed.observations) ? parsed.observations.slice(0, 6) : [],
    room_hint: parsed.room_hint || null,
    risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 4) : [],
  };
}

module.exports = { analyzePhotos, mode };
