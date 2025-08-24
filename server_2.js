const connect = require('./connect.js');
const objects = require('./objects.js');
const control = require('./control.js');
const msgpack = require('@msgpack/msgpack');
const {LobbyManager } = require('./lobby.js');

const wss = connect.wss;
const PORT = 8080;

connect.server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});

const lobbyManager = new LobbyManager();


wss.on('connection', (ws) => {
    console.log('Новое подключение');

    const playerId = Math.random().toString(36).substring(7);
    ws.playerId = playerId;

    const defaultLobby = lobbyManager.getLobby('lobby_0');

    defaultLobby.addClient(ws, playerId);

    ws.currentLobby = defaultLobby;

    let player = ws.currentLobby.state.activePlayers[playerId];
    let currentState = ws.currentLobby.state;
    player.lastUpdate = Date.now();

    ws.on('message', (message) => {
        const data = msgpack.decode(message);

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
            if (currentState.activePlayers[data.playerid]) {
                currentState.activePlayers[data.playerid].shieldActive = true;
            }
        }

        if (data.type === 'shield_off' && player) {
            if (currentState.activePlayers[data.playerid]) {
                currentState.activePlayers[data.playerid].shieldActive = false;
            }
        }

        if (data.type === 'regist' && player) {
            currentState.activePlayers[playerId].name = data.name;
            const leaderboardPlayers = Object.values(ws.currentLobby.state.allPlayersLobby)
                .map(({ intervals, movement, ...cleanPlayer }) => cleanPlayer);
            ws.currentLobby.broadcast(msgpack.encode({
                type: 'liderBoard_Update',
                players: leaderboardPlayers
            }));
        }

        if (data.type === 'add_bot') {
            objects.add_bot(currentState, ws.currentLobby.walls, currentState.width_map, currentState.height_map, ws.currentLobby, lobbyManager);
            objects.check_new_player(currentState, (msg) => ws.currentLobby.broadcast(msg));
        }

        if (data.type === 'shoot' && player && player.balls_count > 0) {

        }

        if (data.type === 'shift' && player) {
            player.acceleration=10;
            player.maxSpeed=60;
            setTimeout(()=>{
                player.acceleration=3;
                player.maxSpeed=15}
            , 90)
        }

        if (data.type === 'shoot2' && player && player.balls_count >= 5) {
            control.shoot(
                player, 
                data.angle, 
                currentState, 
                playerId, 
                (message) => ws.currentLobby.broadcast(message), 
                5,
                50,
                0.2,
                20,
                100,
                800,
                "canShotGun",
                data,
                false
            );
        }

        if (data.type === 'shoot3' && player && player.balls_count > 0) {
            control.shoot(
                player, 
                data.angle, 
                currentState, 
                playerId, 
                (message) => ws.currentLobby.broadcast(message), 
                1,
                50,
                0.2,
                30,
                100,
                100,
                "canShootAuto",
                data,
                true
            );
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