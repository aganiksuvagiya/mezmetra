// The "new order" chime. It is generated with the Web Audio API (no sound file to ship). Browsers keep audio locked until
// the person has clicked or tapped the page, so `unlockAudio()` has to run from such a gesture; until then `playOrderChime()`
// stays silent instead of failing.

const KEY = 'mezmitra_order_sound';

let context = null;

const AudioCtor = () => (typeof window === 'undefined' ? null : window.AudioContext || window.webkitAudioContext || null);

export const soundSupported = () => AudioCtor() !== null;

export function readSoundPref() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeSoundPref(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the choice just lasts until the page is closed */
  }
}

function getContext() {
  const Ctor = AudioCtor();
  if (!context && Ctor) context = new Ctor();
  return context;
}

export const audioRunning = () => context?.state === 'running';

/** Call from a click/tap/key handler. Resolves to true when sound can play. */
export async function unlockAudio() {
  const ctx = getContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  return ctx.state === 'running';
}

// Three rising notes, repeated `times` times (a kitchen is loud, so the real alert plays twice).
const NOTES = [
  [880, 0],
  [1175, 0.16],
  [1480, 0.32],
];

/** Plays the chime. Returns false (and stays silent) while the browser still has audio locked. */
export function playOrderChime(times = 2) {
  const ctx = getContext();
  if (!ctx || ctx.state !== 'running') return false;
  const start = ctx.currentTime + 0.02;
  for (let round = 0; round < times; round += 1) {
    for (const [frequency, offset] of NOTES) {
      const at = start + round * 0.9 + offset;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.5);
    }
  }
  return true;
}

// --- Voice -----------------------------------------------------------------------------------------------------------------
// A kitchen is loud and nobody stares at the screen, so each new order is also read out ("New order. Table 3. 2 items.") with the
// browser's own text-to-speech: nothing to ship, and it works offline. Like the chime it needs one click on the page first.
// The choices (on/off, language, voice, speed) are kept per device, because every phone and computer has its own voices.

const VOICE_KEY = 'mezmitra_order_voice';

/** What is said, per language. `locale` is the BCP-47 tag the voice is looked up by. */
export const VOICE_LANGS = {
  en: {
    label: 'English',
    locale: 'en-IN',
    start: 'New order.',
    table: (t) => `Table ${t}.`,
    items: (n) => `${n} ${n === 1 ? 'item' : 'items'}.`,
    paid: 'Paid online.',
    sample: 'Voice is on. New orders will be read out.',
  },
  hi: {
    label: 'हिन्दी (Hindi)',
    locale: 'hi-IN',
    start: 'नया ऑर्डर।',
    table: (t) => `टेबल ${t}।`,
    items: (n) => `${n} आइटम।`,
    paid: 'ऑनलाइन भुगतान हो गया।',
    sample: 'आवाज़ चालू है। नए ऑर्डर बोले जाएंगे।',
  },
};

export const VOICE_SPEEDS = [
  ['0.8', 'Slow'],
  ['1', 'Normal'],
  ['1.2', 'Fast'],
];

const DEFAULT_VOICE = { on: true, lang: 'en', voice: '', rate: 1 };

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

export function readVoicePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_KEY) ?? 'null') ?? {};
    return {
      on: saved.on !== false,
      lang: VOICE_LANGS[saved.lang] ? saved.lang : DEFAULT_VOICE.lang,
      voice: typeof saved.voice === 'string' ? saved.voice : '',
      rate: [0.8, 1, 1.2].includes(Number(saved.rate)) ? Number(saved.rate) : DEFAULT_VOICE.rate,
    };
  } catch {
    return { ...DEFAULT_VOICE };
  }
}

/** Saves a change (`{ lang: 'hi' }`) and returns all the choices. */
export function writeVoicePrefs(patch) {
  const next = { ...readVoicePrefs(), ...patch };
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the choice just lasts until the page is closed */
  }
  return next;
}

const langCode = (voice) => String(voice.lang ?? '').toLowerCase().replace('_', '-').split('-')[0];

/** The voices this device has for a language ('en', 'hi'). The list can be empty until the browser has loaded them. */
export function voicesFor(lang) {
  if (!speechSupported()) return [];
  return window.speechSynthesis.getVoices().filter((v) => langCode(v) === lang);
}

/** The chosen voice if this device still has it, else an Indian-English voice for English, else the first voice of the language. */
function pickVoice(prefs) {
  const list = voicesFor(prefs.lang);
  return list.find((v) => v.voiceURI === prefs.voice) ?? (prefs.lang === 'en' ? list.find((v) => v.lang === 'en-IN') : null) ?? list[0] ?? null;
}

/** "T-03" is read as "T 3" (a text-to-speech voice spells "03" badly). */
const spokenTable = (number) =>
  String(number)
    .replace(/[-_]+/g, ' ')
    .replace(/\b0+(?=\d)/g, '')
    .trim();

/** What is said for one new order. `order` is a row of the admin orders list. */
export function orderSentence(order, lang = 'en') {
  const words = VOICE_LANGS[lang] ?? VOICE_LANGS.en;
  const qty = Number(order.total_quantity) || 0;
  const parts = [words.start, words.table(spokenTable(order.table_number))];
  if (qty > 0) parts.push(words.items(qty));
  if (order.payment_status === 'paid') parts.push(words.paid);
  return parts.join(' ');
}

/** What is said when a diner calls the waiter or asks for the bill. */
export function requestSentence(request, lang = 'en') {
  const table = spokenTable(request.table_number);
  if (lang === 'hi') return request.kind === 'bill' ? `टेबल ${table} को बिल चाहिए।` : `टेबल ${table} वेटर को बुला रहा है।`;
  return request.kind === 'bill' ? `Table ${table} wants the bill.` : `Table ${table} is calling the waiter.`;
}

export function speak(text, prefs = readVoicePrefs()) {
  if (!speechSupported()) return false;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = (VOICE_LANGS[prefs.lang] ?? VOICE_LANGS.en).locale;
    utterance.rate = prefs.rate;
    utterance.volume = 1;
    const voice = pickVoice(prefs);
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance); // utterances queue up, so several orders are read one after another
    return true;
  } catch {
    return false;
  }
}

/** Says a made-up order, so the person can hear the chosen voice and speed. */
export const speakSample = (prefs = readVoicePrefs()) =>
  speak(orderSentence({ table_number: 'T-03', total_quantity: 2, payment_status: 'unpaid' }, prefs.lang), prefs);

/** Reads out new orders: each one by itself (up to 3), or a count when a lot arrive at once. Does nothing when voice is off. */
export function announceOrders(orders) {
  const prefs = readVoicePrefs();
  if (!prefs.on || !speechSupported() || orders.length === 0) return false;
  if (orders.length > 3) {
    return speak(prefs.lang === 'en' ? `${orders.length} new orders.` : `${VOICE_LANGS[prefs.lang].start} ${orders.length}`, prefs);
  }
  return orders.map((o) => speak(orderSentence(o, prefs.lang), prefs)).some(Boolean);
}

/** Reads out new waiter / bill requests (up to 3). Does nothing when voice is off. */
export function announceRequests(requests) {
  const prefs = readVoicePrefs();
  if (!prefs.on || !speechSupported() || requests.length === 0) return false;
  return requests.slice(0, 3).map((r) => speak(requestSentence(r, prefs.lang), prefs)).some(Boolean);
}

/** True when new orders will be read out: the browser can speak and the person has not turned it off. */
export const voiceActive = () => speechSupported() && readVoicePrefs().on;
