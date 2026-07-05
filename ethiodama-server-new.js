/* =====================================================================
   ETHIODAMA — server.js
   Production-style Node.js backend using Express + Socket.io for
   real-time matchmaking and synchronized 1v1 Dama gameplay.
   Chapa payment integration for real ETB wagers.

   Run:
     npm init -y
     npm install express socket.io axios
     node ethiodama-server-new.js
   ===================================================================== */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

/* ---------------------------------------------------------------------
   CHAPA CONFIGURATION
--------------------------------------------------------------------- */
const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY || 'CHASECK_TEST-XIkkd8vbgjUsF94zp7bOvBSgcV2tBdEl';
const CHAPA_BASE_URL = 'https://api.chapa.co/v1';
const YOUR_DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

/* ---------------------------------------------------------------------
   TELEBIRR CONFIGURATION
   ⚠️  Keys ለማንም አታሳይ — server ላይ ብቻ ይቆዩ
   Keys ያሉት: developer.ethiotelecom.et → API → Keys tab
--------------------------------------------------------------------- */
// Ethio Telecom developer portal ራሱ base64 body ብቻ ነው የሚያሳየው
// (PEM headers/footers የሉትም)። ይሄ function ማንኛውም key format ቢመጣ
// ራሱ በራሱ ትክክለኛ PEM structure እንዲይዝ ያደርገዋል።
function normalizePemKey(rawKey, label = 'PRIVATE KEY') {
  if (!rawKey) return '';
  let key = rawKey.trim().replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

  // Headers ካሉት ቀድሞውኑ full PEM ነው - ብቻ normalize
  if (key.includes('-----BEGIN')) {
    return key;
  }

  // Headers ከሌሉት (ራቁት base64 ብቻ) - እራሳችን እንጠቅልለው
  const base64Body = key.replace(/\s+/g, ''); // ማንኛውንም whitespace/newline አጥፋ
  const wrapped = base64Body.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}

const TELEBIRR_CONFIG = {
  appId:      process.env.TELEBIRR_APP_ID      || '1654067384012807',
  appSecret:  process.env.TELEBIRR_APP_SECRET  || 'YOUR_APP_SECRET_HERE',
  fabricAppId: process.env.TELEBIRR_FABRIC_ID  || 'c4182ef8-9249-458a-985e-06d191f4d505',
  shortCode:  process.env.TELEBIRR_SHORTCODE   || '513496',
  publicKey:  normalizePemKey(process.env.TELEBIRR_PUBLIC_KEY  || 'YOUR_PUBLIC_KEY_HERE', 'PUBLIC KEY'),
  privateKey: normalizePemKey(process.env.TELEBIRR_PRIVATE_KEY || 'YOUR_PRIVATE_KEY_HERE', 'PRIVATE KEY'),
  baseUrl: process.env.TELEBIRR_BASE_URL || 'https://196.188.120.3:38443/apiaccess/payment/gateway'
};

/* ---------------------------------------------------------------------
   CONSTANTS
--------------------------------------------------------------------- */
const WAGER_OPTIONS = [0, 5, 10, 25, 50, 100, 200]; // 0 = Free Play
const LOBBY_TIMEOUT_MS = 60 * 1000;
const TURN_TIME_MS = 30 * 1000;
const HOUSE_RAKE_PERCENT = 0.20;

// Startup sanity check — key parsing bugs (escaped \n from env vars) should
// surface immediately in the logs at boot, not silently on the first payment.
(function checkTelebirrKey() {
  const key = TELEBIRR_CONFIG.privateKey || '';
  const usingEnvVar = !!process.env.TELEBIRR_PRIVATE_KEY;
  const lineCount = key.split('\n').length;
  const hasLiteralBackslashN = key.includes('\\n');
  const startsOk = key.trim().startsWith('-----BEGIN');
  const endsOk = key.trim().endsWith('-----END PRIVATE KEY-----') || key.trim().endsWith('-----END RSA PRIVATE KEY-----');

  console.log('[telebirr] key source:', usingEnvVar ? 'ENV VAR (TELEBIRR_PRIVATE_KEY)' : 'code fallback');
  console.log('[telebirr] key length:', key.length, 'chars, lines:', lineCount);
  console.log('[telebirr] first 30 chars:', JSON.stringify(key.slice(0, 30)));
  console.log('[telebirr] last 30 chars:', JSON.stringify(key.slice(-30)));
  console.log('[telebirr] still has literal \\n sequences after cleanup?', hasLiteralBackslashN);

  if (!startsOk || !endsOk || lineCount < 3 || hasLiteralBackslashN) {
    console.warn('[telebirr] ⚠️  WARNING: privateKey does not look like a valid multi-line PEM.');
  } else {
    // Try an actual sign operation with dummy data to catch OpenSSL decoder errors at boot
    try {
      const sign = crypto.createSign('RSA-SHA256');
      sign.update('healthcheck');
      sign.end();
      sign.sign(key, 'base64');
      console.log('[telebirr] ✅ privateKey parses AND signs successfully.');
    } catch (e) {
      console.warn('[telebirr] ⚠️  WARNING: key looks like valid PEM shape but crypto.sign() still fails:', e.message);
    }
  }
})();

/* ---------------------------------------------------------------------
   IN-MEMORY STATE
--------------------------------------------------------------------- */
const queues = {};
WAGER_OPTIONS.forEach(amount => queues[amount] = []);

const games = {};
const pendingPayments = {};

/* ---------------------------------------------------------------------
   ADMIN APPROVAL SYSTEM (works today, no network dependency on Telebirr)
   Player claims they've sent money -> admin (Bisrat) checks their own
   telebirr app -> approves/rejects with one tap -> player's game starts.
--------------------------------------------------------------------- */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ethiodama-admin';
const pendingApprovals = {}; // claimId -> { socketId, wager, createdAt, status }

