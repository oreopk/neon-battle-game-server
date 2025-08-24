const functions = require('./functions.js');
const collision = require('./collision.js');
const objects = require('./objects.js');
const walls_functions = require('./walls.js');
const msgpack = require('@msgpack/msgpack');
const WebSocket = require('ws');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

class Lobby {
    constructor(id, lobbyOwner, lobbyPassword='') {
        this.id = id;
        this.clients = new Set();
        this.maxPlayers = 8;
        this.state = {
            bulletCounter: 0,
            bullets: [],
            activePlayers: {},
            allPlayersLobby: {},
            wallIdCounter: 0,
            width_map: 4000,
            height_map: 4000,
            matchDuration: MINUTE*10,
            matchStartTime: null,
            matchEnded: false,а
        };
        this.walls = [];
        this.backgroundStars = [];
        this.initWalls();
        this.startGameLoop();
        this.lobbyOwner = lobbyOwner;
        this.lobbyPassword = lobbyPassword;
        
        this.state.allPlayersLobby = functions.makePlayersObservable(this.state.allPlayersLobby, this.handlePlayerChange.bind(this));
    }

     checkInactivePlayers() {
        const now = Date.now();
        const respawnDelay = 2000;

        for (const playerId in this.state.allPlayersLobby) {
            const player = this.state.allPlayersLobby[playerId];
            
            if (!this.state.activePlayers[playerId] && player.deathTime && now - player.deathTime >= respawnDelay) {
                objects.respawnPlayer(
                    playerId, 
                    this.state, 
                    this.walls, 
                    this.state.width_map, 
                    this.state.height_map, 
                    (msg) => this.broadcast(msg)
                );
                objects.check_new_player(this.state, (msg) => this.broadcast(msg));
                
                delete player.deathTime;
            }
        }
    }


    handlePlayerChange(playerId, key, oldValue, newValue) {
        if (key === 'kills' ||  key === 'deaths' ||  key === 'added' ||  key === 'deleted' ||   key === 'name') {
            const leaderboardPlayers = Object.values(this.state.allPlayersLobby)
                .map(({ intervals, movement, ...cleanPlayer }) => cleanPlayer);

            this.broadcast(msgpack.encode({
                type: 'liderBoard_Update',
                players: leaderboardPlayers
            }));
        }
    }

    setState(newState) {
        this.state = { ...this.state, ...newState };
    }

