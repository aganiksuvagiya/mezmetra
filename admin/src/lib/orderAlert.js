import { dishInHindi } from './hindiWords.js';

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
// A kitchen is loud and nobody stares at the screen, so each new order is also read out ("New order. Table 3. 1 Tea, 2 Samosa.") with the
// browser's own text-to-speech: nothing to ship, and it works offline. Like the chime it needs one click on the page first.
// The choices (on/off, language, voice, speed) are kept per device, because every phone and computer has its own voices.

const VOICE_KEY = 'mezmitra_order_voice';

/** "T-03" is read as "T 3" (a text-to-speech voice spells "03" badly). */
const spokenTable = (number) =>
  String(number)
    .replace(/[-_]+/g, ' ')
    .replace(/\b0+(?=\d)/g, '')
    .trim();

// How the English letters of a table name are said in Hindi; a Hindi voice reads the bare letters badly.
const HINDI_LETTERS = {
  A: 'ए', B: 'बी', C: 'सी', D: 'डी', E: 'ई', F: 'एफ', G: 'जी', H: 'एच', I: 'आई', J: 'जे', K: 'के', L: 'एल', M: 'एम',
  N: 'एन', O: 'ओ', P: 'पी', Q: 'क्यू', R: 'आर', S: 'एस', T: 'टी', U: 'यू', V: 'वी', W: 'डब्ल्यू', X: 'एक्स', Y: 'वाई', Z: 'ज़ेड',
};

/** A table the way staff say it in Hindi: "T-03" and "Table 3" are "टेबल नंबर 3", "A-2" is "टेबल ए 2". Longer names stay as written. */
const hindiTable = (number) => {
  const name = spokenTable(number)
    .replace(/^(?:t|tbl|table)\s*(?=\d)/i, '') // the T of "T-3" only means "table"
    .replace(/([A-Za-z])(?=\d)/g, '$1 ')
    .replace(/\b0+(?=\d)/g, '')
    .replace(/\b[A-Za-z]{1,2}\b/g, (letters) => [...letters.toUpperCase()].map((letter) => HINDI_LETTERS[letter]).join(' '));
  return /^\d+$/.test(name) ? `टेबल नंबर ${name}` : `टेबल ${name}`;
};

