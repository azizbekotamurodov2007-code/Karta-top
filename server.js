const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BOT_TOKEN = '9127884649:AAHxKujgBNWpEPMqJzsksXQ4_z1Ruq1puA';
const APP_URL = 'https://karta-top.onrender.com';

const bot = new Telegraf(BOT_TOKEN);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

bot.start((ctx) => {
    ctx.reply("🃏 Kozel (120 ochko) o‘yiniga xush kelibsiz!", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎮 O‘yinni boshlash", web_app: { url: APP_URL } }]
            ]
        }
    });
});

bot.launch().catch(err => {
    console.log("Bot launch warning (e'tiborsiz qoldirish mumkin):", err.message);
});

// 36 talik Kozel kolodasi
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = [
    { rank: '6', points: 0, power: 1 },
    { rank: '7', points: 0, power: 2 },
    { rank: '8', points: 0, power: 3 },
    { rank: '9', points: 0, power: 4 },
    { rank: 'J', points: 2, power: 5 },
    { rank: 'Q', points: 3, power: 6 },
    { rank: 'K', points: 4, power: 7 },
    { rank: '10', points: 10, power: 8 },
    { rank: 'A', points: 11, power: 9 }
];

let rooms = {};

function createDeck() {
    let deck = [];
    for (let s of SUITS) {
        for (let v of VALUES) {
            deck.push({ suit: s, ...v });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({ roomId, playerName }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: [],
                trump: null,
                table: [],
                turnIndex: 0,
                status: 'waiting'
            };
        }

        const room = rooms[roomId];
        if (room.players.length < 2) {
            room.players.push({
                id: socket.id,
                name: playerName || `O'yinchi ${room.players.length + 1}`,
                hand: [],
                gamePoints: 0,
                penaltyPoints: 0
            });
        }

        if (room.players.length === 2 && room.status === 'waiting') {
            startNewRound(roomId);
        } else {
            syncState(roomId);
        }
    });

    socket.on('playCard', ({ roomId, cardIndex }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const playerIdx = room.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== room.turnIndex) return;

        const card = room.players[playerIdx].hand.splice(cardIndex, 1)[0];
        room.table.push({ playerId: socket.id, playerName: room.players[playerIdx].name, card });

        if (room.table.length < room.players.length) {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            syncState(roomId);
        } else {
            syncState(roomId);
            setTimeout(() => finishTrick(roomId), 1200);
        }
    });
});

function startNewRound(roomId) {
    const room = rooms[roomId];
    room.status = 'playing';
    room.deck = createDeck();
    room.trump = room.deck[0];
    room.table = [];
    room.turnIndex = 0;

    room.players.forEach(p => {
        p.hand = room.deck.splice(-4);
        p.gamePoints = 0;
    });

    syncState(roomId);
}

function finishTrick(roomId) {
    const room = rooms[roomId];
    const trumpSuit = room.trump.suit;
    const baseSuit = room.table[0].card.suit;
    let winningMove = room.table[0];

    for (let i = 1; i < room.table.length; i++) {
        const move = room.table[i];
        const isWinTrump = winningMove.card.suit === trumpSuit;
        const isCurTrump = move.card.suit === trumpSuit;

        if (isCurTrump && !isWinTrump) winningMove = move;
        else if (isCurTrump && isWinTrump && move.card.power > winningMove.card.power) winningMove = move;
        else if (!isCurTrump && !isWinTrump && move.card.suit === baseSuit && move.card.power > winningMove.card.power) winningMove = move;
    }

    const wonPoints = room.table.reduce((sum, m) => sum + m.card.points, 0);
    const winner = room.players.find(p => p.id === winningMove.playerId);
    winner.gamePoints += wonPoints;

    const winnerIdx = room.players.findIndex(p => p.id === winningMove.playerId);
    room.turnIndex = winnerIdx;
    room.table = [];

    refillCards(room, winnerIdx);

    if (room.players.every(p => p.hand.length === 0)) {
        evaluateRoundEnd(roomId);
    } else {
        syncState(roomId);
    }
}

function refillCards(room, winnerIdx) {
    const n = room.players.length;
    let order = [];
    for (let i = 0; i < n; i++) order.push((winnerIdx + i) % n);

    let dealing = true;
    while (dealing && room.deck.length > 0) {
        let dealt = false;
        for (let idx of order) {
            if (room.players[idx].hand.length < 4 && room.deck.length > 0) {
                room.players[idx].hand.push(room.deck.pop());
                dealt = true;
            }
        }
        if (!dealt) dealing = false;
    }
}

function evaluateRoundEnd(roomId) {
    const room = rooms[roomId];
    const scores = room.players.map(p => p.gamePoints);

    if (scores[0] !== scores[1]) {
        room.players.forEach(p => {
            if (p.gamePoints <= 20) p.penaltyPoints += 6;
            else if (p.gamePoints <= 40) p.penaltyPoints += 4;
            else if (p.gamePoints <= 60) p.penaltyPoints += 2;
        });
    }

    const loser = room.players.find(p => p.penaltyPoints >= 12);
    if (loser) {
        io.to(roomId).emit('gameOver', { loserName: loser.name });
        delete rooms[roomId];
        return;
    }

    startNewRound(roomId);
}

function syncState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.players.forEach(p => {
        io.to(p.id).emit('state', {
            hand: p.hand,
            trump: room.trump,
            table: room.table,
            turnIndex: room.turnIndex,
            players: room.players.map(pl => ({
                id: pl.id,
                name: pl.name,
                gamePoints: pl.gamePoints,
                penaltyPoints: pl.penaltyPoints,
                cardsCount: pl.hand.length
            })),
            deckCount: room.deck.length
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server ishlamoqda: ${PORT}`));
