import { HttpError } from './errors.js';
import { decryptSecret } from './crypto.js';
import { createPhonepePayment, getPhonepeOrderStatus, refundPhonepe } from './phonepe.js';
import { getPaytmStatus, initiatePaytmTransaction, paytmPayPage, refundPaytm } from './paytm.js';

// The "send the diner to the gateway's own pay page" gateways: PhonePe and Paytm. They share one flow (see public.js):
//   start  -> we ask the gateway to open a payment for this order and hand the diner the page to go to,
//   status -> later, the server asks the gateway what happened (nothing the browser says is believed),
//   refund -> the admin gives a paid order back.
// Each gateway module answers in the same shape so the routes do not care which one the restaurant uses.
//   start()  -> { type: 'redirect', url } | { type: 'form', action, fields }
//   status() -> { state: 'paid' | 'failed' | 'pending', amountPaise?, paymentId? }

const phonepe = {
  label: 'PhonePe',
  enabled: (s) => Boolean(s?.phonepe_enabled),
  configured: (s) => Boolean(s?.phonepe_client_id && s.phonepe_client_version && s.phonepe_secret_enc),
  creds: (s) => ({
    clientId: s.phonepe_client_id,
    clientVersion: s.phonepe_client_version,
    clientSecret: decryptSecret(s.phonepe_secret_enc),
    env: s.phonepe_env,
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

const paytm = {
  label: 'Paytm',
  enabled: (s) => Boolean(s?.paytm_enabled),
  configured: (s) => Boolean(s?.paytm_mid && s.paytm_key_enc),
  creds: (s) => ({ mid: s.paytm_mid, key: decryptSecret(s.paytm_key_enc), website: s.paytm_website || null, env: s.paytm_env }),
  async start(creds, { providerOrderId, order, callbackUrl }) {
    const { txnToken, theiaBase } = await initiatePaytmTransaction(creds, {
      orderId: providerOrderId,
      amountPaise: order.total_paise,
      customerId: `order_${order.id}`,
      callbackUrl,
    });
    return { type: 'form', ...paytmPayPage({ theiaBase, mid: creds.mid, orderId: providerOrderId, txnToken }) };
  },
  async status(creds, providerOrderId) {
    const { body, verified } = await getPaytmStatus(creds, providerOrderId);
    const result = body.resultInfo.resultStatus;
    if (result !== 'TXN_SUCCESS') return { state: result === 'TXN_FAILURE' ? 'failed' : 'pending' };
    // "Paid" is only believed when Paytm's own signature checks out and the answer is about this merchant and this order.
    if (!verified || String(body.orderId) !== providerOrderId || (body.mid && String(body.mid) !== creds.mid)) {
      throw new HttpError(502, 'PAYTM_BAD_RESPONSE', "We could not verify Paytm's answer, so the payment was not recorded. Please show this screen to a member of staff.");
    }
    return { state: 'paid', amountPaise: Math.round(Number(body.txnAmount) * 100), paymentId: body.txnId ? String(body.txnId) : null };
  },
  async refund(creds, { payment, refundId, amountPaise }) {
    if (!payment.provider_payment_id) throw new HttpError(409, 'REFUND_MANUAL', "We can't find the Paytm transaction id for this order. Refund it from your Paytm dashboard.");
    const r = await refundPaytm(creds, { orderId: payment.provider_order_id, txnId: payment.provider_payment_id, refId: refundId, amountPaise });
    return { refundId: r.refundId ?? null };
  },
};

export const GATEWAYS = { phonepe, paytm };
export const isRedirectGateway = (name) => Object.hasOwn(GATEWAYS, name);

/** Our own id for one payment attempt at the gateway: unique, short, and made only of characters every gateway accepts. */
export const attemptId = (orderId) => `mz_${orderId}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
