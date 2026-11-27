import { decryptSecret } from './crypto.js';
import { createPhonepePayment, getPhonepeOrderStatus, refundPhonepe } from './phonepe.js';

// The "send the diner to the gateway's own pay page" gateway: PhonePe. Its flow (see public.js):
//   start  -> we ask the gateway to open a payment for this order and hand the diner the page to go to,
//   status -> later, the server asks the gateway what happened (nothing the browser says is believed),
//   refund -> the admin gives a paid order back.
// A gateway module answers in this shape so the routes do not depend on which gateway it is.
//   start()  -> { type: 'redirect', url }
//   status() -> { state: 'paid' | 'failed' | 'pending', amountPaise?, paymentId? }

const phonepe = {
  label: 'PhonePe',
  enabled: (s) => Boolean(s?.phonepe_enabled),
  configured: (s) => Boolean(s?.phonepe_client_id && s.phonepe_client_version && s.phonepe_secret_enc),
  creds: (s) => ({
    clientId: s.phonepe_client_id,
    clientVersion: s.phonepe_client_version,
    clientSecret: decryptSecret(s.phonepe_secret_enc),
  }),
  async start(creds, { providerOrderId, order, returnUrl }) {
    const r = await createPhonepePayment(creds, {
      merchantOrderId: providerOrderId,
      amountPaise: order.total_paise,
      returnUrl,
      message: `Table ${order.table_number}`,
    });
    return { type: 'redirect', url: r.redirectUrl };
  },
  async status(creds, providerOrderId) {
    const r = await getPhonepeOrderStatus(creds, providerOrderId);
    if (r.state !== 'COMPLETED') return { state: r.state === 'FAILED' ? 'failed' : 'pending' };
    const done = Array.isArray(r.paymentDetails) ? r.paymentDetails.find((p) => p.state === 'COMPLETED') : null;
    return { state: 'paid', amountPaise: Number(r.amount), paymentId: done?.transactionId || r.orderId || null };
  },
  async refund(creds, { payment, refundId, amountPaise }) {
    const r = await refundPhonepe(creds, { merchantRefundId: refundId, originalMerchantOrderId: payment.provider_order_id, amountPaise });
    return { refundId: r.refundId ?? null };
  },
};

export const GATEWAYS = { phonepe };
export const isRedirectGateway = (name) => Object.hasOwn(GATEWAYS, name);

/** Our own id for one payment attempt at the gateway: unique, short, and made only of characters every gateway accepts. */
export const attemptId = (orderId) => `mz_${orderId}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
