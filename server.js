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

bot.launch().catch(err => console.log("Bot warning:", err.message));

// 36 talik Burkozel kolodasi (jami 120 ochko)
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
            deck.push({
                suit: s,
                rank: v.rank,
                points: v.points,
                power: v.power,
                id: Math.random().toString(36).substring(2, 9)
            });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({ roomId, playerName, mode, teamChoice }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                mode: mode || '1v1', // '1v1', '3p', '2v2'
                players: [],
                deck: [],
                trump: null,
                hiddenCard: null,
                tableTricks: [],
                leadCount: 0,
                turnIndex: 0,
                status: 'waiting', // waiting, guessing, playing, game_over
                requiredPlayers: mode === '3p' ? 3 : (mode === '2v2' ? 4 : 2)
            };
        }

        const room = rooms[roomId];

        if (room.status === 'waiting' && room.players.length < room.requiredPlayers) {
            const playerTeam = room.mode === '2v2' ? (teamChoice || (room.players.length % 2 === 0 ? 'A' : 'B')) : null;
            room.players.push({
                id: socket.id,
                name: playerName || `O'yinchi ${room.players.length + 1}`,
                team: playerTeam,
                hand: [],
                gamePoints: 0,
                penaltyPoints: 0,
                guess: null
            });
        }

        if (room.players.length === room.requiredPlayers && room.status === 'waiting') {
            startMiniGame(roomId);
        } else {
            syncState(roomId);
        }
    });

    // 1-qadam: Birinchi yurish mini-o'yini
    socket.on('makeGuess', ({ roomId, guess }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'guessing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.guess = guess;

        const allGuessed = room.players.every(p => p.guess !== null);
        if (allGuessed) {
            resolveMiniGame(roomId);
        } else {
            syncState(roomId);
        }
    });

    // Karta tashlash (qo'lda yoki Auto-Play orqali)
    socket.on('playCards', ({ roomId, cardIds }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const playerIdx = room.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== room.turnIndex) return;

        const player = room.players[playerIdx];
        let chosenCards = player.hand.filter(c => cardIds.includes(c.id));

        // Smart Auto-Play: Hech narsa tanlanmagan bo'lsa
        if (chosenCards.length === 0) {
            chosenCards = getAutoPlayCards(player.hand, room.tableTricks.length === 0 ? 0 : room.leadCount, room.trump.suit);
        }

        // Qoidalar tekshiruvi:
        if (room.tableTricks.length === 0) {
            // Birinchi tashlayotgan bo'lsa — hammasi bir xil mast bo'lishi shart
            const firstSuit = chosenCards[0].suit;
            const allSame = chosenCards.every(c => c.suit === firstSuit);
            if (!allSame) {
                socket.emit('errorMsg', "Barcha tashlangan kartalar bitta mast bo‘lishi shart!");
                return;
            }
            room.leadCount = chosenCards.length;
        } else {
            // Keyingi o'yinchilar kartalar sonini tenglashtirishi shart
            if (chosenCards.length !== room.leadCount) {
                socket.emit('errorMsg', `Raqib ${room.leadCount} ta karta tashlagan. Siz ham ${room.leadCount} ta tashlashingiz kerak!`);
                return;
            }
        }

        // Qo'ldan chiqarish
        const chosenIds = chosenCards.map(c => c.id);
        player.hand = player.hand.filter(c => !chosenIds.includes(c.id));

        room.tableTricks.push({
            playerId: player.id,
            playerName: player.name,
            team: player.team,
            cards: chosenCards
        });

        if (room.tableTricks.length < room.players.length) {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            syncState(roomId);
        } else {
            syncState(roomId);
            setTimeout(() => finishTrick(roomId), 1500);
        }
    });

    // Auto-Fold: "Yura Olmayman" tugmasi
    socket.on('autoFold', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const playerIdx = room.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== room.turnIndex || room.tableTricks.length === 0) return;

        const player = room.players[playerIdx];
        const foldCards = getAutoFoldCards(player.hand, room.leadCount, room.trump.suit);

        const foldIds = foldCards.map(c => c.id);
        player.hand = player.hand.filter(c => !foldIds.includes(c.id));

        room.tableTricks.push({
            playerId: player.id,
            playerName: player.name,
            team: player.team,
            cards: foldCards
        });

        if (room.tableTricks.length < room.players.length) {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            syncState(roomId);
        } else {
            syncState(roomId);
            setTimeout(() => finishTrick(roomId), 1500);
        }
    });
});