function generateClaimId() {
  return 'CLM-' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Auto-expire stale unclaimed pending approvals after 30 minutes so memory
// doesn't grow unbounded from abandoned/forgotten claims.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, claim] of Object.entries(pendingApprovals)) {
    if (claim.status === 'pending' && claim.createdAt < cutoff) {
      delete pendingApprovals[id];
    }
  }
}, 5 * 60 * 1000);

/* ---------------------------------------------------------------------
   HELPERS / GAME LOGIC
--------------------------------------------------------------------- */
function calculatePayout(wager) {
  const pot = wager * 2;
  const rake = pot * HOUSE_RAKE_PERCENT;
  return Math.round(pot - rake);
}

function generateTxRef() {
  return 'ETHIODAMA-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function createInitialBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) b[row][col] = { color: 'white', king: false };
    }
  }
  for (let row = 5; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) b[row][col] = { color: 'red', king: false };
    }
  }
  return b;
}

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function getMovesForPiece(board, row, col) {
  const piece = board[row][col];
  if (!piece) return [];
  const moves = [];
  const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  // Flying King: long-range sliding & capture (Ethiopian Dama rules)
  if (piece.king) {
    directions.forEach(([dr, dc]) => {
      let r = row + dr, c = col + dc;
      while (inBounds(r, c) && !board[r][c]) {
        moves.push({ row: r, col: c, isCapture: false });
        r += dr; c += dc;
      }
      if (inBounds(r, c) && board[r][c] && board[r][c].color !== piece.color) {
        const midR = r, midC = c;
        let landR = r + dr, landC = c + dc;
        while (inBounds(landR, landC) && !board[landR][landC]) {
          moves.push({
            row: landR, col: landC, isCapture: true,
            capturedPos: { row: midR, col: midC }
          });
          landR += dr; landC += dc;
        }
      }
    });
    return moves;
  }

  // Standard piece: forward diagonal slides only
  const normalDirections = piece.color === 'red' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
  normalDirections.forEach(([dr, dc]) => {
    const r = row + dr, c = col + dc;
    if (inBounds(r, c) && !board[r][c]) {
      moves.push({ row: r, col: c, isCapture: false });
    }
  });

  // Standard piece captures: all 4 directions allowed
  directions.forEach(([dr, dc]) => {
    const midR = row + dr, midC = col + dc;
    const landR = row + dr * 2, landC = col + dc * 2;
    if (inBounds(landR, landC) && inBounds(midR, midC)) {
      const midPiece = board[midR][midC];
      if (midPiece && midPiece.color !== piece.color && !board[landR][landC]) {
        moves.push({
          row: landR, col: landC, isCapture: true,
          capturedPos: { row: midR, col: midC }
        });
      }
    }
  });

  return moves;
}

function getAllCapturesForPlayer(board, color) {
  let captures = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color) {
        const moves = getMovesForPiece(board, r, c).filter(m => m.isCapture);
        if (moves.length > 0) captures.push({ row: r, col: c, moves });
      }
    }
  }
  return captures;
}

function playerHasAnyMove(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color && getMovesForPiece(board, r, c).length > 0) return true;
    }
  }
  return false;
}

function countPieces(board, color) {
  let count = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] && board[r][c].color === color) count++;
    }
  }
  return count;
}

function isMoveLegal(game, from, to) {
  const board = game.board;
  const piece = board[from.row] && board[from.row][from.col];
  if (!piece) return null;
  if (piece.color !== game.turn) return null;

  if (game.mustContinueCapture &&
      (game.mustContinueCapture.row !== from.row || game.mustContinueCapture.col !== from.col)) {
    return null;
  }

  let legalMoves = getMovesForPiece(board, from.row, from.col);
  const allCaptures = getAllCapturesForPlayer(board, piece.color);

  if (allCaptures.length > 0) {
    const thisPieceCaptures = legalMoves.filter(m => m.isCapture);
    if (thisPieceCaptures.length === 0) return null;
    legalMoves = thisPieceCaptures;
  }

  const match = legalMoves.find(m => m.row === to.row && m.col === to.col);
  return match || null;
}

function applyMove(game, from, move) {
  const board = game.board;
  const piece = board[from.row][from.col];

  board[from.row][from.col] = null;
  board[move.row][move.col] = piece;

  if (move.isCapture) {
    board[move.capturedPos.row][move.capturedPos.col] = null;
  }

  if (piece.color === 'red' && move.row === 0) piece.king = true;
  if (piece.color === 'white' && move.row === 7) piece.king = true;
}

