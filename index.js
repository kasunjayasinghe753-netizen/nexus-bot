const WebSocket = require('ws');
const https = require('https');

// --- ටෙලිග්‍රෑම් සැකසුම් ---
const BOT_TOKEN = "9158004718:AAGHoTKv1viYcp_xRawQIclQF9-IUE-0pxw";
const CHAT_ID = "-1003944785552";

const COIN_POOL = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'];
const futuresBalance = 1000.00;
const userLeverage = 20;
const riskPercent = 2;
const slGapPercent = 4;

let livePrices = {};
let activeSignals = [];

// --- ටෙලිග්‍රෑම් පණිවිඩ යැවීම ---
function sendTelegramAlert(message) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    
    const data = JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
    });

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: '/bot' + BOT_TOKEN + '/sendMessage',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, function(res) {
        console.log('Telegram Status: ' + res.statusCode);
    });

    req.on('error', function(err) {
        console.error("Telegram Error: ", err);
    });

    req.write(data);
    req.end();
}

// --- 1. BINANCE WEBSOCKET ---
function startWebSocket() {
    const streams = COIN_POOL.map(function(coin) { return coin.toLowerCase() + '@ticker'; }).join('/');
    const ws = new WebSocket('wss://://binance.com' + streams);

    ws.on('message', function(data) {
        try {
            const json = JSON.parse(data);
            if (json.s && json.c) {
                livePrices[json.s] = parseFloat(json.c);
                checkTpSlHits(json.s, livePrices[json.s]);
            }
        } catch (e) {
            console.error("JSON Parse Error");
        }
    });

    ws.on('close', function() {
        console.log("WebSocket closed. Reconnecting...");
        setTimeout(startWebSocket, 5000);
    });

    ws.on('error', function(err) {
        console.error("WS Error:", err);
    });
}

// --- 2. COIN SCANNING ENGINE ---
function startScanningEngine() {
    console.log("NEXUS Engine Started...");
    
    setInterval(function() {
        const randomCoin = COIN_POOL[Math.floor(Math.random() * COIN_POOL.length)];
        const currentVolSpike = parseFloat((Math.random() * (2.2 - 0.7) + 0.7).toFixed(2));
        const currentPriceNum = livePrices[randomCoin];

        if (!currentPriceNum) return;

        if (currentVolSpike >= 1.5) {
            const isLong = Math.random() > 0.4;
            const calculatedMargin = (futuresBalance * (riskPercent / 100)).toFixed(2);
            const calculatedQty = ((calculatedMargin * userLeverage) / currentPriceNum).toFixed(4);

            const slFactor = slGapPercent / 100;
            const stopLossTarget = isLong ? (currentPriceNum * (1 - slFactor)) : (currentPriceNum * (1 + slFactor));

            const tpInterval = currentPriceNum * 0.01; 
            const tp1 = isLong ? currentPriceNum + tpInterval : currentPriceNum - tpInterval;
            const tp2 = isLong ? currentPriceNum + (tpInterval * 2) : currentPriceNum - (tpInterval * 2);
            const tp3 = isLong ? currentPriceNum + (tpInterval * 3) : currentPriceNum - (tpInterval * 3);

            const newSignal = {
                id: Date.now(),
                symbol: randomCoin,
                orderType: isLong ? 'BUY LONG' : 'SELL SHORT',
                leverage: userLeverage + 'x',
                entryPrice: currentPriceNum,
                margin: calculatedMargin,
                quantity: calculatedQty,
                tp1: tp1, tp2: tp2, tp3: tp3,
                sl: stopLossTarget,
                status: 'PENDING',
                tp1Hit: false, tp2Hit: false, tp3Hit: false
            };

            activeSignals.push(newSignal);
            console.log("New Signal: " + randomCoin);

            const signalMsg = "🚀 *NEXUS MULTI-SCAN VIP SIGNAL* 🚀\n" +
                "+ 🪙 Asset: #" + randomCoin + "\n" +
                "+ 📈 Direction: " + (isLong ? "🟢 LONG (BUY)" : "🔴 SHORT (SELL)") + "\n" +
                "+ ⚙️ Leverage: " + userLeverage + "x\n\n" +
                "+ 📍 Entry Price: $" + currentPriceNum.toFixed(2) + "\n" +
                "+ 🛡️ Rec. Margin: $" + calculatedMargin + "\n\n" +
                "+ 🎯 TAKE PROFIT TARGETS:\n" +
                "+ 1️⃣ TP1: $" + tp1.toFixed(2) + "\n" +
                "+ 2️⃣ TP2: $" + tp2.toFixed(2) + "\n" +
                "+ 3️⃣ TP3: $" + tp3.toFixed(2) + "\n\n" +
                "+ 🛑 CRITICAL STOP LOSS: $" + stopLossTarget.toFixed(2);

            sendTelegramAlert(signalMsg);
        }
    }, 4000);
}

// --- 3. TP/SL CHECKER ---
function checkTpSlHits(symbol, currentPrice) {
    if (activeSignals.length === 0) return;

    activeSignals = activeSignals.map(function(signal) {
        if (signal.symbol !== symbol || signal.status !== 'PENDING') return signal;

        if (signal.orderType === 'BUY LONG') {
            if (!signal.tp1Hit && currentPrice >= signal.tp1) {
                signal.tp1Hit = true;
                sendTelegramAlert("🎯 *" + signal.symbol + " TAKE PROFIT 1 HIT!* 🚀\n🔥 Profit Target 1 Secured!");
            }
            if (!signal.tp2Hit && currentPrice >= signal.tp2) {
                signal.tp2Hit = true;
                sendTelegramAlert("🎯🎯 *" + signal.symbol + " TAKE PROFIT 2 HIT!!* 🔥\n🚀 Profit Matrix Cleared!");
            }
            if (currentPrice <= signal.sl) {
                signal.status = 'STOP_LOSS_HIT';
                sendTelegramAlert("🛑 *" + signal.symbol + " CRITICAL STOP LOSS HIT.*\nRisk managed effectively.");
            }
        } else {
            if (!signal.tp1Hit && currentPrice <= signal.tp1) {
                signal.tp1Hit = true;
                sendTelegramAlert("🎯 *" + signal.symbol + " SHORT TP1 HIT!* 📉\n🔥 Profit Target Secured!");
            }
            if (!signal.tp2Hit && currentPrice <= signal.tp2) {
                signal.tp2Hit = true;
                sendTelegramAlert("🎯🎯 *" + signal.symbol + " SHORT TP2 HIT!!* 🚀");
            }
            if (currentPrice >= signal.sl) {
                signal.status = 'STOP_LOSS_HIT';
                sendTelegramAlert("🛑 *" + signal.symbol + " SHORT SL HIT.*\nRisk managed.");
            }
        }
        return signal;
    });
}

startWebSocket();
startScanningEngine();

const http = require('http');
http.createServer(function(req, res) {
    res.end("Nexus Scanner Active");
}).listen(process.env.PORT || 3000);
