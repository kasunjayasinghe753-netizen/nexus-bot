
'use strict';

const http = require('http');
const WebSocket = require('ws');

// ==========================================
// CONFIGURATION
// ==========================================

const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'];

const VOLUME_MULTIPLIER = 3;
const HISTORY_LENGTH = 20;
const MIN_HISTORY = 10;

const TAKE_PROFIT_PERCENT = 1.5;
const STOP_LOSS_PERCENT = 1.0;

const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;

const STREAMS = SYMBOLS.map(
  symbol => `${symbol.toLowerCase()}@trade`
).join('/');

const BINANCE_URL =
  `wss://stream.binance.com:443/stream?streams=${STREAMS}`;

// ==========================================
// STATE
// ==========================================

const market = {};

for (const symbol of SYMBOLS) {
  market[symbol] = {
    price: 0,
    minute: null,
    minuteVolume: 0,
    minuteClose: 0,
    history: [],
    lastSignal: 0,
    position: null
  };
}

let ws = null;
let reconnectTimer = null;
let rotationTimer = null;
let reconnectDelay = 1000;
let stopping = false;
let connected = false;

// ==========================================
// TELEGRAM
// ==========================================

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram credentials are missing.');
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML'
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }

    console.log('Telegram notification sent.');
  } catch (error) {
    console.error('Telegram error:', error.message);
  }
}

// ==========================================
// SIGNAL GENERATION
// ==========================================

function generateSignal(symbol, price, volume, average) {
  const state = market[symbol];
  const now = Date.now();

  if (state.position) return;

  if (now - state.lastSignal < SIGNAL_COOLDOWN_MS) {
    return;
  }

  const entry = price;

  const takeProfit =
    entry * (1 + TAKE_PROFIT_PERCENT / 100);

  const stopLoss =
    entry * (1 - STOP_LOSS_PERCENT / 100);

  state.position = {
    entry,
    takeProfit,
    stopLoss,
    openedAt: now
  };

  state.lastSignal = now;

  const message = `
🚨 <b>CRYPTO VOLUME SPIKE</b>

🪙 Coin: <b>${symbol}</b>
📊 Signal: <b>LONG</b>

💰 Entry: ${entry.toFixed(8)}
🎯 Take Profit: ${takeProfit.toFixed(8)}
🛑 Stop Loss: ${stopLoss.toFixed(8)}

📈 Current Volume: ${volume.toFixed(4)}
📉 Average Volume: ${average.toFixed(4)}
🔥 Volume Spike: ${(volume / average).toFixed(2)}x

⏰ Time: ${new Date().toUTCString()}

⚠️ Simulated signal. Not financial advice.
`;

  console.log(message);
  sendTelegram(message);
}

// ==========================================
// VOLUME ANALYSIS
// ==========================================

function processVolume(symbol, tradePrice, tradeQuantity, timestamp) {
  const state = market[symbol];

  const currentMinute = Math.floor(timestamp / 60000);

  if (state.minute === null) {
    state.minute = currentMinute;
  }

  // A new minute has started.
  if (currentMinute > state.minute) {
    const completedVolume = state.minuteVolume;
    const completedPrice = state.minuteClose;

    if (state.history.length >= MIN_HISTORY) {
      const average =
        state.history.reduce((sum, value) => sum + value, 0) /
        state.history.length;

      if (
        average > 0 &&
        completedVolume >= average * VOLUME_MULTIPLIER
      ) {
        generateSignal(
          symbol,
          completedPrice,
          completedVolume,
          average
        );
      }
    }

    state.history.push(completedVolume);

    if (state.history.length > HISTORY_LENGTH) {
      state.history.shift();
    }

    state.minute = currentMinute;
    state.minuteVolume = 0;
  }

  state.minuteVolume += tradeQuantity;
  state.minuteClose = tradePrice;
}

// ==========================================
// TAKE PROFIT / STOP LOSS
// ==========================================

