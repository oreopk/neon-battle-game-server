const functions = require('./functions.js');
const collision = require('./collision.js');
const objects = require('./objects.js');
const walls_functions = require('./walls.js');
const msgpack = require('@msgpack/msgpack');
const WebSocket = require('ws');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

class Lobby {
  constructor(id, lobbyOwner, lobbyPassword = '') {
    this.id = id;
    this.clients = new Set();
    this.maxPlayers = 8;
    this.state = {
      bulletCounter: 0,
      bullets: [],
      activePlayers: {},
      allPlayersLobby: {},
      wallIdCounter: 0,
      width_map: 8000,
      height_map: 8000,
      matchDuration: MINUTE * 10,
      matchStartTime: null,
      matchEnded: false,
    };
    this.walls = [];
    this.backgroundStars = [];
    this.initWalls();
    this.startGameLoop();
    this.lobbyOwner = lobbyOwner;
    this.lobbyPassword = lobbyPassword;

    this.state.allPlayersLobby = functions.makePlayersObservable(
      this.state.allPlayersLobby,
      this.handlePlayerChange.bind(this),
    );
  }

  checkInactivePlayers() {
    const now = Date.now();
    const respawnDelay = 2000;

    for (const playerId in this.state.allPlayersLobby) {
      const player = this.state.allPlayersLobby[playerId];

      if (
        !this.state.activePlayers[playerId] &&
        player.deathTime &&
        now - player.deathTime >= respawnDelay
      ) {
        objects.respawnPlayer(
          playerId,
          this.state,
          this.walls,
          this.state.width_map,
          this.state.height_map,
          (msg) => this.broadcast(msg),
        );
        objects.check_new_player(this.state, (msg) => this.broadcast(msg));

        delete player.deathTime;
      }
    }
  }

  handlePlayerChange(playerId, key, oldValue, newValue) {
    if (
      key === 'kills' ||
      key === 'deaths' ||
      key === 'added' ||
      key === 'deleted' ||
      key === 'name'
    ) {
      const leaderboardPlayers = Object.values(this.state.allPlayersLobby).map(
        (p) => ({
          n: p.name, // name
          k: p.kills, // kills
          d: p.deaths, // deaths
          c: p.color, // color
        }),
      );

      this.broadcast(
        msgpack.encode({
          type: 'liderBoard_Update',
          ps: leaderboardPlayers, // players
        }),
      );
    }
  }

  setState(newState) {
    this.state = { ...this.state, ...newState };
  }