    broadcast(message) {
        if (!this.clients) { return; }
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                } catch (err) {
                    console.error('Ошибка отправки:', err);
                    this.removeClient(client);
                }
            }
        });
    }

    initWalls() {
        
        this.walls = [
            {id: -4, x: 0, y: 0, width: 20, height: this.state.height_map},
            {id: -3, x: this.state.width_map - 20, y: 0, width: 20, height: this.state.height_map},
            {id: -2, x: 0, y: 0, width: this.state.width_map, height: 20},
            {id: -1, x: 0, y: this.state.height_map - 20, width: this.state.width_map, height: 20},
        ];

        this.walls.push(...walls_functions.generateRandomWalls(4000, 4000, 40))
        const background_generate = functions.generatePerlinNoiseStars(this.state.width_map, this.state.height_map, 300, 0.5, 3);
        this.backgroundStars.push(...background_generate);
    }

    addClient(ws, playerId = null) {
        if (this.clients.size >= this.maxPlayers){
            console.log('Лобби переполненно');
        }

        ws.playerData = objects.addPlayer(this.state, playerId, false, this.walls, this.state.width_map, this.state.height_map);

        this.clients.add(ws);
        ws.lobbyId = this.id;

        this.state.allPlayersLobby[playerId] = ws.playerData;
        this.state.activePlayers[playerId] = ws.playerData;

        ws.send(msgpack.encode({
            type: 'init',
            lobbyId: this.id,
            playerId: ws.playerId,
            player: ws.playerData,
            walls: this.walls,
            background: this.backgroundStars,
            width: this.state.width_map,
            height: this.state.height_map,
            lobbyId: this.id,
        }));

        objects.check_new_player(this.state, (msg) => this.broadcast(msg));
        console.log('Игрок '+ ws.playerId + ' Вошел на сервер: '+ ws.lobbyId);
    }

    removeClient(ws) {
        if (ws.playerId) {
            delete this.state.activePlayers[ws.playerId];
            delete this.state.allPlayersLobby[ws.playerId];

            this.broadcast(msgpack.encode({
                type: 'removePlayer',
                playerId: ws.playerId
            }));
        }
        this.clients.delete(ws);
    }



    startGameLoop() {
        const maxDistanceX = 10000;
        const maxDistanceY = 10000;
        let lastRespawnCheck = 0;
        setInterval(() => {
            if (!this.state.matchStartTime) {
                this.state.matchStartTime = Date.now();
            }
            const elapsedTime = Date.now() - this.state.matchStartTime;

            if (elapsedTime >= this.state.matchDuration && this.state.matchEnded == false) {
                this.state.matchEnded = true;
                this.endMatch();
            }

            if (Date.now() - lastRespawnCheck >= 1000) {
                this.checkInactivePlayers();
                lastRespawnCheck = Date.now();
            }

            objects.updateBots(this.state);

            for (let index = 0; index < this.state.bullets.length; index++) {
                const bullet = this.state.bullets[index];
                bullet.velocityX += Math.cos(bullet.angle) * bullet.acceleration;
                bullet.velocityY += Math.sin(bullet.angle) * bullet.acceleration;
                const currentSpeed = Math.hypot(bullet.velocityX, bullet.velocityY)

                if (currentSpeed > bullet.maxSpeed) {
                    const ratio = bullet.maxSpeed / currentSpeed;
                    bullet.velocityX *= ratio;
                    bullet.velocityY *= ratio;
                }
                if(collision.checkCollisions_bullet_player(this.state, bullet, index, (msg) => this.broadcast(msg))){
                    continue
                }

                if(collision.checkCollisions(this.state, bullet, index, this.walls, (msg) => this.broadcast(msg))){
                    continue;
                }

                bullet.x += bullet.velocityX;
                bullet.y += bullet.velocityY;

                //functions.applyAttraction(bullet, 4000, 4000);

                if (Math.abs(bullet.x) > maxDistanceX || Math.abs(bullet.y) > maxDistanceY) {
                    this.state.bullets.splice(index, 1);

                    this.broadcast(msgpack.encode({
                        type: 'removeBullet',
                        bulletId: bullet.bulletId,
                        angle: bullet.angle,
                    }));
                    continue;
                }

                this.broadcast(msgpack.encode({
                    type: 'bulletUpdate',
                    bulletId: bullet.bulletId,
                    x: bullet.x,
                    y: bullet.y,
                    playerId: bullet.playerId
                }));
            };

            for (const id in this.state.activePlayers) {
                const player = this.state.activePlayers[id];
                //functions.applyAttraction(player, 4000, 4000);

                if (player.balls_count < player.balls_max_count) {
                    player.reload += 0.1;
                    if (player.reload > 1) {
                        player.balls_count += 1;
                        player.reload = 0;
                    }
                }
                    
                player.velocityX *= player.friction;
                player.velocityY *= player.friction;

                if (Math.abs(player.velocityX) < 0.01) player.velocityX = 0;
                if (Math.abs(player.velocityY) < 0.01) player.velocityY = 0;
           
                 collision.checkWallCollisions(player, this.walls)
            };

            const existingPlayers = Object.keys(this.state.activePlayers).map(id => {
                const { intervals, movement, ...cleanPlayer } = this.state.activePlayers[id];
                return {
                    playerId: id,
                    player: cleanPlayer
                };
            });
            this.broadcast(msgpack.encode({
                type: 'update',
                activePlayers: existingPlayers,
                remainingTime: Math.max(0, Math.floor((this.state.matchDuration - elapsedTime) / 1000))
            }));

        }, 16);
    }

    endMatch() {
        let winner = null;
        let maxKills = -1;

        for (const id in this.state.allPlayersLobby) {
            const player = this.state.allPlayersLobby[id];
            if (player.kills > maxKills) {
                maxKills = player.kills;
                winner = player;
            }
        }

        const resultMessage = {
            type: 'matchEnd',
            winner: winner ? {
                playerId: winner.playerId,
                name: winner.name,
                kills: winner.kills,
                deaths: winner.deaths
            } : null,
            leaderboard: Object.values(this.state.allPlayersLobby).map(player => ({
                playerId: player.playerId,
                name: player.name,
                kills: player.kills,
                deaths: player.deaths
            }))
        };

        this.broadcast(msgpack.encode(resultMessage));

        setTimeout(() => {
            this.resetMatch();
        }, 5 * 1000);
    }

    resetMatch() {
        const validPlayers = {};
        for (const id in this.state.allPlayersLobby) {
            const player = this.state.allPlayersLobby[id];
            if (!player) continue;

            player.health = 100;
            player.balls_count = player.balls_max_count;

            const position = functions.getRandomPosition(
                player.radius,
                this.walls,
                this.state.width_map,
                this.state.height_map
            ) || { x: 0, y: 0 };
            player.x = position.x;
            player.y = position.y;

            validPlayers[id] = player;
        }
        this.state.bullets.length = 0;
        this.setState({
            bulletCounter: 0,
            matchStartTime: Date.now(),
            matchEnded: false,
        });

        objects.check_new_player(this.state, (msg) => this.broadcast(msg));

        this.broadcast(msgpack.encode({
            type: 'matchStart',
        }));
    }
}


