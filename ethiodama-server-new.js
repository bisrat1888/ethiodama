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
async function createPreOrder(fabricToken, title, amount) {
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

async function initiateTelebirrPayment(socketId, wager, notifyUrl) {
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
    const { data: orderResult, merchOrderId } = await createPreOrder(fabricToken, title, wager);
    console.log('[telebirr] Step2 CreateOrder response:', JSON.stringify(orderResult));

    const prepayId = orderResult && orderResult.biz_content && orderResult.biz_content.prepay_id;
    if (!prepayId) {
      return { success: false, error: 'No prepay_id in response: ' + JSON.stringify(orderResult) };
    }

    // Step 3 — build the checkout URL. webBaseUrl isn't published in the
    // portal's own code samples (inconsistency on their end); override
    // via TELEBIRR_WEB_BASE_URL once confirmed with Ethio Telecom support.
    const rawRequest = createRawRequest(prepayId);
    const webBaseUrl = process.env.TELEBIRR_WEB_BASE_URL || TELEBIRR_CONFIG.baseUrl + '/payment/v1/checkout?';
    const checkoutUrl = `${webBaseUrl}${rawRequest}&version=1.0&trade_type=Checkout`;
    console.log('[telebirr] Step3 checkoutUrl:', checkoutUrl);

    pendingPayments[merchOrderId] = {
      socketId, wager, status: 'pending', createdAt: Date.now(), provider: 'telebirr'
    };
    return { success: true, checkoutUrl, txRef: merchOrderId };
  } catch (err) {
    const details = err.response?.data || err.message;
    console.error('[telebirr] request error:', JSON.stringify(details));
    return { success: false, error: typeof details === 'string' ? details : JSON.stringify(details) };
  }
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