  broadcast(message) {
    if (!this.clients) {
      return;
    }
    this.clients.forEach((client) => {
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
      { id: -4, x: 0, y: 0, width: 20, height: this.state.height_map },
      {
        id: -3,
        x: this.state.width_map - 20,
        y: 0,
        width: 20,
        height: this.state.height_map,
      },
      { id: -2, x: 0, y: 0, width: this.state.width_map, height: 20 },
      {
        id: -1,
        x: 0,
        y: this.state.height_map - 20,
        width: this.state.width_map,
        height: 20,
      },
    ];

    this.walls.push(
      ...walls_functions.generateRandomWalls(
        this.state.width_map,
        this.state.height_map,
        200,
      ),
    );
    // wallIdCounter должен начинаться выше максимального ID сгенерированных стен,
    // иначе вручную добавленные стены получат ID, конфликтующий с генерёнными.
    this.state.wallIdCounter =
      this.walls.reduce((max, w) => Math.max(max, w.id), -1) + 1;
    // Звёздный фон в 4 раза больше карты — чтобы перекрывал всё поле
    // и оставался виден когда камера у края.
    this.bgWidth = this.state.width_map * 4;
    this.bgHeight = this.state.height_map * 4;
    const background_generate = functions.generatePerlinNoiseStars(
      this.bgWidth,
      this.bgHeight,
      1800,
      0.3,
      2,
    );
    this.backgroundStars.push(...background_generate);
  }

  addClient(ws, playerId) {
    if (this.clients.size >= this.maxPlayers) {
      console.log('Лобби переполненно');
    }

    ws.playerId = playerId;
    ws.lobbyId = this.id;
    this.clients.add(ws);

    // Отменяем отложенное удаление если игрок переподключился
    if (this.disconnectTimeouts && this.disconnectTimeouts[playerId]) {
      clearTimeout(this.disconnectTimeouts[playerId]);
      delete this.disconnectTimeouts[playerId];
    }

    const isReconnect = !!this.state.allPlayersLobby[playerId];

    if (isReconnect) {
      // Восстанавливаем старого игрока
      ws.playerData = this.state.allPlayersLobby[playerId];
      this.state.activePlayers[playerId] = ws.playerData;
      console.log('Игрок ' + playerId + ' переподключился');
    } else {
      ws.playerData = objects.addPlayer(
        this.state,
        playerId,
        false,
        this.walls,
        this.state.width_map,
        this.state.height_map,
      );
      this.state.allPlayersLobby[playerId] = ws.playerData;
      this.state.activePlayers[playerId] = ws.playerData;
      console.log('Игрок ' + playerId + ' Вошел на сервер: ' + ws.lobbyId);
    }

    ws.send(
      msgpack.encode({
        type: 'init',
        lobbyId: this.id,
        playerId: playerId,
        player: ws.playerData,
        walls: this.walls,
        background: this.backgroundStars,
        bgWidth: this.bgWidth,
        bgHeight: this.bgHeight,
        width: this.state.width_map,
        height: this.state.height_map,
        isReconnect: isReconnect,
      }),
    );

    objects.check_new_player(this.state, (msg) => this.broadcast(msg));
  }

  removeClient(ws) {
    if (ws.playerId) {
      delete this.state.activePlayers[ws.playerId];

      // Даём 30 секунд на реконнект — только потом удаляем игрока
      this.disconnectTimeouts = this.disconnectTimeouts || {};
      const pid = ws.playerId;
      this.disconnectTimeouts[pid] = setTimeout(() => {
        delete this.state.allPlayersLobby[pid];
        delete this.disconnectTimeouts[pid];
      }, 30000);

      this.broadcast(
        msgpack.encode({
          type: 'removePlayer',
          pid: ws.playerId, // playerId
        }),
      );
    }
    this.clients.delete(ws);
  }

  startGameLoop() {
    const maxDistanceX = 10000;
    const maxDistanceY = 10000;
    let lastRespawnCheck = 0;
    let lastRemainingTime = -1;
    setInterval(() => {
      if (!this.state.matchStartTime) {
        this.state.matchStartTime = Date.now();
      }
      const elapsedTime = Date.now() - this.state.matchStartTime;

      if (
        elapsedTime >= this.state.matchDuration &&
        this.state.matchEnded == false
      ) {
        this.state.matchEnded = true;
        this.endMatch();
      }

      if (Date.now() - lastRespawnCheck >= 1000) {
        this.checkInactivePlayers();
        lastRespawnCheck = Date.now();
      }

      objects.updateBots(this.state);

      const bulletUpdates = [];
      for (let index = 0; index < this.state.bullets.length; index++) {
        const bullet = this.state.bullets[index];
        bullet.velocityX += Math.cos(bullet.angle) * bullet.acceleration;
        bullet.velocityY += Math.sin(bullet.angle) * bullet.acceleration;
        const currentSpeed = Math.hypot(bullet.velocityX, bullet.velocityY);

        if (currentSpeed > bullet.maxSpeed) {
          const ratio = bullet.maxSpeed / currentSpeed;
          bullet.velocityX *= ratio;
          bullet.velocityY *= ratio;
        }
        if (
          collision.checkCollisions_bullet_player(
            this.state,
            bullet,
            index,
            (msg) => this.broadcast(msg),
          )
        ) {
          continue;
        }

        if (
          collision.checkCollisions(
            this.state,
            bullet,
            index,
            this.walls,
            (msg) => this.broadcast(msg),
          )
        ) {
          continue;
        }

        bullet.x += bullet.velocityX;
        bullet.y += bullet.velocityY;

        //functions.applyAttraction(bullet, 4000, 4000);

        if (
          Math.abs(bullet.x) > maxDistanceX ||
          Math.abs(bullet.y) > maxDistanceY
        ) {
          this.state.bullets.splice(index, 1);
          this.broadcast(
            msgpack.encode({
              type: 'removeBullet',
              bid: bullet.bulletId,
              angle: bullet.angle,
            }),
          );
          continue;
        }

        bulletUpdates.push({
          id: bullet.bulletId,
          x: Math.round(bullet.x),
          y: Math.round(bullet.y),
          p: bullet.playerId,
        });
      }

      // Все пули одним сообщением вместо N отдельных
      if (bulletUpdates.length > 0) {
        this.broadcast(
          msgpack.encode({
            type: 'bulletsUpdate',
            b: bulletUpdates,
            // type: 'bulletUpdate',
            // bulletId: bullet.bulletId,
            // x: bullet.x,
            // y: bullet.y,
            // playerId: bullet.playerId
          }),
        );
      }

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

        // Энергия: щит быстро дренит (после задержки появления),
        // иначе медленная регенерация.
        const SHIELD_APPEAR_DELAY_MS = 300;
        if (
          player.shieldActive &&
          Date.now() - player.lastShieldActivateTime >= SHIELD_APPEAR_DELAY_MS
        ) {
          player.energy -= 2;
          if (player.energy <= 0) {
            player.energy = 0;
            player.shieldActive = false;
          }
        } else if (!player.shieldActive && player.energy < player.maxEnergy) {
          player.energy = Math.min(player.maxEnergy, player.energy + 0.5);
        }

        player.velocityX *= player.friction;
        player.velocityY *= player.friction;

        if (Math.abs(player.velocityX) < 0.01) player.velocityX = 0;
        if (Math.abs(player.velocityY) < 0.01) player.velocityY = 0;

        collision.checkWallCollisions(player, this.walls);
      }

      // Только поля которые реально нужны фронтенду каждый тик
      const existingPlayers = Object.keys(this.state.activePlayers).map(
        (id) => {
          const p = this.state.activePlayers[id];
          return {
            pid: id, // playerId
            p: {
              // player
              x: Math.round(p.x),
              y: Math.round(p.y),
              a: p.angle, // angle
              n: p.name, // name
              sa: p.shieldActive, // shieldActive
              sm: p.currentShootMode, // currentShootMode
              bc: p.balls_count, // balls_count
              bot: p.isBot, // isBot
              sA: p.shootAngle, // shootAngle
              e: Math.round(p.energy), // energy
            },
          };
        },
      );

      const remaining = Math.max(
        0,
        Math.floor((this.state.matchDuration - elapsedTime) / 1000),
      );
      const updateMsg = { type: 'update', ap: existingPlayers }; // ap = activePlayers
      if (remaining !== lastRemainingTime) {
        updateMsg.rt = remaining; // rt = remainingTime
        lastRemainingTime = remaining;
      }
      this.broadcast(msgpack.encode(updateMsg));
      // this.broadcast(msgpack.encode({
      //     type: 'update',
      //     activePlayers: existingPlayers,
      //     remainingTime: Math.max(0, Math.floor((this.state.matchDuration - elapsedTime) / 1000))
      // }));
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
      winner: winner
        ? {
            playerId: winner.playerId,
            name: winner.name,
            kills: winner.kills,
            deaths: winner.deaths,
          }
        : null,
      leaderboard: Object.values(this.state.allPlayersLobby).map((player) => ({
        playerId: player.playerId,
        name: player.name,
        kills: player.kills,
        deaths: player.deaths,
      })),
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
        this.state.height_map,
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

    this.broadcast(
      msgpack.encode({
        type: 'matchStart',
      }),
    );
  }
}

class LobbyManager {
  constructor() {
    this.lobbies = new Map();
    this.lobbyCounter = 0;
    this.createLobby('default', '');
  }

  createLobby(lobbyName, lobbyOwner = '', lobbyPassword = '') {
    const lobbyID = `lobby_${this.lobbyCounter++}`;
    const newLobby = new Lobby(lobbyID, lobbyOwner, lobbyPassword);
    this.lobbies.set(lobbyID, newLobby);
    console.log('Создано лобби:', {
      id: newLobby.id,
      playersCount: newLobby.clients.size,
      maxPlayers: newLobby.maxPlayers,
      lobbyOwner: newLobby.lobbyOwner,
      hasPassword: lobbyPassword,
    });
    return newLobby;
  }

  getLobby(id, lobbyPassword) {
    if (id) {
      const lobby = this.lobbies.get(id);
      if (
        lobby &&
        lobby.clients.size < lobby.maxPlayers &&
        !lobby.lobbyPassword
      ) {
        console.log(`Лобби ${id} найдено и имеет свободные места`);
        return lobby;
      } else if (lobby.lobbyPassword) {
        if (lobby.lobbyPassword === lobbyPassword) {
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
      } else {
        console.log('не найдено свободного лобби: ');
      }
    }

    return this.createLobby(`lobby_${this.lobbyCounter}`, '');
  }

  getLobbiesInfo() {
    return Array.from(this.lobbies.values()).map((lobby) => ({
      id: lobby.id,
      playersCount: lobby.clients.size,
      lobbyOwner: lobby.lobbyOwner,
      hasPassword: !!lobby.lobbyPassword,
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
      lobby.clients.forEach((client) => {
        this.moveToDefaultLobby(client);
      });
      return this.lobbies.delete(id);
    }
    return false;
  }
}

module.exports = {
  Lobby,
  LobbyManager,
};
