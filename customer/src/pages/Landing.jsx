import { lazy, Suspense, useCallback, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { MenuBookIcon, QrIcon } from '../components/Icons';
import { parseTableLink } from '../lib/ids';
import { usePageTitle } from '../lib/usePageTitle';

// The scanner (and the jsQR decoder it pulls in) is only downloaded when a diner taps "Scan".
const QrScanner = lazy(() => import('../components/QrScanner'));

// Decorative QR-style art (not a real code).
const QR = [
  '11101011101',
  '10100100101',
  '11101110111',
  '00001000000',
  '10110110101',
  '01001101010',
  '11010011001',
  '00001010010',
  '11100101101',
  '10101110010',
  '11100011011',
];

function QrArt() {
  return (
    <svg viewBox="-1 -1 13 13" aria-hidden="true" focusable="false" className="size-full text-brand-800">
      {QR.flatMap((row, y) =>
        [...row].map((bit, x) => (bit === '1' ? <rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" rx="0.18" fill="currentColor" /> : null)),
      )}
    </svg>
  );
}

const STEPS = [
  ['Scan', 'Point your phone camera at the QR code on your table.'],
  ['Choose', 'Browse the menu and add what you like.'],
  ['Order & pay', 'Send it to the kitchen, then pay with any UPI app.'],
];

export default function Landing() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const scanButton = useRef(null);
  const inputId = useId();
  const errorId = useId();
  usePageTitle('MezMitra - Order from your table');

  const onToken = useCallback((token) => navigate(`/t/${token}`), [navigate]);
  const closeScanner = useCallback(() => {
    setScanning(false);
    requestAnimationFrame(() => scanButton.current?.focus());
  }, []);

  const submit = (event) => {
    event.preventDefault();
    const token = parseTableLink(value);
    if (!token) {
      setError(
        value.trim()
          ? "That doesn't look like a table link. Paste the full link from your QR code, or just the 32-character code at the end of it."
          : 'Paste your table link first.',
      );
      return;
    }
    navigate(`/t/${token}`);
  };

  return (
    <main className="flex min-h-dvh flex-col">
      <section className="relative overflow-hidden rounded-b-[2rem] bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 px-5 pb-8 pt-[calc(1.75rem+env(safe-area-inset-top))] text-white">
        <span aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-saffron-300/30 blur-3xl" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-20 size-60 rounded-full bg-brand-400/35 blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span className="grid size-10 place-items-center rounded-xl bg-white/15 text-white ring-1 ring-inset ring-white/25">
              <MenuBookIcon className="size-6" />
            </span>
            <span className="text-xl font-extrabold tracking-tight">MezMitra</span>
          </div>

          <div className="mt-8 flex items-center gap-5">
            <div className="min-w-0 flex-1">
              <h1 className="display text-[34px] font-extrabold leading-[1.05]">
                Order from your table, <span className="text-saffron-300">no waiting.</span>
              </h1>
              <p className="mt-3 text-base text-white/80">Scan the QR code on your table with your phone camera.</p>
            </div>
            {/* The picture is only decoration; on the narrowest phones the headline gets the whole width instead. */}
            <div className="relative hidden size-28 shrink-0 place-items-center rounded-[1.75rem] bg-white p-3 shadow-float min-[360px]:grid">
              <QrArt />
              <span aria-hidden="true" className="absolute inset-x-3 top-3 h-0.5 rounded-full bg-brand-400 shadow-md motion-safe:animate-scan" />
            </div>
          </div>

          <button
            ref={scanButton}
            type="button"
            onClick={() => setScanning(true)}
            className="mt-7 inline-flex min-h-14 w-full items-center justify-center gap-2.5 rounded-2xl bg-white px-5 text-lg font-extrabold text-brand-800 shadow-float transition-colors hover:bg-brand-50 active:bg-brand-100"
          >
            <QrIcon className="size-6" />
            Scan QR code
          </button>
        </div>
      </section>

      <div className="flex flex-1 flex-col px-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <ol className="mt-8 space-y-3">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="surface flex gap-3 !rounded-3xl p-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-extrabold text-brand-800">{i + 1}</span>
            <div>
              <p className="font-extrabold text-ink">{title}</p>
              <p className="text-sm text-ink-soft">{text}</p>
            </div>
          </li>
        ))}
      </ol>

      <form onSubmit={submit} noValidate className="mt-8 rounded-3xl bg-brand-800 p-4 text-white shadow-float">
        <label htmlFor={inputId} className="text-base font-extrabold">
          Paste your table link
        </label>
        <p className="mt-0.5 text-sm text-brand-100">Can&apos;t scan? Paste the link from the QR code, or just its 32-character code.</p>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError('');
          }}
          placeholder="https://…/t/1a2b3c…"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="focus-on-dark mt-3 block min-h-12 w-full rounded-2xl border-0 bg-white px-4 text-ink ring-1 ring-inset ring-white/30 placeholder:text-ink-soft/70"
        />
        {error && (
          <p id={errorId} role="alert" className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-900">
            {error}
          </p>
        )}
        <Button type="submit" block variant="secondary" className="focus-on-dark mt-3">
          Open menu
        </Button>
      </form>

      <p className="mt-auto pt-8 text-center text-xs text-ink-soft">Need help? Ask a member of staff.</p>

      {scanning && (
        <Suspense fallback={null}>
          <QrScanner onToken={onToken} onClose={closeScanner} />
        </Suspense>
      )}
      </div>
    </main>
  );
}
