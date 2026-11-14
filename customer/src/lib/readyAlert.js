// "Your order is ready": a short vibration and a two-note chime, so a diner who is looking elsewhere notices. Browsers only allow
// sound after the person has tapped the page, which they have (they placed the order here); if audio is still locked it stays silent.

let context = null;

export function alertOrderReady() {
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    /* not supported */
  }
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    if (context.state === 'suspended') context.resume().catch(() => {});
    if (context.state !== 'running') return;
    const start = context.currentTime + 0.02;
    [[880, 0], [1175, 0.22]].forEach(([frequency, offset]) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.3, start + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.5);
      osc.connect(gain).connect(context.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.55);
    });
  } catch {
    /* silent */
  }
}