function startMiniGame(roomId) {
    const room = rooms[roomId];
    room.status = 'guessing';
    room.deck = createDeck();
    room.hiddenCard = room.deck.pop(); // Taxmin qilinadigan karta
    room.players.forEach(p => p.guess = null);
    syncState(roomId);
}

function resolveMiniGame(roomId) {
    const room = rooms[roomId];
    const hidden = room.hiddenCard;
    const isRed = hidden.suit === '♥' || hidden.suit === '♦';
    const hiddenColor = isRed ? 'RED' : 'BLACK';

    let firstPlayerIdx = 0;

    if (room.mode === '2v2') {
        const winningPlayer = room.players.find(p => p.guess === hiddenColor);
        if (winningPlayer) {
            firstPlayerIdx = room.players.findIndex(p => p.id === winningPlayer.id);
        }
    } else {
        const winningPlayer = room.players.find(p => p.guess === hidden.suit);
        if (winningPlayer) {
            firstPlayerIdx = room.players.findIndex(p => p.id === winningPlayer.id);
        }
    }

    // Mini-o'yin kartasini kolodaga qaytaramiz
    room.deck.unshift(hidden);
    room.hiddenCard = null;

    // Raundni boshlash
    startRound(roomId, firstPlayerIdx);
}

function startRound(roomId, firstPlayerIdx = 0) {
    const room = rooms[roomId];
    room.status = 'playing';
    room.deck = createDeck();
    room.trump = room.deck[0]; // Koloda eng tagidagi karta — kozir
    room.tableTricks = [];
    room.leadCount = 0;
    room.turnIndex = firstPlayerIdx;

    room.players.forEach(p => {
        p.hand = room.deck.splice(-4);
        p.gamePoints = 0;
    });

    syncState(roomId);
}

function finishTrick(roomId) {
    const room = rooms[roomId];
    const trumpSuit = room.trump.suit;

    let bestMove = room.tableTricks[0];
    let winningPlayerId = bestMove.playerId;

    for (let i = 1; i < room.tableTricks.length; i++) {
        const nextMove = room.tableTricks[i];
        if (canBeatAll(bestMove.cards, nextMove.cards, trumpSuit)) {
            bestMove = nextMove;
            winningPlayerId = nextMove.playerId;
        }
    }

    // Stoldagi barcha ochkolarni jamlash
    let trickTotalPoints = 0;
    room.tableTricks.forEach(t => {
        t.cards.forEach(c => trickTotalPoints += c.points);
    });

    const winner = room.players.find(p => p.id === winningPlayerId);
    winner.gamePoints += trickTotalPoints;

    const winnerIdx = room.players.findIndex(p => p.id === winningPlayerId);
    room.turnIndex = winnerIdx;
    room.tableTricks = [];
    room.leadCount = 0;

    // Ketma-ket bittadan to'ldirish
    refillCardsSequentially(room, winnerIdx);

    // Barcha kartalar o'ynab bo'lingan bo'lsa
    if (room.players.every(p => p.hand.length === 0)) {
        evaluateRoundPenalties(roomId);
    } else {
        syncState(roomId);
    }
}

function canBeatAll(baseCards, challengeCards, trumpSuit) {
    let challengeCopy = [...challengeCards];
    for (let bCard of baseCards) {
        let beatIdx = challengeCopy.findIndex(cCard => {
            if (cCard.suit === trumpSuit && bCard.suit !== trumpSuit) return true;
            if (cCard.suit === bCard.suit && cCard.power > bCard.power) return true;
            return false;
        });

        if (beatIdx !== -1) {
            challengeCopy.splice(beatIdx, 1);
        } else {
            return false;
        }
    }
    return true;
}

function refillCardsSequentially(room, winnerIdx) {
    const totalPlayers = room.players.length;
    let order = [];
    for (let i = 0; i < totalPlayers; i++) {
        order.push((winnerIdx + i) % totalPlayers);
    }

    let dealing = true;
    while (dealing && room.deck.length > 0) {
        let dealtAny = false;
        for (let idx of order) {
            if (room.players[idx].hand.length < 4 && room.deck.length > 0) {
                room.players[idx].hand.push(room.deck.pop());
                dealtAny = true;
            }
        }
        if (!dealtAny) dealing = false;
    }
}

