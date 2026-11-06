// Smoke test: proves we can move sandbox money with PayPal Payouts.
//
//   node --env-file=.env.local scripts/smoke-payout.mjs             # send a $1.00 sandbox payout
//   node --env-file=.env.local scripts/smoke-payout.mjs --dry-run   # get a token, print the request, send nothing
//
// No dependencies: uses Node's built-in fetch (Node 20.6+ for --env-file).
// Secrets are read from the environment and are never printed.

// Hardcoded on purpose: this script can only ever talk to the PayPal SANDBOX.
const BASE_URL = 'https://api-m.sandbox.paypal.com';
const POLL_EVERY_MS = 3000;
const POLL_MAX_TRIES = 10; // ~30 seconds
const dryRun = process.argv.includes('--dry-run');

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_TEST_RECEIVER,
  PAYPAL_ENVIRONMENT,
} = process.env;

// --- Guards -----------------------------------------------------------------

if (PAYPAL_ENVIRONMENT && PAYPAL_ENVIRONMENT.trim().toUpperCase() !== 'SANDBOX') {
  console.error('Refusing to run: PAYPAL_ENVIRONMENT must be SANDBOX (or unset).');
  process.exit(1);
}

const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_TEST_RECEIVER'].filter(
  (name) => !process.env[name],
);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Fill them in .env.local (see .env.example).');
  process.exit(1);
}

// --- Helpers ----------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// sb-abcdef@personal.example.com -> sb-ab***@personal.example.com
function maskEmail(email = '') {
  const [local = '', domain = ''] = email.split('@');
  const keep = Math.min(5, Math.floor(local.length / 2));
  return `${local.slice(0, keep)}***@${domain}`;
}

// Print PayPal's error in a readable form, add a hint, and stop.
function fail(res, data) {
  console.error(`\nPayPal returned HTTP ${res.status}`);
  // REST errors use name/message/debug_id; the OAuth endpoint uses error/error_description.
  console.error(`  name:     ${data.name ?? data.error ?? '(none)'}`);
  console.error(`  message:  ${data.message ?? data.error_description ?? '(none)'}`);
  console.error(`  debug_id: ${data.debug_id ?? res.headers.get('paypal-debug-id') ?? '(none)'}`);
  if (data.details) console.error(`  details:  ${JSON.stringify(data.details)}`);

  if (res.status === 401) {
    console.error('\nHint: wrong credentials, or live and sandbox apps are mixed up. Use the Client ID and Secret from the Sandbox tab.');
  } else if (res.status === 403 || /AUTHORIZATION/i.test(String(data.name))) {
    console.error('\nHint: Payouts may not be enabled for this sandbox app. Check the app\'s features in the PayPal dashboard.');
  }
  process.exit(1);
}

// Call the sandbox API. Exits with a readable message on any non-2xx response.
async function paypal(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 300) }; // not JSON (e.g. an HTML error page)
  }
  if (!res.ok) fail(res, data);
  return data;
}

// --- Steps ------------------------------------------------------------------

async function getAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const data = await paypal('POST', '/v1/oauth2/token', {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  return data.access_token; // never printed
}

async function main() {
  const token = await getAccessToken();
  console.log('Authenticated with the PayPal sandbox.');

  // NOTE: in the real app the batch ID will be derived from bounty ID + PR number
  // (e.g. `bounty-<bountyId>-pr-<number>`), so a retry can never double-pay:
  // PayPal rejects a reused sender_batch_id for 30 days. Here we use a timestamp
  // so every smoke-test run is a fresh payout.
  const batchId = `smoke-${Date.now()}`;

  const payout = {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'BountyPilot sandbox smoke test',
      recipient_type: 'EMAIL',
    },
    items: [
      {
        amount: { value: '1.00', currency: 'USD' },
        receiver: PAYPAL_TEST_RECEIVER,
        note: 'BountyPilot sandbox smoke test payout',
        sender_item_id: `${batchId}-item-1`,
      },
    ],
  };

  if (dryRun) {
    // Show what would be sent, with the receiver masked.
    const shown = structuredClone(payout);
    shown.items[0].receiver = maskEmail(PAYPAL_TEST_RECEIVER);
    console.log('\n--dry-run: nothing will be sent. Request that would be made:');
    console.log(`POST ${BASE_URL}/v1/payments/payouts`);
    console.log(`PayPal-Request-Id: ${batchId}`);
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  // PayPal-Request-Id makes the call idempotent: same ID = same result, not a second payout.
  const created = await paypal('POST', '/v1/payments/payouts', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': batchId,
    },
    body: JSON.stringify(payout),
  });
  const payoutBatchId = created.batch_header.payout_batch_id;
  console.log(`Payout created: ${payoutBatchId}. Waiting for it to settle...`);

  // Poll until the batch leaves PENDING / PROCESSING.
  let result;
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await sleep(POLL_EVERY_MS);
    result = await paypal('GET', `/v1/payments/payouts/${payoutBatchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = result.batch_header.batch_status;
    if (status !== 'PENDING' && status !== 'PROCESSING') break;
  }

  const batchStatus = result.batch_header.batch_status;
  const items = result.items ?? [];
  console.log('\n--- Summary ---');
  console.log(`Payout batch ID: ${payoutBatchId}`);
  console.log(`Batch status:    ${batchStatus}`);
  for (const item of items) {
    console.log(`Item: ${maskEmail(item.payout_item?.receiver)}  ->  ${item.transaction_status}`);
  }

  const settled = batchStatus === 'SUCCESS' && items.every((i) => i.transaction_status === 'SUCCESS');
  if (settled) {
    console.log('\nSuccess. Log in to https://sandbox.paypal.com with the sandbox personal account to see the $1.00.');
  } else {
    console.error('\nThe payout was created but has not settled as SUCCESS (see statuses above).');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
