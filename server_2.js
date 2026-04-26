const connect = require('./connect.js');
const objects = require('./objects.js');
const control = require('./control.js');
const msgpack = require('@msgpack/msgpack');
const { LobbyManager } = require('./lobby.js');
const { WEAPONS } = require('./weapons.js');

const wss = connect.wss;
const PORT = 8081;

connect.server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log('[BUILD] energy v2 (maxEnergy=200, me-field, deplete-pause)');
});

const lobbyManager = new LobbyManager();

// token → playerId, чтобы при реконнекте восстановить того же игрока
const sessionTokens = new Map();

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    let player;
    let currentState;
    let playerId;

    // Ждём первое сообщение hello с токеном сессии
    ws.once('message', (firstMessage) => {
        const hello = msgpack.decode(firstMessage);

        if (hello.type === 'hello' && hello.token) {
            if (sessionTokens.has(hello.token)) {
                playerId = sessionTokens.get(hello.token);
            } else {
                playerId = Math.random().toString(36).substring(7);
                sessionTokens.set(hello.token, playerId);
            }
        } else {
            playerId = Math.random().toString(36).substring(7);
        }

        ws.playerId = playerId;

        const defaultLobby = lobbyManager.getLobby('lobby_0');
        defaultLobby.addClient(ws, playerId);
        ws.currentLobby = defaultLobby;

        player = ws.currentLobby.state.activePlayers[playerId];
        currentState = ws.currentLobby.state;
        if (player) player.lastUpdate = Date.now();
    });

    ws.on('message', (message) => {
        const data = msgpack.decode(message);
        if (data.type === 'hello') return; // уже обработан в once

        if (!ws.currentLobby) return;

        if (data.type === 'joinLobby' && lobbyManager.getLobby(data.lobbyId, data.enteredPassword)) {
            console.log('joinlobby:пароль с фронта: ' + data.enteredPassword);
            ws.currentLobby.removeClient(ws);

            const targetLobby = lobbyManager.getLobby(data.lobbyId, data.enteredPassword);
            targetLobby.addClient(ws, ws.playerId);
            ws.currentLobby = targetLobby;

            player = targetLobby.state.activePlayers[playerId];
            player.lastUpdate = Date.now();
            currentState = targetLobby.state;
        }
        if (data.type === 'removelobby') {
            console.log('removelobby');
            lobbyManager.removeLobby(data.lobbyId);
            ws.currentLobby.broadcast(msgpack.encode({
            type: 'setLobbiesList',
            lobbyID: lobby.state.id,
            lobbyPassword: lobby.lobbyPassword
        }));
        }
        if (data.type === 'createLobby') {
            const lobby  = lobbyManager.createLobby(
                data.lobbyName,
                data.lobbyOwner,
                data.lobbyPassword
            );

            ws.currentLobby.broadcast(msgpack.encode({
                type: 'setLobbiesList',
                lobbyID: lobby.state.id,
                lobbyPassword: lobby.lobbyPassword
            }));
        }

        if (data.type === 'addWall') {
            const newWall = {
                id: currentState.wallIdCounter++,
                x: data.x,
                y: data.y,
                width: data.width,
                height: data.height
            };

            ws.currentLobby.walls.push(newWall);

            ws.currentLobby.broadcast(msgpack.encode({
                type: 'updateWalls',
                walls: ws.currentLobby.walls
            }));
        }

        if (data.type === 'removeWall') {
            const wallIndex = ws.currentLobby.walls.findIndex(wall => wall.id === data.wallId);

            if (wallIndex !== -1) {
                ws.currentLobby.walls.splice(wallIndex, 1);

                ws.currentLobby.broadcast(msgpack.encode({
                    type: 'updateWalls',
                    walls: ws.currentLobby.walls
                }));
            }
        }

        if (data.type === 'respawn') {
            objects.respawnPlayer(playerId, currentState, ws.currentLobby.walls, currentState.width_map, currentState.height_map, (message) => ws.currentLobby.broadcast(message));
            objects.check_new_player(currentState, (msg) => ws.currentLobby.broadcast(msg));
        }

        if (data.type === 'currentShootMode' && player) {
            player.currentShootMode = data.currentShootMode;
        }

        if (data.type === 'shield' && player) {
            const target = currentState.activePlayers[data.playerid];
            if (target) {
                const SHIELD_COOLDOWN_MS = 200;
                const now = Date.now();
                if (target.energy > 0 && now - target.lastShieldActivateTime >= SHIELD_COOLDOWN_MS) {
                    target.shieldActive = true;
                    target.lastShieldActivateTime = now;
                }
            }
        }

        if (data.type === 'shield_off' && player) {
            if (currentState.activePlayers[data.playerid]) {
                currentState.activePlayers[data.playerid].shieldActive = false;
            }
        }

        if (data.type === 'ping') {
            ws.send(msgpack.encode({ type: 'pong', t: data.t }));
            return;
        }

        if (data.type === 'regist' && player) {
            currentState.activePlayers[playerId].name = data.name;
            const leaderboardPlayers = Object.values(ws.currentLobby.state.allPlayersLobby)
                .map(p => ({
                    n: p.name,   // name
                    k: p.kills,  // kills
                    d: p.deaths, // deaths
                    c: p.color,  // color
                }));
            ws.currentLobby.broadcast(msgpack.encode({
                type: 'liderBoard_Update',
                ps: leaderboardPlayers // players
            }));
        }

        if (data.type === 'add_bot') {
            objects.add_bot(currentState, ws.currentLobby.walls, currentState.width_map, currentState.height_map, ws.currentLobby, lobbyManager);
            objects.check_new_player(currentState, (msg) => ws.currentLobby.broadcast(msg));
        }

        if (data.type === 'add_static_bot') {
            objects.add_static_bot(currentState, ws.currentLobby.walls, currentState.width_map, currentState.height_map, ws.currentLobby, lobbyManager);
            objects.check_new_player(currentState, (msg) => ws.currentLobby.broadcast(msg));
        }

        // Единая точка входа для всех видов оружия. Клиент шлёт
        // { type: 'shoot', weapon: 'pistol' | 'shotgun' | ..., angle }
        // Стрельба тратит энергию (та же что у щита/шифта).
        // Пауза при опустошении триггерится в lobby.js при energy<=0,
        // здесь блокированные выстрелы НЕ перезапускают паузу — иначе
        // удержание кнопки замораживает регенерацию.
        if (data.type === 'shoot' && player) {
            const weapon = WEAPONS[data.weapon];
            // Проверяем И энергию И кулдаун ДО списания.
            // Без проверки кулдауна каждый shoot-msg между cooldown-окнами
            // (а их 50+ за 800мс при held fire) сжирал энергию вхолостую.
            const now = Date.now();
            if (
                weapon
                && player.energy >= weapon.energyCost
                && now - player.lastShootTime >= weapon.cooldown
            ) {
                player.energy -= weapon.energyCost;
                control.shoot({
                    player,
                    angle: data.angle,
                    state: currentState,
                    playerId,
                    broadcast: (message) => ws.currentLobby.broadcast(message),
                    weapon,
                });
            }
        }

        if (data.type === 'shift' && player) {
            const SHIFT_COST = 30;
            const SHIFT_COOLDOWN_MS = 300;
            const now = Date.now();
            if (player.energy >= SHIFT_COST && now - player.lastShiftTime >= SHIFT_COOLDOWN_MS) {
                player.energy -= SHIFT_COST;
                player.lastShiftTime = now;
                player.acceleration = 10;
                player.maxSpeed = 60;
                // Угол шлейфа — противоположный направлению движения,
                // чтобы частицы оставались позади игрока.
                const moveAng = (player.velocityX !== 0 || player.velocityY !== 0)
                    ? Math.atan2(player.velocityY, player.velocityX)
                    : player.angle;
                ws.currentLobby.broadcast(msgpack.encode({
                    type: 'shift_effect',
                    pid: playerId,
                    x: Math.round(player.x),
                    y: Math.round(player.y),
                    ang: moveAng + Math.PI,
                }));
                setTimeout(() => {
                    player.acceleration = 3;
                    player.maxSpeed = 15;
                }, 90);
            }
        }

        if (data.type === 'angle' && player) {
            player.angle = data.angle;
        }

        if (data.type === 'keys' && player) {
            control.move(player, data, currentState);
        }
    });

    ws.on('close', () => {
        const lobby = lobbyManager.getLobby(ws.lobbyId);
        if (lobby) {
            lobby.removeClient(ws);
            if (ws.currentLobby.clients.size === 0 && lobby.id !== 'lobby_0') {
                lobbyManager.removeLobby(ws.currentLobby.id);
            }
        }
    });
});

function updateLobbiesInfo(){
    connect.app.get('/api/lobbies', (req, res) => {
        try {
            const lobbyList = lobbyManager.getLobbiesInfo();
            res.json(lobbyList);
        } catch (error) {
            console.error('Ошибка при получении списка лобби:', error);
        }
    });
}
updateLobbiesInfo();