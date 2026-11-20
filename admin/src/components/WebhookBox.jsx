import { Badge } from './Badge.jsx';
import { Button } from './Button.jsx';
import { CopyIcon } from './icons.jsx';
import { useToast } from './Toast.jsx';

/**
 * "Confirm payments automatically": the address the restaurant pastes into its gateway's dashboard (the gateway then tells our server
 * the moment a payment arrives, even if the diner closed the page), and the secret fields (children). `steps` are the few clicks to make
 * in the gateway's dashboard.
 */
export default function WebhookBox({ url, isSet, steps, children }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Webhook address copied.');
    } catch {
      toast.error('Could not copy. Select the address and copy it by hand.');
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Confirm payments automatically (webhook)</h3>
        <Badge tone={isSet ? 'green' : 'amber'}>{isSet ? 'Set up' : 'Not set up yet'}</Badge>
      </div>
      <p className="text-sm text-slate-600">
        Without this, a payment is noticed when the diner comes back to the order page, and otherwise within a few minutes. With it, the order turns paid the moment the money
        arrives, even if the diner has closed the page.
      </p>

      <div>
        <p className="text-xs font-medium text-slate-500">Webhook address (private to your restaurant)</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 basis-64 break-all rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800">{url}</code>
          <Button variant="secondary" size="sm" icon={CopyIcon} onClick={copy}>
            Copy
          </Button>
        </div>
      </div>

      {children}

      <details className="text-sm text-slate-700">
        <summary className="cursor-pointer font-medium text-slate-900">How to set it up</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5">{steps}</ol>
      </details>
    </div>
  );
}