/* ---------------------------------------------------------------------
   CHAPA INTEGRATION
--------------------------------------------------------------------- */
async function initiatePayment(socketId, wager, playerName, playerEmail) {
  const txRef = generateTxRef();
  try {
    const response = await axios.post(
      `${CHAPA_BASE_URL}/transaction/initialize`,
      {
        amount: wager.toString(),
        currency: 'ETB',
        email: playerEmail || 'abebe@chapa.co',
        first_name: playerName || 'Abebe',
        last_name: 'Bikila',
        tx_ref: txRef,
        callback_url: `${YOUR_DOMAIN}/chapa/callback`,
        return_url: `${YOUR_DOMAIN}/payment-success?tx_ref=${txRef}`,
        customization: {
          title: 'EthioDama Wager',
          description: `${wager} ETB Dama Game Wager`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${CHAPA_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    if (response.data.status === 'success') {
      pendingPayments[txRef] = { socketId, wager, status: 'pending', createdAt: Date.now() };
      return { success: true, checkoutUrl: response.data.data.checkout_url, txRef };
    }
    return { success: false, error: 'Chapa initialization failed' };
  } catch (err) {
    console.error('[chapa] initiate error:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

async function verifyPayment(txRef) {
  try {
    const response = await axios.get(`${CHAPA_BASE_URL}/transaction/verify/${txRef}`, {
      headers: { Authorization: `Bearer ${CHAPA_SECRET_KEY}` }
    });
    if (response.data.status === 'success' && response.data.data.status === 'success') {
      return { success: true, data: response.data.data };
    }
    return { success: false, error: 'Payment not completed' };
  } catch (err) {
    console.error('[chapa] verify error:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

/* ---------------------------------------------------------------------
   TELEBIRR INTEGRATION FUNCTIONS
--------------------------------------------------------------------- */
const forge = null; // npm install node-forge if available, else use crypto

/* ---------------------------------------------------------------------
   TELEBIRR C2B WEBCHECKOUT — 3-step flow (per Ethio Telecom's own sample
   code at developer.ethiotelecom.et → C2B WebCheckout Integration):

     Step 1: ApplyFabricToken  → POST {baseUrl}/payment/v1/token
     Step 2: CreateOrder       → POST {baseUrl}/payment/v1/merchant/preOrder
     Step 3: Build a signed querystring ("rawRequest") from the prepay_id
             and redirect the user's browser to {webBaseUrl}{rawRequest}

   IMPORTANT: signing uses RSA-PSS (not plain PKCS1) — this matches the
   Python sample's `pss.new(key)` — a plain PKCS1 signature will be
   silently rejected as an invalid signature by Ethio Telecom's server.
--------------------------------------------------------------------- */
const https = require('https');
const insecureAgent = new https.Agent({ rejectUnauthorized: false }); // sample code uses verify=False

function createNonceStr() {
  return crypto.randomUUID();
}
function createTimeStamp() {
  return Math.floor(Date.now() / 1000).toString();
}
function createMerchantOrderId() {
  return Math.floor(Date.now() / 1000).toString();
}

// Mirrors tools.py's sign(request): joins all top-level key=value pairs
// (expanding biz_content inline, excluding sign/sign_type/etc.), sorts
// alphabetically, joins with "&", then RSA-PSS/SHA256 signs the result.
function buildSignatureInput(requestObj) {
  const excludeFields = ['sign', 'sign_type', 'header', 'refund_info', 'openType', 'raw_request'];
  const join = [];
  for (const key of Object.keys(requestObj)) {
    if (excludeFields.includes(key)) continue;
    if (key === 'biz_content') {
      const biz = requestObj.biz_content;
      for (const k of Object.keys(biz)) join.push(`${k}=${biz[k]}`);
    } else {
      join.push(`${key}=${requestObj[key]}`);
    }
  }
  join.sort();
  return join.join('&');
}

function signWithPrivateKey(data) {
  try {
    // RSA-PSS with SHA256 — matches Python's Crypto.Signature.pss default
    // (MGF1-SHA256, salt length = digest length).
    const signature = crypto.sign('sha256', Buffer.from(data, 'utf8'), {
      key: TELEBIRR_CONFIG.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    });
    return signature.toString('base64');
  } catch (err) {
    console.error('[telebirr] sign error:', err.message);
    return null;
  }
}

function signRequestObject(requestObj) {
  return signWithPrivateKey(buildSignatureInput(requestObj));
}

// Step 1: ApplyFabricToken
async function applyFabricToken() {
  const headers = { 'Content-Type': 'application/json', 'X-APP-Key': TELEBIRR_CONFIG.fabricAppId };
  const payload = { appSecret: TELEBIRR_CONFIG.appSecret };
  const resp = await axios.post(`${TELEBIRR_CONFIG.baseUrl}/payment/v1/token`, payload, {
    headers, httpsAgent: insecureAgent, timeout: 10000
  });
  return resp.data; // expected: { token: "..." }
}

// Step 2: CreateOrder (preOrder)
// msisdn: customer's phone number — best-guess field name for triggering
// a USSD Push to their phone (pending confirmation once whitelisted).
async function createPreOrder(fabricToken, title, amount, msisdn) {
  const merchOrderId = createMerchantOrderId();
  const reqObj = {
    nonce_str: createNonceStr(),
    method: 'payment.preorder',
    timestamp: createTimeStamp(),
    version: '1.0',
    biz_content: {}
  };
  reqObj.biz_content = {
    notify_url: `${YOUR_DOMAIN}/telebirr/notify`,
    appid: TELEBIRR_CONFIG.appId,
    merch_code: TELEBIRR_CONFIG.shortCode,
    merch_order_id: merchOrderId,
    trade_type: 'Checkout',
    title: title,
    total_amount: String(amount),
    trans_currency: 'ETB',
    timeout_express: '120m',
    business_type: 'BuyGoods',
    payee_identifier: TELEBIRR_CONFIG.shortCode,
    payee_identifier_type: '04',
    payee_type: '5000',
    redirect_url: `${YOUR_DOMAIN}/telebirr/success?ref=${merchOrderId}`,
    callback_info: 'From web'
  };
  if (msisdn) {
    reqObj.biz_content.msisdn = msisdn; // best-guess field for USSD push target
  }
  reqObj.sign_type = 'SHA256withRSA';
  reqObj.sign = signRequestObject(reqObj);

  const headers = {
    'Content-Type': 'application/json',
    'X-APP-Key': TELEBIRR_CONFIG.fabricAppId,
    'Authorization': fabricToken
  };
  const resp = await axios.post(`${TELEBIRR_CONFIG.baseUrl}/payment/v1/merchant/preOrder`, reqObj, {
    headers, httpsAgent: insecureAgent, timeout: 10000
  });
  return { data: resp.data, merchOrderId };
}

// Step 3: Build the signed raw querystring from prepay_id
function createRawRequest(prepayId) {
  const maps = {
    appid: TELEBIRR_CONFIG.appId,
    merch_code: TELEBIRR_CONFIG.shortCode,
    nonce_str: createNonceStr(),
    prepay_id: prepayId,
    timestamp: createTimeStamp(),
    sign_type: 'SHA256WithRSA'
  };
  let rawRequest = '';
  for (const key of Object.keys(maps)) rawRequest += `${key}=${maps[key]}&`;
  const sign = signRequestObject(maps);
  rawRequest += `sign=${encodeURIComponent(sign)}`;
  return rawRequest;
}

async function initiateTelebirrPayment(socketId, wager, notifyUrl, msisdn) {
  try {
    // Step 1
    const tokenResult = await applyFabricToken();
    console.log('[telebirr] Step1 ApplyFabricToken response:', JSON.stringify(tokenResult));
    const fabricToken = tokenResult && tokenResult.token;
    if (!fabricToken) {
      return { success: false, error: 'No fabric token in response: ' + JSON.stringify(tokenResult) };
    }

    // Step 2
    const title = `EthioDama Entry Fee - ${wager} ETB`;
    const { data: orderResult, merchOrderId } = await createPreOrder(fabricToken, title, wager, msisdn);
    console.log('[telebirr] Step2 CreateOrder response:', JSON.stringify(orderResult));

    pendingPayments[merchOrderId] = {
      socketId, wager, status: 'pending', createdAt: Date.now(), provider: 'telebirr'
    };

    // USSD Push mode: no prepay_id/redirect needed — Telebirr pushes a PIN
    // prompt straight to the customer's phone and calls notify_url when done.
    if (msisdn) {
      console.log('[telebirr] USSD push requested for', msisdn, '- waiting for notify callback on merchOrderId', merchOrderId);
      return { success: true, mode: 'push', txRef: merchOrderId };
    }

    // Otherwise fall back to browser-redirect checkout (Step 3)
    const prepayId = orderResult && orderResult.biz_content && orderResult.biz_content.prepay_id;
    if (!prepayId) {
      return { success: false, error: 'No prepay_id in response: ' + JSON.stringify(orderResult) };
    }
    const rawRequest = createRawRequest(prepayId);
    const webBaseUrl = process.env.TELEBIRR_WEB_BASE_URL || TELEBIRR_CONFIG.baseUrl + '/payment/v1/checkout?';
    const checkoutUrl = `${webBaseUrl}${rawRequest}&version=1.0&trade_type=Checkout`;
    console.log('[telebirr] Step3 checkoutUrl:', checkoutUrl);
    return { success: true, mode: 'redirect', checkoutUrl, txRef: merchOrderId };
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('[telebirr] request error:', JSON.stringify(details));
    return { success: false, error: typeof details === 'string' ? details : JSON.stringify(details) };
  }
}

/* ---------------------------------------------------------------------
   MANUAL TELEBIRR VERIFICATION (fallback while merchant API access is
   pending IP whitelisting with Ethio Telecom)

   Flow: player sends money directly to the business's personal/merchant
   telebirr number (like sending to a friend — no API needed), then
   submits the SMS receipt number. We fetch the PUBLIC receipt page
   (https://transactioninfo.ethiotelecom.et/receipt/{receiptNo}) — this
   is not the restricted merchant API, so it works from any server — and
   verify the amount and receiving account match before crediting.
--------------------------------------------------------------------- */
const BUSINESS_TELEBIRR_NUMBER = process.env.BUSINESS_TELEBIRR_NUMBER || '0941160435';

// Persisted to disk so a server restart/redeploy can't let an old receipt
// be reused. Note: on Render's free tier the filesystem is wiped on a
// fresh deploy (not on a simple restart) — for stronger guarantees later,
// move this to a real database.
const USED_RECEIPTS_FILE = path.join(__dirname, 'used_telebirr_receipts.json');
let usedTelebirrReceipts = new Set();
try {
  if (fs.existsSync(USED_RECEIPTS_FILE)) {
    usedTelebirrReceipts = new Set(JSON.parse(fs.readFileSync(USED_RECEIPTS_FILE, 'utf8')));
    console.log(`[manual-verify] loaded ${usedTelebirrReceipts.size} previously used receipts`);
  }
} catch (e) {
  console.warn('[manual-verify] could not load used receipts file:', e.message);
}
function persistUsedReceipts() {
  try {
    fs.writeFileSync(USED_RECEIPTS_FILE, JSON.stringify([...usedTelebirrReceipts]));
  } catch (e) {
    console.warn('[manual-verify] could not persist used receipts:', e.message);
  }
}

function extractTdTexts(html) {
  const matches = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
  return matches.map(m =>
    m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
        .replace(/[\n\r\t]/g, '').replace(/\s+/g, ' ').trim()
  );
}

// Mirrors the field labels Ethio Telecom's receipt page uses (Amharic/English combined, no spaces)
const RECEIPT_LABEL_MAP = {
  'የከፋይስም/payername': 'payer_name',
  'የከፋይቴሌብርቁ./payertelebirrno.': 'payer_phone',
  'የገንዘብተቀባይስም/creditedpartyname': 'credited_party_name',
  'የገንዘብተቀባይቴሌብርቁ./creditedpartyaccountno': 'credited_party_acc_no',
  'የክፍያውሁኔታ/transactionstatus': 'transaction_status',
  'የክፍያቁጥር/receiptno.': 'receiptNo',
  'የክፍያቀን/paymentdate': 'date',
  'የተከፈለውመጠን/settledamount': 'settled_amount',
  'ጠቅላላየተክፈለ/totalamountpaid': 'total_amount'
};

function parseTelebirrReceiptHTML(html) {
  const td = extractTdTexts(html);
  const fields = {};
  td.forEach((text, i) => {
    const key = text.replace(/\s+/g, '').toLowerCase();
    const fieldName = RECEIPT_LABEL_MAP[key];
    if (fieldName && i + 1 < td.length) {
      let value = td[i + 1];
      if (fieldName.endsWith('amount')) value = parseFloat(value.replace(/birr/ig, '').trim());
      fields[fieldName] = value;
    }
  });
  return fields;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTelebirrReceipt(receiptNo) {
  const url = `https://transactioninfo.ethiotelecom.et/receipt/${receiptNo}`;
  const resp = await axios.get(url, { httpsAgent: insecureAgent, timeout: 10000 });
  return parseTelebirrReceiptHTML(resp.data);
}

async function verifyTelebirrReceipt(receiptNo, expectedAmount) {
  if (!receiptNo || typeof receiptNo !== 'string' || receiptNo.trim().length < 3) {
    return { valid: false, reason: 'ትክክለኛ receipt ቁጥር አስገባ' };
  }
  receiptNo = receiptNo.trim().toUpperCase();

  if (usedTelebirrReceipts.has(receiptNo)) {
    return { valid: false, reason: 'ይህ receipt ቀድሞ ጥቅም ላይ ውሏል' };
  }

  // Ethio Telecom's receipt lookup can lag a few seconds behind the SMS —
  // retry a few times before telling the player it's genuinely not found.
  let fields = {};
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    fields = await fetchTelebirrReceipt(receiptNo);
    if (fields.receiptNo || fields.credited_party_acc_no) break;
    if (attempt < maxAttempts) await sleep(4000);
  }

  if (!fields.receiptNo && !fields.credited_party_acc_no) {
    return { valid: false, reason: 'Receipt ገና አልተገኘም - ከጥቂት ሰከንድ በኋላ እንደገና ሞክር', retryable: true };
  }

  const paidAmount = fields.total_amount || fields.settled_amount || 0;
  if (paidAmount < expectedAmount) {
    return { valid: false, reason: `የተከፈለው መጠን (${paidAmount} ETB) ከሚጠበቀው (${expectedAmount} ETB) ያንሳል` };
  }

  const last8 = BUSINESS_TELEBIRR_NUMBER.slice(-8);
  const receiverOk = fields.credited_party_acc_no && fields.credited_party_acc_no.includes(last8);
  if (!receiverOk) {
    return { valid: false, reason: 'ገንዘቡ ወደ ትክክለኛው telebirr አካውንት አልገባም' };
  }

  const statusOk = !fields.transaction_status || /success|complete|ተጠናቅ/i.test(fields.transaction_status);
  if (!statusOk) {
    return { valid: false, reason: `የክፍያ ሁኔታ: ${fields.transaction_status}` };
  }

  usedTelebirrReceipts.add(receiptNo);
  persistUsedReceipts();
  return { valid: true, fields };
}

/* ---------------------------------------------------------------------
   HTTP ROUTES
--------------------------------------------------------------------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ethiodama.html'));
});

app.all('/chapa/callback', async (req, res) => {
  // Webhook Security: verify x-chapa-signature via SHA256 HMAC
  const chapaSignature = req.headers['x-chapa-signature'];
  if (chapaSignature) {
    const payload = JSON.stringify(req.body);
    const expectedSig = crypto
      .createHmac('sha256', CHAPA_SECRET_KEY)
      .update(payload)
      .digest('hex');
    if (chapaSignature !== expectedSig) {
      console.warn('[chapa] Invalid signature - request rejected');
      return res.status(401).json({ message: 'Invalid signature' });
    }
  }

  const trx_ref = (req.body && (req.body.trx_ref || req.body.tx_ref)) ||
                  (req.query && (req.query.trx_ref || req.query.tx_ref));

  if (!trx_ref || !pendingPayments[trx_ref]) {
    return res.status(400).json({ message: 'Unknown transaction' });
  }

  const payment = pendingPayments[trx_ref];
  const verification = await verifyPayment(trx_ref);

  if (verification.success) {
    payment.status = 'paid';
    const socket = io.sockets.sockets.get(payment.socketId);
    if (socket) {
      socket.emit('payment_confirmed', { wager: payment.wager, txRef: trx_ref });
      joinQueue(socket, payment.wager);
    }
  } else {
    payment.status = 'failed';
    const socket = io.sockets.sockets.get(payment.socketId);
    if (socket) socket.emit('payment_failed', { txRef: trx_ref });
  }

  res.json({ message: 'ok' });
});

app.get('/payment-success', (req, res) => {
  res.send(`
    <html>
    <body style="font-family:sans-serif;text-align:center;padding:50px;background:#121212;color:white">
      <h1 style="color:#FFD700">✅ ክፍያዎ ተፈፅሟል!</h1>
      <p>ወደ ጨዋታው ገፅ እየተመለሱ ነው...</p>
      <script>setTimeout(() => { window.close(); }, 2500);</script>
    </body>
    </html>
  `);
});

// Telebirr payment callback
app.post('/telebirr/notify', async (req, res) => {
  console.log('[telebirr] notify received:', JSON.stringify(req.body));
  // Field names are a best-guess until we see a real payload from Ethio Telecom —
  // accept several likely variants so we don't silently drop a real notification.
  const body = req.body || {};
  const bizContent = body.biz_content || body;
  const orderId = bizContent.merch_order_id || bizContent.outTradeNo || bizContent.order_id || body.merch_order_id;
  const status = bizContent.trade_status || bizContent.tradeStatus || bizContent.status || body.trade_status;

  if (!orderId || !pendingPayments[orderId]) {
    console.warn('[telebirr] notify: unknown/missing order id', orderId);
    return res.status(400).json({ code: '400', msg: 'Unknown transaction' });
  }

  const payment = pendingPayments[orderId];
  const isSuccess = /success|complete|2|paid/i.test(String(status));

  if (isSuccess) {
    payment.status = 'paid';
    const socket = io.sockets.sockets.get(payment.socketId);
    if (socket) {
      socket.emit('payment_confirmed', { wager: payment.wager, txRef: orderId });
      joinQueue(socket, payment.wager);
    }
  } else {
    payment.status = 'failed';
    const socket = io.sockets.sockets.get(payment.socketId);
    if (socket) socket.emit('payment_failed', { txRef: orderId, message: `Status: ${status}` });
  }

  res.json({ code: '200', msg: 'success' });
});

app.post('/telebirr/callback', async (req, res) => {
  console.log('[telebirr] callback received:', req.body);
  const { outTradeNo, tradeStatus } = req.body;

  if (!outTradeNo || !pendingPayments[outTradeNo]) {
    return res.status(400).json({ code: '400', msg: 'Unknown transaction' });
  }

  const payment = pendingPayments[outTradeNo];

  if (tradeStatus === 'SUCCESS' || tradeStatus === '2') {
    payment.status = 'paid';
    const socket = io.sockets.sockets.get(payment.socketId);
    if (socket) {
      socket.emit('payment_confirmed', { wager: payment.wager, txRef: outTradeNo });
      joinQueue(socket, payment.wager);
    }
  } else {
    payment.status = 'failed';
    const socket = io.sockets.sockets.get(payment.socketId);
    if (socket) socket.emit('payment_failed', { txRef: outTradeNo });
  }

  res.json({ code: '200', msg: 'success' });
});

// Telebirr success redirect
app.get('/telebirr/success', (req, res) => {
  res.send(`
    <html>
    <body style="font-family:sans-serif;text-align:center;padding:50px;background:#121212;color:white">
      <h1 style="color:#FFD700">✅ ክፍያዎ ተፈፅሟል!</h1>
      <p>ወደ ጨዋታው ገፅ እየተመለሱ ነው...</p>
      <script>setTimeout(() => { window.close(); }, 2500);</script>
    </body>
    </html>
  `);
});

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>EthioDama Admin</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  body { font-family: system-ui, sans-serif; background:#111; color:#eee; margin:0; padding:16px; }
  h2 { color:#fff; }
  #loginBox input { padding:10px; width:100%; box-sizing:border-box; margin-bottom:10px; border-radius:8px; border:1px solid #555; background:#222; color:#fff; }
  #loginBox button, .claim button { padding:10px 16px; border-radius:8px; border:none; font-weight:bold; cursor:pointer; }
  #loginBox button { width:100%; background:#28a745; color:#fff; }
  .claim { background:#1e1e1e; border-radius:10px; padding:14px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; }
  .claim .info b { font-size:1.2em; }
  .claim .actions button { margin-left:8px; }
  .approve { background:#28a745; color:#fff; }
  .reject { background:#dc3545; color:#fff; }
  #empty { color:#888; text-align:center; margin-top:40px; }
</style>
</head>
<body>
  <div id="loginBox">
    <h2>🔐 EthioDama Admin</h2>
    <input type="password" id="pwInput" placeholder="Admin password" />
    <button onclick="login()">ግባ</button>
  </div>
  <div id="dashboard" style="display:none">
    <h2>💰 Pending Payment Claims</h2>
    <div id="claimsList"></div>
    <div id="empty">ምንም pending claim የለም</div>
  </div>
<script>
  const socket = io();
  const claims = {};

  function login() {
    socket.emit('admin_login', { password: document.getElementById('pwInput').value });
  }
  document.getElementById('pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

  socket.on('admin_login_success', ({ pending }) => {
    document.getElementById('loginBox').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    pending.forEach(c => { claims[c.claimId] = c; });
    render();
  });
  socket.on('admin_login_failed', () => alert('የተሳሳተ password'));

  socket.on('new_claim', (c) => { claims[c.claimId] = c; render(); playBeep(); });
  socket.on('claim_resolved', ({ claimId }) => { delete claims[claimId]; render(); });

  function render() {
    const list = document.getElementById('claimsList');
    const ids = Object.keys(claims);
    document.getElementById('empty').style.display = ids.length ? 'none' : 'block';
    list.innerHTML = ids.map(id => {
      const c = claims[id];
      const secondsAgo = Math.floor((Date.now() - c.createdAt) / 1000);
      return \`<div class="claim">
        <div class="info"><b>\${c.wager} ETB</b><br><small>\${id} — \${secondsAgo}s ago</small></div>
        <div class="actions">
          <button class="approve" onclick="approve('\${id}')">✅ Approve</button>
          <button class="reject" onclick="reject('\${id}')">❌ Reject</button>
        </div>
      </div>\`;
    }).join('');
  }
  function approve(id) { socket.emit('admin_approve', { claimId: id }); }
  function reject(id) { socket.emit('admin_reject', { claimId: id }); }
  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.start(); setTimeout(() => osc.stop(), 200);
    } catch (e) {}
  }
  setInterval(render, 1000); // keep "Xs ago" fresh
</script>
</body></html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeGames: Object.keys(games).length,
    pendingPayments: Object.keys(pendingPayments).length
  });
});

/* ---------------------------------------------------------------------
   MATCHMAKING
--------------------------------------------------------------------- */
function joinQueue(socket, wager) {
  // ከ queue ውስጥ ካለ አታስገባ
  if (queues[wager].includes(socket.id)) return;
  queues[wager].push(socket.id);

  // Dead sockets አጸዳ — live player ፈልግ
  let opponentSocket = null;
  while (queues[wager].length >= 2) {
    const p1Id = queues[wager].shift();
    const p2Id = queues[wager].shift();
    const p1 = io.sockets.sockets.get(p1Id);
    const p2 = io.sockets.sockets.get(p2Id);

    if (p1 && p2) {
      createGameSession(wager, p1, p2);
      return;
    }
    // Dead socket ካለ live አንዱን ወደ queue መልስ
    if (p1) queues[wager].unshift(p1Id);
    if (p2) queues[wager].unshift(p2Id);
    break;
  }
}

function createGameSession(wager, p1, p2) {
  const roomId = 'ROOM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  games[roomId] = {
    id: roomId,
    wager,
    payout: calculatePayout(wager),
    board: createInitialBoard(),
    turn: 'red',
    players: { red: p1.id, white: p2.id },
    mustContinueCapture: null,
    timer: null,
    timeLeft: TURN_TIME_MS / 1000
  };

  p1.join(roomId);
  p2.join(roomId);

  // HTML role ይጠብቃል — color ሳይሆን
  p1.emit('match_found', { roomId, role: 'red', wager, payout: calculatePayout(wager) });
  p2.emit('match_found', { roomId, role: 'white', wager, payout: calculatePayout(wager) });

  sendGameState(roomId);
  startTurnTimer(roomId);
}

function sendGameState(roomId) {
  const game = games[roomId];
  if (!game) return;
  io.to(roomId).emit('game_state', {
    board: game.board,
    turn: game.turn,
    mustContinueCapture: game.mustContinueCapture
  });
}

function startTurnTimer(roomId) {
  const game = games[roomId];
  if (!game) return;

  if (game.timer) clearInterval(game.timer);
  game.timeLeft = TURN_TIME_MS / 1000;

  game.timer = setInterval(() => {
    const g = games[roomId];
    if (!g) return clearInterval(game.timer);

    g.timeLeft--;
    io.to(roomId).emit('timer_update', { timeLeft: g.timeLeft });

    if (g.timeLeft <= 0) {
      clearInterval(g.timer);
      const winnerColor = g.turn === 'red' ? 'white' : 'red';
      endGame(roomId, winnerColor, 'timeout');
    }
  }, 1000);
}

function checkGameOver(roomId) {
  const game = games[roomId];
  const board = game.board;

  if (countPieces(board, 'red') === 0) { endGame(roomId, 'white', 'capture'); return true; }
  if (countPieces(board, 'white') === 0) { endGame(roomId, 'red', 'capture'); return true; }

  const nextTurn = game.turn === 'red' ? 'white' : 'red';
  if (!playerHasAnyMove(board, nextTurn)) {
    endGame(roomId, game.turn, 'stalemate');
    return true;
  }
  return false;
}

function endGame(roomId, winnerColor, reason) {
  const game = games[roomId];
  if (!game) return;

  if (game.timer) clearInterval(game.timer);

  // HTML result: 'win' or 'lose' per player
  const redSocket = io.sockets.sockets.get(game.players.red);
  const whiteSocket = io.sockets.sockets.get(game.players.white);

  if (redSocket) {
    redSocket.emit('game_over', {
      result: winnerColor === 'red' ? 'win' : 'lose',
      reason, payout: winnerColor === 'red' ? game.payout : 0, wager: game.wager
    });
    redSocket.leave(roomId);
  }
  if (whiteSocket) {
    whiteSocket.emit('game_over', {
      result: winnerColor === 'white' ? 'win' : 'lose',
      reason, payout: winnerColor === 'white' ? game.payout : 0, wager: game.wager
    });
    whiteSocket.leave(roomId);
  }

  delete games[roomId];
}

/* ---------------------------------------------------------------------
   SOCKET EVENTS
--------------------------------------------------------------------- */
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('initiate_payment', async ({ wager, name, email, provider }) => {
    if (!WAGER_OPTIONS.includes(wager)) {
      return socket.emit('error_message', { message: 'የተሳሳተ የብር መጠን!' });
    }

    let result;
    const paymentProvider = provider || 'chapa'; // default chapa

    if (paymentProvider === 'telebirr') {
      result = await initiateTelebirrPayment(
        socket.id, wager,
        `${YOUR_DOMAIN}/telebirr/callback`
      );
    } else {
      result = await initiatePayment(socket.id, wager, name, email);
    }

    if (result.success) {
      socket.emit('payment_url', {
        checkoutUrl: result.checkoutUrl,
        txRef: result.txRef,
        wager,
        provider: paymentProvider
      });
    } else {
      // Chapa ካልሰራ Telebirr ሞክር
      if (paymentProvider === 'chapa') {
        console.log('[payment] Chapa failed, trying Telebirr fallback...');
        const fallback = await initiateTelebirrPayment(
          socket.id, wager,
          `${YOUR_DOMAIN}/telebirr/callback`
        );
        if (fallback.success) {
          socket.emit('payment_url', {
            checkoutUrl: fallback.checkoutUrl,
            txRef: fallback.txRef,
            wager,
            provider: 'telebirr'
          });
          return;
        }
      }
      socket.emit('error_message', { message: 'ክፍያ ማስኬድ አልተቻለም። እንደገና ይሞክሩ።' });
    }
  });

  socket.on('initiate_ussd_push', async ({ wager, msisdn }) => {
    if (!msisdn || !/^0\d{9}$/.test(msisdn)) {
      socket.emit('error_message', { message: 'ትክክለኛ ስልክ ቁጥር አስገባ (ለምሳሌ 0912345678)' });
      return;
    }
    const result = await initiateTelebirrPayment(socket.id, wager, `${YOUR_DOMAIN}/telebirr/notify`, msisdn);
    if (result.success) {
      socket.emit('ussd_push_sent', { txRef: result.txRef });
    } else {
      socket.emit('error_message', { message: result.error || 'USSD push አልተላከም' });
    }
  });

  socket.on('claim_payment_sent', ({ wager }) => {
    const claimId = generateClaimId();
    pendingApprovals[claimId] = { socketId: socket.id, wager, createdAt: Date.now(), status: 'pending' };
    socket.emit('claim_registered', { claimId });
    io.to('admins').emit('new_claim', { claimId, wager, createdAt: Date.now() });
  });

  socket.on('admin_login', ({ password }) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      const pending = Object.entries(pendingApprovals)
        .filter(([, c]) => c.status === 'pending')
        .map(([claimId, c]) => ({ claimId, wager: c.wager, createdAt: c.createdAt }));
      socket.emit('admin_login_success', { pending });
    } else {
      socket.emit('admin_login_failed');
    }
  });

  socket.on('admin_approve', ({ claimId }) => {
    if (!socket.rooms.has('admins')) return;
    const claim = pendingApprovals[claimId];
    if (!claim || claim.status !== 'pending') return;
    claim.status = 'approved';
    const playerSocket = io.sockets.sockets.get(claim.socketId);
    if (playerSocket) {
      playerSocket.emit('payment_confirmed', { wager: claim.wager });
      joinQueue(playerSocket, claim.wager);
    }
    io.to('admins').emit('claim_resolved', { claimId });
  });

  socket.on('admin_reject', ({ claimId }) => {
    if (!socket.rooms.has('admins')) return;
    const claim = pendingApprovals[claimId];
    if (!claim || claim.status !== 'pending') return;
    claim.status = 'rejected';
    const playerSocket = io.sockets.sockets.get(claim.socketId);
    if (playerSocket) playerSocket.emit('payment_failed', { message: 'ክፍያ አልተረጋገጠም - Admin ውድቅ አድርጎታል' });
    io.to('admins').emit('claim_resolved', { claimId });
  });

  socket.on('verify_manual_receipt', async ({ receiptNo, wager }) => {
    try {
      const result = await verifyTelebirrReceipt(receiptNo, wager);
      if (result.valid) {
        socket.emit('payment_confirmed', { wager, payerName: result.fields.payer_name || null });
        joinQueue(socket, wager);
      } else {
        socket.emit('payment_failed', { message: result.reason, retryable: !!result.retryable });
      }
    } catch (err) {
      console.error('[manual-verify] error:', err.message);
      socket.emit('error_message', { message: 'Receipt ማረጋገጥ አልተቻለም፣ እንደገና ሞክር' });
    }
  });

  socket.on('verify_payment', async ({ txRef }) => {
    const payment = pendingPayments[txRef];
    if (!payment || payment.socketId !== socket.id) {
      return socket.emit('payment_failed', { txRef });
    }
    if (payment.status === 'paid') {
      socket.emit('payment_confirmed', { wager: payment.wager, txRef });
      joinQueue(socket, payment.wager);
      return;
    }
    const result = await verifyPayment(txRef);
    if (result.success) {
      payment.status = 'paid';
      socket.emit('payment_confirmed', { wager: payment.wager, txRef });
      joinQueue(socket, payment.wager);
    } else {
      socket.emit('payment_failed', { txRef });
    }
  });

  socket.on('join_queue_free', ({ wager }) => {
    // Free Play queue — wager=0 ይፈቀዳል
    const w = wager === 0 ? 0 : wager;
    if (!WAGER_OPTIONS.includes(w)) return;
    joinQueue(socket, w);
  });

  socket.on('leave_queue', () => {
    WAGER_OPTIONS.forEach(w => {
      queues[w] = queues[w].filter(id => id !== socket.id);
    });
  });

  socket.on('cancel_queue', ({ wager }) => {
    if (queues[wager]) {
      queues[wager] = queues[wager].filter(id => id !== socket.id);
    }
  });

  socket.on('make_move', ({ from, to }) => {
    // roomId ን ከ socket ጋር ከ games ውስጥ ፈልግ
    const roomId = Object.keys(games).find(id =>
      games[id].players.red === socket.id || games[id].players.white === socket.id
    );
    if (!roomId) return;

    const game = games[roomId];
    if (game.players[game.turn] !== socket.id) return;

    const move = isMoveLegal(game, from, to);
    if (!move) return socket.emit('error_message', { message: 'Illegal move.' });

    applyMove(game, from, move);

    if (move.isCapture) {
      const moreMoves = getMovesForPiece(game.board, move.row, move.col).filter(m => m.isCapture);
      if (moreMoves.length > 0) {
        game.mustContinueCapture = { row: move.row, col: move.col };
        sendGameState(roomId);
        return;
      }
    }

    game.mustContinueCapture = null;
    if (checkGameOver(roomId)) return;

    game.turn = game.turn === 'red' ? 'white' : 'red';
    startTurnTimer(roomId);
    sendGameState(roomId);
  });

  socket.on('forfeit', () => {
    const roomId = Object.keys(games).find(id =>
      games[id].players.red === socket.id || games[id].players.white === socket.id
    );
    if (!roomId) return;
    const game = games[roomId];
    const winnerColor = game.players.red === socket.id ? 'white' : 'red';
    endGame(roomId, winnerColor, 'forfeit');
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    WAGER_OPTIONS.forEach(w => {
      queues[w] = queues[w].filter(id => id !== socket.id);
    });
    for (const roomId in games) {
      const game = games[roomId];
      if (game.players.red === socket.id || game.players.white === socket.id) {
        const winnerColor = game.players.red === socket.id ? 'white' : 'red';
        endGame(roomId, winnerColor, 'disconnect');
        break;
      }
    }
  });
});

server.listen(PORT, () => console.log(`EthioDama server running on port ${PORT}`));