function checkPositions(symbol, price) {
  const state = market[symbol];
  const position = state.position;

  if (!position) return;

  let result = null;

  if (price >= position.takeProfit) {
    result = 'TAKE PROFIT HIT 🎯';
  } else if (price <= position.stopLoss) {
    result = 'STOP LOSS HIT 🛑';
  }

  if (!result) return;

  const profitPercent =
    ((price - position.entry) / position.entry) * 100;

  const message = `
${result}

🪙 Coin: <b>${symbol}</b>

💰 Entry: ${position.entry.toFixed(8)}
📍 Exit: ${price.toFixed(8)}

📊 Result: ${profitPercent.toFixed(2)}%

⏰ Time: ${new Date().toUTCString()}

⚠️ Simulated trade result.
`;

  console.log(message);

  state.position = null;

  sendTelegram(message);
}

// ==========================================
// BINANCE MESSAGE PROCESSING
// ==========================================

function handleMessage(rawData) {
  try {
    const message = JSON.parse(rawData.toString());

    // Combined streams wrap events in data.
    const trade = message.data;

    if (!trade || trade.e !== 'trade') return;

    const symbol = trade.s;

    if (!market[symbol]) return;

    const price = Number(trade.p);
    const quantity = Number(trade.q);
    const timestamp = Number(trade.T);

    if (
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      !Number.isFinite(timestamp) ||
      price <= 0 ||
      quantity <= 0
    ) {
      return;
    }

    const state = market[symbol];

    state.price = price;

    // Check existing simulated positions on every trade.
    checkPositions(symbol, price);

    // Analyze trading volume.
    processVolume(
      symbol,
      price,
      quantity,
      timestamp
    );

  } catch (error) {
    console.error('Message processing error:', error.message);
  }
}

// ==========================================
// WEBSOCKET CONNECTION
// ==========================================

function connectBinance() {
  if (stopping) return;

  console.log('Connecting to Binance...');
  console.log(BINANCE_URL);

  try {
    ws = new WebSocket(BINANCE_URL, {
      handshakeTimeout: 15000,
      perMessageDeflate: false
    });

    ws.on('open', () => {
      console.log('Binance WebSocket connected!');

      connected = true;
      reconnectDelay = 1000;

      // Rotate before Binance's 24-hour connection limit.
      rotationTimer = setTimeout(() => {
        console.log('Scheduled WebSocket rotation.');

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'Scheduled rotation');
        }
      }, 23 * 60 * 60 * 1000 + 50 * 60 * 1000);
    });

    ws.on('message', handleMessage);

    ws.on('error', error => {
      console.error('WebSocket error:', error.message);
    });

    ws.on('close', (code, reason) => {
      console.log(
        'WebSocket disconnected:',
        code,
        reason.toString()
      );

      connected = false;

      clearTimeout(rotationTimer);

      if (!stopping) {
        scheduleReconnect();
      }
    });

  } catch (error) {
    console.error('Connection error:', error.message);
    scheduleReconnect();
  }
}

// ==========================================
// AUTOMATIC RECONNECTION
// ==========================================

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  console.log(
    `Reconnecting in ${reconnectDelay / 1000} seconds...`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBinance();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

// ==========================================
// HTTP SERVER FOR RENDER
// ==========================================

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    res.end(JSON.stringify({
      status: 'running',
      service: 'Crypto Scanner Bot',
      binanceConnected: connected,
      symbols: SYMBOLS,
      uptime: process.uptime()
    }));

    return;
  }

  res.writeHead(404, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify({
    error: 'Not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on port ${PORT}`);

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(
      'WARNING: Telegram credentials are not configured.'
    );
  }

  connectBinance();

  sendTelegram(
    '🤖 <b>Crypto Scanner Bot Started</b>\n\n' +
    'Binance scanner is starting.\n' +
    'Monitoring: BTC, ETH, SOL, DOGE.'
  );
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

function shutdown() {
  if (stopping) return;

  stopping = true;

  console.log('Shutting down bot...');

  clearTimeout(reconnectTimer);
  clearTimeout(rotationTimer);

  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  shutdown();
});
