import EmptyState from '../components/EmptyState';
import { LinkButton } from '../components/Button';
import { QrIcon } from '../components/Icons';
import { usePageTitle } from '../lib/usePageTitle';

export default function NotFound() {
  usePageTitle('Page not found - MezMitra');
  return (
    <main className="flex min-h-dvh flex-col justify-center">
      <EmptyState
        icon={<QrIcon className="size-8" />}
        title="We can't find that page"
        action={<LinkButton to="/" block>Go to the start</LinkButton>}
      >
        The link may be incomplete. Scan the QR code on your table to open the menu.
      </EmptyState>
    </main>
  );
}
