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
