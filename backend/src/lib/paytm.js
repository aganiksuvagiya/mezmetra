import PaytmChecksum from 'paytmchecksum';
import { config } from '../config.js';
import { HttpError } from './errors.js';

// Paytm Payment Gateway: Initiate Transaction + Show Payment Page + Transaction Status + Refund (server to server, signed with the
// merchant key). Each restaurant brings its own merchant account (MID + Merchant Key). Docs: paytmpayments.com/docs.
// The two sets of hosts are the ones the docs print for staging. For live the docs did not print them, so two candidates are tried
// in order (the new paytmpayments hosts, then the long-standing securegw.paytm.in); PAYTM_THEIA_BASE / PAYTM_STATUS_BASE override both.
const HOSTS = {
  sandbox: { theia: ['https://securestage.paytmpayments.com'], status: ['https://securegw-stage.paytmpayments.in'] },
  live: {
    theia: ['https://secure.paytmpayments.com', 'https://securegw.paytm.in'],
    status: ['https://securegw.paytmpayments.in', 'https://securegw.paytm.in'],
  },
};
const candidates = (env, kind) => {
  const override = kind === 'theia' ? config.paytmTheiaBase : config.paytmStatusBase;
  return override ? [override] : HOSTS[env === 'live' ? 'live' : 'sandbox'][kind];
};

/** A Merchant ID looks like DIY12386817555501617 (letters and digits); the Merchant Key is exactly 16 characters (an AES-128 key). */
export const MID_RE = /^[A-Za-z0-9_@.-]{6,30}$/;
export const MERCHANT_KEY_LENGTH = 16;
export const WEBSITE_RE = /^[A-Za-z0-9_-]{1,30}$/;

/** "Website name" Paytm expects: WEBSTAGING for the sandbox, DEFAULT for live, unless the restaurant's account says otherwise. */
export const websiteFor = (creds) => creds.website || (creds.env === 'live' ? 'DEFAULT' : 'WEBSTAGING');

const rupees = (paise) => (paise / 100).toFixed(2);

/** Posts a signed request to the first host that answers. Returns { json, verified, base } (verified = Paytm's own signature checked out). */
async function signedPost(creds, kind, path, body, query = '') {
  const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), creds.key);
  const payload = JSON.stringify({ body, head: { signature } });
  let lastError;
  for (const base of candidates(creds.env, kind)) {
    let res;
    try {
      res = await fetch(`${base}${path}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      lastError = err; // this host did not answer (or does not exist): try the next one
      continue;
    }
    const json = await res.json().catch(() => ({}));
    let verified = false;
    try {
      if (json?.head?.signature && json?.body) verified = await PaytmChecksum.verifySignature(JSON.stringify(json.body), creds.key, json.head.signature);
    } catch {
      verified = false; // a signature made with another key cannot even be decrypted
    }
    return { json, verified, base, status: res.status };
  }
  throw new HttpError(502, 'PAYTM_UNREACHABLE', `Could not reach Paytm (${lastError?.cause?.code || lastError?.message || 'no answer'}). Please try again in a moment.`);
}

// Result codes that mean "your Merchant ID or Merchant Key is wrong" rather than "this payment has a problem".
const BAD_KEY_CODES = new Set(['330', '335', '2005']); // checksum invalid (refund / initiate), Merchant ID invalid
const keyProblem = (info) => Boolean(info) && BAD_KEY_CODES.has(String(info.resultCode));

function fail(info, fallback) {
  const message = info?.resultMsg || fallback;
  return new HttpError(502, keyProblem(info) ? 'PAYTM_BAD_KEYS' : 'PAYTM_ERROR', message);
}

/** Starts a payment: returns the token the Paytm pay page needs, and the host that issued it. `orderId` is our own unique id (max 50). */
export async function initiatePaytmTransaction(creds, { orderId, amountPaise, customerId, callbackUrl }) {
  const { json, verified, base } = await signedPost(
    creds,
    'theia',
    '/theia/api/v1/initiateTransaction',
    {
      requestType: 'Payment',
      mid: creds.mid,
      websiteName: websiteFor(creds),
      orderId,
      callbackUrl,
      txnAmount: { value: rupees(amountPaise), currency: 'INR' },
      userInfo: { custId: customerId },
    },
    `?mid=${encodeURIComponent(creds.mid)}&orderId=${encodeURIComponent(orderId)}`,
  );
  const info = json?.body?.resultInfo;
  const txnToken = json?.body?.txnToken;
  if (info?.resultStatus !== 'S' || !txnToken) throw fail(info, 'Paytm could not start this payment.');
  if (!verified) throw new HttpError(502, 'PAYTM_BAD_RESPONSE', "We could not verify Paytm's answer. Check the Merchant Key in Payments settings.");
  return { txnToken, theiaBase: base };
}

/** The pay page the diner is sent to (a form POST with mid, orderId and txnToken). */
export const paytmPayPage = ({ theiaBase, mid, orderId, txnToken }) => ({
  action: `${theiaBase}/theia/api/v1/showPaymentPage?mid=${encodeURIComponent(mid)}&orderId=${encodeURIComponent(orderId)}`,
  fields: { mid, orderId, txnToken },
});

/** The transaction as Paytm sees it. `resultInfo.resultStatus` is TXN_SUCCESS, TXN_FAILURE, PENDING or NO_RECORD_FOUND. */
export async function getPaytmStatus(creds, orderId) {
  const { json, verified } = await signedPost(creds, 'status', '/v3/order/status', { mid: creds.mid, orderId });
  const body = json?.body;
  if (!body?.resultInfo) throw new HttpError(502, 'PAYTM_ERROR', 'Paytm sent an answer we could not read.');
  return { body, verified };
}

/** Asks Paytm to give a payment back. Paytm answers PENDING (accepted, being processed) or TXN_SUCCESS; anything else is a refusal. */
export async function refundPaytm(creds, { orderId, txnId, refId, amountPaise }) {
  const { json, verified } = await signedPost(creds, 'status', '/refund/apply', {
    mid: creds.mid,
    txnType: 'REFUND',
    orderId,
    txnId,
    refId,
    refundAmount: rupees(amountPaise),
  });
  const info = json?.body?.resultInfo;
  if (!verified) throw new HttpError(502, 'PAYTM_BAD_RESPONSE', "We could not verify Paytm's answer. Please check the refund in your Paytm dashboard.");
  if (!['PENDING', 'TXN_SUCCESS'].includes(info?.resultStatus)) throw fail(info, 'Paytm did not accept the refund.');
  return json.body;
}

/**
 * Used by the admin "Test connection" button. Paytm has no "who am I" call, so we ask for the status of an order that cannot exist:
 * the right keys get a signed "no such order"; a wrong Merchant ID or Merchant Key does not.
 */
export async function pingPaytm(creds) {
  const { json, verified } = await signedPost(creds, 'status', '/v3/order/status', { mid: creds.mid, orderId: 'mezmitra_connection_check' });
  const info = json?.body?.resultInfo;
  if (keyProblem(info) || !verified) {
    throw new HttpError(502, 'PAYTM_BAD_KEYS', info?.resultMsg || "Paytm's answer could not be verified. Check the Merchant ID, the Merchant Key and whether they are staging or live.");
  }
  return true;
}