class LobbyManager {
    constructor() {
        this.lobbies = new Map();
        this.lobbyCounter = 0;
        this.createLobby('default', '');
    }

    createLobby(lobbyName, lobbyOwner='', lobbyPassword='') {
        const lobbyID = `lobby_${this.lobbyCounter++}`;
        const newLobby = new Lobby(lobbyID, lobbyOwner, lobbyPassword);
        this.lobbies.set(lobbyID, newLobby);
        console.log('Создано лобби:', {
            id: newLobby.id,
            playersCount: newLobby.clients.size,
            maxPlayers: newLobby.maxPlayers,
            lobbyOwner: newLobby.lobbyOwner,
            hasPassword: lobbyPassword
        });
        return newLobby;
    }


    getLobby(id, lobbyPassword ) {

        if (id) {
            const lobby = this.lobbies.get(id);
            if (lobby && lobby.clients.size < lobby.maxPlayers && !lobby.lobbyPassword) {
                console.log(`Лобби ${id} найдено и имеет свободные места`);
                return lobby;

            }
            else if(lobby.lobbyPassword){
                if (lobby.lobbyPassword === lobbyPassword){
                    return lobby;
                }
            }
            console.log(lobby.lobbyPassword);
            console.log(lobbyPassword);

            console.log(`Лобби ${id} либо не существует, либо заполнено`);
            return null;
        }

        for (const lobby of this.lobbies.values()) {
            if (lobby.clients.size < lobby.maxPlayers && !lobby.lobbyPassword) {
                console.log('найдено свободное лобби: ' + lobby);
                return lobby;
            }else{
                console.log('не найдено свободного лобби: ');
            }
        }

        return this.createLobby(`lobby_${this.lobbyCounter}`, '');
    }
    
    getLobbiesInfo() {
        return Array.from(this.lobbies.values()).map(lobby => ({
            id: lobby.id,
            playersCount: lobby.clients.size,
            lobbyOwner: lobby.lobbyOwner,
            hasPassword: !!lobby.lobbyPassword
        }));
    }

    moveToDefaultLobby(client) {
        const defaultLobby = this.lobbies.values().next().value;
        if (defaultLobby) {
            defaultLobby.addClient(client, client.playerId);
        }
    }

    removeLobby(id) {
        const lobby = this.lobbies.get(id);
        if (lobby) {
            lobby.clients.forEach(client => {
                this.moveToDefaultLobby(client);
            });
            return this.lobbies.delete(id);
        }
        return false;
    }
}

module.exports = {
    Lobby,
    LobbyManager
};