// 12 Shtraf Tizimi
function evaluateRoundPenalties(roomId) {
    const room = rooms[roomId];

    if (room.mode === '3p') {
        const s = room.players.map(p => p.gamePoints);
        // 40:40:40 Durang holati
        if (!(s[0] === 40 && s[1] === 40 && s[2] === 40)) {
            room.players.forEach(p => {
                if (p.gamePoints <= 20) p.penaltyPoints += 6;
                else if (p.gamePoints <= 30) p.penaltyPoints += 4;
                else if (p.gamePoints <= 40) p.penaltyPoints += 2;
            });
        }
    } else if (room.mode === '2v2') {
        let teamAPoints = 0;
        let teamBPoints = 0;
        room.players.forEach(p => {
            if (p.team === 'A') teamAPoints += p.gamePoints;
            else teamBPoints += p.gamePoints;
        });

        if (teamAPoints !== 60 || teamBPoints !== 60) {
            const addPen = (pts) => pts <= 20 ? 6 : (pts <= 40 ? 4 : (pts <= 60 ? 2 : 0));
            const penA = addPen(teamAPoints);
            const penB = addPen(teamBPoints);
            room.players.forEach(p => {
                if (p.team === 'A') p.penaltyPoints += penA;
                else p.penaltyPoints += penB;
            });
        }
    } else {
        // 1v1
        const p1 = room.players[0];
        const p2 = room.players[1];
        if (p1.gamePoints !== 60 || p2.gamePoints !== 60) {
            const addPen = (pts) => pts <= 20 ? 6 : (pts <= 40 ? 4 : (pts <= 60 ? 2 : 0));
            p1.penaltyPoints += addPen(p1.gamePoints);
            p2.penaltyPoints += addPen(p2.gamePoints);
        }
    }

    // 12 shtrafga yetganini tekshirish
    const loser = room.players.find(p => p.penaltyPoints >= 12);
    if (loser) {
        room.status = 'game_over';
        io.to(roomId).emit('gameOver', {
            loserName: loser.team ? `Jamoa ${loser.team}` : loser.name,
            players: room.players
        });
        delete rooms[roomId];
        return;
    }

    startRound(roomId, (room.turnIndex + 1) % room.players.length);
}

// AI Yordamchi Funksiyalari
function getAutoPlayCards(hand, requiredCount, trumpSuit) {
    if (requiredCount === 0) {
        // Stol bo'sh: eng ko'p bo'lgan mastdagi eng kichik kartalar
        const groups = {};
        hand.forEach(c => {
            if (!groups[c.suit]) groups[c.suit] = [];
            groups[c.suit].push(c);
        });

        let bestSuit = Object.keys(groups)[0];
        for (let s in groups) {
            if (groups[s].length > groups[bestSuit].length) bestSuit = s;
        }

        const sorted = groups[bestSuit].sort((a, b) => a.power - b.power);
        return [sorted[0]];
    } else {
        // Urish uchun kartalar tanlash
        return hand.slice(0, requiredCount);
    }
}

function getAutoFoldCards(hand, requiredCount, trumpSuit) {
    // Eng keraksiz kartalar: avval kozir bo'lmagan eng kichiklar
    const nonTrumps = hand.filter(c => c.suit !== trumpSuit).sort((a, b) => (a.points - b.points) || (a.power - b.power));
    const trumps = hand.filter(c => c.suit === trumpSuit).sort((a, b) => (a.points - b.points) || (a.power - b.power));
    const combined = [...nonTrumps, ...trumps];
    return combined.slice(0, requiredCount);
}

function syncState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.players.forEach((p, idx) => {
        io.to(p.id).emit('state', {
            status: room.status,
            mode: room.mode,
            myHand: p.hand,
            trump: room.trump,
            tableTricks: room.tableTricks,
            leadCount: room.leadCount,
            isMyTurn: room.turnIndex === idx,
            myTurnIndex: room.turnIndex,
            deckCount: room.deck.length,
            hiddenCardSuit: room.hiddenCard ? room.hiddenCard.suit : null,
            players: room.players.map(pl => ({
                id: pl.id,
                name: pl.name,
                team: pl.team,
                cardsCount: pl.hand.length,
                gamePoints: pl.gamePoints,
                penaltyPoints: pl.penaltyPoints,
                guessed: pl.guess !== null
            }))
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server yugurmoqda: ${PORT}`));