/** What is said, per language. `locale` is the BCP-47 tag the voice is looked up by. */
export const VOICE_LANGS = {
  en: {
    label: 'English',
    locale: 'en-IN',
    start: 'New order.',
    table: (number) => `Table ${spokenTable(number)}.`,
    items: (n) => `${n} ${n === 1 ? 'item' : 'items'}.`,
    paid: 'Paid online.',
    more: (n) => `And ${n} more, see the screen.`,
    many: (n) => `${n} new orders.`,
    waiter: (number) => `Table ${spokenTable(number)} is calling the waiter.`,
    bill: (number) => `Table ${spokenTable(number)} wants the bill.`,
    sample: 'Voice is on. New orders will be read out.',
  },
  hi: {
    label: 'हिन्दी (Hindi)',
    locale: 'hi-IN',
    start: 'नया ऑर्डर आया है।',
    table: (number) => `${hindiTable(number)}।`,
    items: (n) => `${n} आइटम।`,
    paid: 'ऑनलाइन पेमेंट हो चुका है।',
    more: (n) => `और ${n} आइटम स्क्रीन पर देखें।`,
    many: (n) => `${n} नए ऑर्डर आए हैं।`,
    waiter: (number) => `${hindiTable(number)} पर वेटर को बुलाया है।`,
    bill: (number) => `${hindiTable(number)} पर बिल माँगा है।`,
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

// Devices often list a plain, mechanical voice first. These marks in a voice's name pick a better one, best first: Google's Hindi
// voice was chosen by ear; the others are the natural voices of browsers that have no Google one.
const NATURAL_NAMES = [/^google/i, /natural|neural/i, /premium/i, /enhanced/i];
const naturalness = (voice) => {
  const at = NATURAL_NAMES.findIndex((pattern) => pattern.test(voice.name ?? ''));
  return at < 0 ? 0 : NATURAL_NAMES.length - at;
};

/** The voices this device has for a language ('en', 'hi'), the Hindi ones most natural first. The list can be empty until the browser has loaded them. */
export function voicesFor(lang) {
  if (!speechSupported()) return [];
  const list = window.speechSynthesis.getVoices().filter((v) => langCode(v) === lang);
  return lang === 'hi' ? list.sort((a, b) => naturalness(b) - naturalness(a)) : list;
}

/** A device with voices but none for Hindi would mangle the Hindi text, so it is read in English there instead. */
function usablePrefs(prefs) {
  const missing = prefs.lang !== 'en' && speechSupported() && window.speechSynthesis.getVoices().length > 0 && voicesFor(prefs.lang).length === 0;
  return missing ? { ...prefs, lang: 'en', voice: '' } : prefs;
}

/** The chosen voice if this device still has it, else an Indian-English voice for English, else the first voice of the language. */
function pickVoice(prefs) {
  const list = voicesFor(prefs.lang);
  return list.find((v) => v.voiceURI === prefs.voice) ?? (prefs.lang === 'en' ? list.find((v) => v.lang === 'en-IN') : null) ?? list[0] ?? null;
}

/** How many different dishes are named before the voice sends staff to the screen (a very long sentence helps nobody). */
const DISHES_SPOKEN = 6;

/** [name, how many] of each dish in the order; the same dish ordered twice (say, with different extras) is counted once. */
function dishesOf(order) {
  const counts = new Map();
  for (const line of order.items ?? []) {
    const name = String(line.name ?? '').trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + (Number(line.quantity) || 1));
  }
  return [...counts];
}

/** The sentences for one new order. `order` is a row of the admin orders list. */
function orderSentences(order, lang) {
  const words = VOICE_LANGS[lang] ?? VOICE_LANGS.en;
  const parts = [words.start, words.table(order.table_number)];
  const dishes = dishesOf(order);
  const qty = Number(order.total_quantity) || 0;
  if (dishes.length > 0) {
    const named = dishes.slice(0, DISHES_SPOKEN);
    // In Hindi every dish is its own sentence, with its name written in Hindi.
    if (lang === 'hi') parts.push(...named.map(([name, count]) => `${count} ${dishInHindi(name)}।`));
    else parts.push(`${named.map(([name, count]) => `${count} ${name}`).join(', ')}.`);
    if (dishes.length > DISHES_SPOKEN) parts.push(words.more(dishes.length - DISHES_SPOKEN));
  } else if (qty > 0) parts.push(words.items(qty));
  if (order.payment_status === 'paid') parts.push(words.paid);
  return parts;
}

/** What is said for one new order, as one text. */
export const orderSentence = (order, lang = 'en') => orderSentences(order, lang).join(' ');

/** Reads one order. In Hindi each sentence is spoken by itself, which leaves a short pause between the dishes. */
function sayOrder(order, prefs) {
  const texts = prefs.lang === 'hi' ? orderSentences(order, 'hi') : [orderSentence(order, prefs.lang)];
  return texts.map((text) => speak(text, prefs)).some(Boolean);
}

/** What is said when a diner calls the waiter or asks for the bill. */
export function requestSentence(request, lang = 'en') {
  const words = VOICE_LANGS[lang] ?? VOICE_LANGS.en;
  return (request.kind === 'bill' ? words.bill : words.waiter)(request.table_number);
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
export function speakSample(prefs = readVoicePrefs()) {
  const usable = usablePrefs(prefs);
  const items = [{ name: 'Cutting Chai', quantity: 1 }, { name: 'Bun Maska', quantity: 2 }];
  return sayOrder({ table_number: 'T-03', items, total_quantity: 3, payment_status: 'unpaid' }, usable);
}

/** Reads out new orders: each one by itself (up to 3), or a count when a lot arrive at once. Does nothing when voice is off. */
export function announceOrders(orders) {
  const prefs = usablePrefs(readVoicePrefs());
  if (!prefs.on || !speechSupported() || orders.length === 0) return false;
  if (orders.length > 3) return speak(VOICE_LANGS[prefs.lang].many(orders.length), prefs);
  return orders.map((o) => sayOrder(o, prefs)).some(Boolean);
}

/** Reads out new waiter / bill requests (up to 3). Does nothing when voice is off. */
export function announceRequests(requests) {
  const prefs = usablePrefs(readVoicePrefs());
  if (!prefs.on || !speechSupported() || requests.length === 0) return false;
  return requests.slice(0, 3).map((r) => speak(requestSentence(r, prefs.lang), prefs)).some(Boolean);
}

/** True when new orders will be read out: the browser can speak and the person has not turned it off. */
export const voiceActive = () => speechSupported() && readVoicePrefs().on;
