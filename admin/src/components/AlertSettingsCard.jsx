import { useEffect, useState } from 'react';
import { Button } from './Button.jsx';
import { Card, CardHeader } from './Card.jsx';
import { Alert } from './EmptyState.jsx';
import { Select, SwitchField } from './Field.jsx';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { readVoicePrefs, speakSample, speechSupported, VOICE_LANGS, VOICE_SPEEDS, voicesFor, writeVoicePrefs } from '../lib/orderAlert.js';

/** Voices arrive a moment after the page opens (browsers announce them with an event), so re-read the list when they do. */
function useVoicesLoaded() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!speechSupported()) return undefined;
    const synth = window.speechSynthesis;
    const bump = () => setVersion((v) => v + 1);
    synth.addEventListener?.('voiceschanged', bump);
    bump();
    return () => synth.removeEventListener?.('voiceschanged', bump);
  }, []);
}

/** The sound and voice for new orders. Choices apply immediately and are kept on this device (every device has its own voices). */
export default function AlertSettingsCard() {
  const { sound } = useLiveOrders();
  const [prefs, setPrefs] = useState(readVoicePrefs);
  useVoicesLoaded();
  const change = (patch) => setPrefs(writeVoicePrefs(patch));

  const supported = speechSupported();
  const voices = supported ? voicesFor(prefs.lang) : [];
  const language = VOICE_LANGS[prefs.lang];
  const waiting = sound.on && !sound.ready;

  return (
    <Card as="section" aria-labelledby="alerts">
      <CardHeader id="alerts" title="New-order alerts" description="Saved on this device only: every phone or computer keeps its own choices." />
      <div className="space-y-5 p-4 sm:p-5">
        {sound.supported && (
          <SwitchField
            label="Sound for new orders"
            description={waiting ? 'On, but your browser wants one click to allow sound. Click this switch once.' : 'Plays a chime when an order arrives. Your browser needs one click to allow sound.'}
            checked={sound.on}
            onChange={() => sound.toggle()}
          />
        )}

        <SwitchField
          label="Read new orders out loud"
          description={
            supported ? 'Says the table and the number of items after the chime, like “New order. Table 3. 2 items.”' : 'This browser cannot read text out loud, so you will only hear the chime.'
          }
          checked={supported && prefs.on}
          disabled={!supported}
          onChange={(on) => change({ on })}
        />

        {supported && prefs.on && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Select label="Language" value={prefs.lang} onChange={(e) => change({ lang: e.target.value, voice: '' })}>
                {Object.entries(VOICE_LANGS).map(([code, l]) => (
                  <option key={code} value={code}>
                    {l.label}
                  </option>
                ))}
              </Select>
              <Select
                label="Voice"
                value={prefs.voice}
                disabled={voices.length === 0}
                onChange={(e) => change({ voice: e.target.value })}
                hint={voices.length === 0 ? 'No voice for this language on this device.' : undefined}
              >
                <option value="">Automatic</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name}
                  </option>
                ))}
              </Select>
              <Select label="Speed" value={String(prefs.rate)} onChange={(e) => change({ rate: Number(e.target.value) })}>
                {VOICE_SPEEDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>

            {voices.length === 0 && (
              <Alert tone="warning">
                This device has no {language.label} voice, so the order may be read badly or not at all. Choose English, or add a {language.label} voice in this device’s
                language / accessibility settings. (Many computers have only English.)
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3">
              <Button variant="secondary" onClick={() => speakSample(prefs)}>
                Test voice
              </Button>
              <p className="min-w-0 flex-1 basis-48 text-xs text-slate-500">Plays a made-up order so you can hear the chosen voice and speed.</p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
