import { CheckIcon } from './Icons';

const STEPS = [
  { key: 'pending', label: 'Received' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'completed', label: 'Completed' },
];

/** Received -> Accepted -> Completed. (Cancelled orders are shown by the page itself, not as a step.) */
export default function StatusStepper({ status, tone = 'default' }) {
  const light = tone === 'light'; // on a dark brand card
  const current = Math.max(0, STEPS.findIndex((s) => s.key === status));
  const stateOf = (i) => {
    if (i < current) return 'done';
    if (i === current) return status === 'completed' ? 'done' : 'current';
    return 'upcoming';
  };

  return (
    <ol aria-label="Order progress" className="mt-5 flex">
      {STEPS.map((step, i) => {
        const state = stateOf(i);
        const reached = state !== 'upcoming';
        return (
          <li key={step.key} aria-current={state === 'current' ? 'step' : undefined} className="relative flex flex-1 flex-col items-center text-center">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute right-1/2 top-4 h-1 w-full -translate-y-1/2 rounded-full ${reached ? (light ? 'bg-white' : 'bg-brand-600') : light ? 'bg-white/25' : 'bg-line'}`}
              />
            )}
            <span
              aria-hidden="true"
              className={`relative z-10 grid size-8 place-items-center rounded-full text-sm font-bold ${
                light
                  ? state === 'done'
                    ? 'bg-white text-brand-700'
                    : state === 'current'
                      ? 'bg-brand-800 text-white ring-4 ring-white'
                      : 'bg-brand-800 text-white/70 ring-2 ring-white/30'
                  : state === 'done'
                    ? 'bg-brand-600 text-white'
                    : state === 'current'
                      ? 'bg-white text-brand-700 ring-4 ring-brand-600'
                      : 'bg-white text-ink-soft ring-2 ring-line'
              }`}
            >
              {state === 'done' ? (
                <CheckIcon className="size-4" />
              ) : state === 'current' ? (
                <span className={`size-2.5 rounded-full motion-safe:animate-pulse ${light ? 'bg-white' : 'bg-brand-600'}`} />
              ) : (
                i + 1
              )}
            </span>
            <span className={`mt-2 text-xs font-bold ${light ? (reached ? 'text-white' : 'text-white/70') : reached ? 'text-ink' : 'text-ink-soft'}`}>
              {step.label}
              <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ' (not yet)'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
