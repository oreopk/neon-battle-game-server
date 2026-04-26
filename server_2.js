const connect = require('./connect.js');
const objects = require('./objects.js');
const control = require('./control.js');
const msgpack = require('@msgpack/msgpack');
const { LobbyManager } = require('./lobby.js');
const { WEAPONS } = require('./weapons.js');

const wss = connect.wss;
const WebSocket = require('ws');
const PORT = 8081;

/**
 * Разослать сообщение всем подключённым клиентам через все лобби —
 * нужно для уведомлений «список лобби изменился», чтобы UI обновился
 * у пользователей в любом лобби, а не только в текущем.
 */
function broadcastToAll(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (_) {
        /* ignore */
      }
    }
  });
}

/**
 * Разослать всем актуальный список лобби. Используется и как ответ
 * на запрос getLobbies, и как push при создании/удалении/входе в лобби.
 */
function broadcastLobbiesList() {
  broadcastToAll(
    msgpack.encode({
      type: 'lobbiesList',
      lobbies: lobbyManager.getLobbiesInfo(),
    }),
  );
}

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

    const defaultLobby = lobbyManager.getDefaultLobby();
    defaultLobby.addClient(ws, playerId);
    ws.currentLobby = defaultLobby;

    player = ws.currentLobby.state.activePlayers[playerId];
    currentState = ws.currentLobby.state;
    if (player) player.lastUpdate = Date.now();
  });

  ws.on('message', (message) => {
    const data = msgpack.decode(message);
    if (data.type === 'hello') return; // уже обработан в once

    // Запрос списка лобби — отвечаем напрямую этому ws, не всем.
    // Делаем ДО проверки currentLobby, чтобы не блокировалось
    // при гонке инициализации.
    if (data.type === 'getLobbies') {
      try {
        ws.send(
          msgpack.encode({
            type: 'lobbiesList',
            lobbies: lobbyManager.getLobbiesInfo(),
          }),
        );
      } catch (_) {
        /* ignore */
      }
      return;
    }

    if (!ws.currentLobby) return;

    if (data.type === 'joinLobby') {
      // Не дёргаем getLobby дважды и не делаем move если игрок
      // уже сидит в этом лобби (повторный клик «Присоединиться»).
      if (ws.currentLobby && ws.currentLobby.id === data.lobbyId) return;

      if (!lobbyManager.canJoinLobby(data.lobbyId, data.enteredPassword)) {
        console.log('joinLobby: отказано', data.lobbyId);
        return;
      }
      const targetLobby = lobbyManager.getLobby(data.lobbyId);

      console.log(
        'joinLobby:',
        data.lobbyId,
        'пароль с фронта:',
        data.enteredPassword,
      );
      ws.currentLobby.removeClient(ws);
      targetLobby.addClient(ws, ws.playerId);
      ws.currentLobby = targetLobby;

      player = targetLobby.state.activePlayers[playerId];
      if (player) player.lastUpdate = Date.now();
      currentState = targetLobby.state;

      // Игрок переехал — у всех клиентов поменялись playersCount.
      broadcastLobbiesList();
    }
    // Принимаем оба варианта написания (старое 'removelobby' и
    // используемое фронтом 'removeLobby'), чтобы кнопка «удалить лобби»
    // не молчала из-за разной регистризации.
    if (data.type === 'removelobby' || data.type === 'removeLobby') {
      console.log('removeLobby:', data.lobbyId);
      const removed = lobbyManager.removeLobby(data.lobbyId);
      if (removed) {
        broadcastLobbiesList();
      }
    }
    if (data.type === 'createLobby') {
      const newLobby = lobbyManager.createLobby(
        data.lobbyName,
        data.lobbyOwner,
        data.lobbyPassword,
      );

      // Автоматически переселяем создателя в его новое лобби —
      // иначе UX-картина «создал, но остался в старом» выглядит
      // как будто кнопка не сработала / лобби «заменилось».
      if (newLobby && ws.currentLobby && ws.currentLobby.id !== newLobby.id) {
        ws.currentLobby.removeClient(ws);
        newLobby.addClient(ws, ws.playerId);
        ws.currentLobby = newLobby;
        player = newLobby.state.activePlayers[playerId];
        if (player) player.lastUpdate = Date.now();
        currentState = newLobby.state;
      }

      broadcastLobbiesList();
    }

    if (data.type === 'addWall') {
      const newWall = {
        id: currentState.wallIdCounter++,
        x: data.x,
        y: data.y,
        width: data.width,
        height: data.height,
      };

      ws.currentLobby.walls.push(newWall);

      ws.currentLobby.broadcast(
        msgpack.encode({
          type: 'updateWalls',
          walls: ws.currentLobby.walls,
        }),
      );
    }

    if (data.type === 'removeWall') {
      const wallIndex = ws.currentLobby.walls.findIndex(
        (wall) => wall.id === data.wallId,
      );

      if (wallIndex !== -1) {
        ws.currentLobby.walls.splice(wallIndex, 1);

        ws.currentLobby.broadcast(
          msgpack.encode({
            type: 'updateWalls',
            walls: ws.currentLobby.walls,
          }),
        );
      }
    }

    if (data.type === 'respawn') {
      objects.respawnPlayer(
        playerId,
        currentState,
        ws.currentLobby.walls,
        currentState.width_map,
        currentState.height_map,
        (message) => ws.currentLobby.broadcast(message),
      );
      objects.check_new_player(currentState, (msg) =>
        ws.currentLobby.broadcast(msg),
      );
    }

    if (data.type === 'currentShootMode' && player) {
      player.currentShootMode = data.currentShootMode;
    }

    if (data.type === 'shield' && player) {
      const target = currentState.activePlayers[data.playerid];
      if (target) {
        const SHIELD_COOLDOWN_MS = 200;
        const now = Date.now();
        if (
          target.energy > 0 &&
          now - target.lastShieldActivateTime >= SHIELD_COOLDOWN_MS
        ) {
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
      const leaderboardPlayers = Object.values(
        ws.currentLobby.state.allPlayersLobby,
      ).map((p) => ({
        n: p.name, // name
        k: p.kills, // kills
        d: p.deaths, // deaths
        c: p.color, // color
      }));
      ws.currentLobby.broadcast(
        msgpack.encode({
          type: 'liderBoard_Update',
          ps: leaderboardPlayers, // players
        }),
      );
    }

    if (data.type === 'add_bot') {
      objects.add_bot(
        currentState,
        ws.currentLobby.walls,
        currentState.width_map,
        currentState.height_map,
        ws.currentLobby,
        lobbyManager,
      );
      objects.check_new_player(currentState, (msg) =>
        ws.currentLobby.broadcast(msg),
      );
    }

    // Дебаг: проматывает таймер матча. Сдвигаем matchStartTime назад на
    // data.ms — на следующем тике elapsedTime возрастёт на эту величину,
    // и дыра/конец матча наступят раньше. Если перематываем за пределы
    // duration — clamp, чтобы матч не закончился мгновенно (за 1 сек до конца).
    //
    // Раньше после resetMatch кнопка ломалась, потому что Lobby.setState
    // заменял state новым объектом → захваченный в замыкании currentState
    // протухал. Сейчас setState мутирует in-place (см. lobby.js), поэтому
    // currentState остаётся валидным навсегда.
    if (data.type === 'skipTime') {
      const ms = Math.max(0, Math.min(data.ms || 0, 10 * 60 * 1000));
      if (currentState.matchStartTime) {
        const newStart = currentState.matchStartTime - ms;
        const minStart = Date.now() - (currentState.matchDuration - 1000);
        currentState.matchStartTime = Math.max(newStart, minStart);
      }
    }

    if (data.type === 'add_static_bot') {
      objects.add_static_bot(
        currentState,
        ws.currentLobby.walls,
        currentState.width_map,
        currentState.height_map,
        ws.currentLobby,
        lobbyManager,
      );
      objects.check_new_player(currentState, (msg) =>
        ws.currentLobby.broadcast(msg),
      );
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
        weapon &&
        player.energy >= weapon.energyCost &&
        now - player.lastShootTime >= weapon.cooldown
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
      if (
        player.energy >= SHIFT_COST &&
        now - player.lastShiftTime >= SHIFT_COOLDOWN_MS
      ) {
        player.energy -= SHIFT_COST;
        player.lastShiftTime = now;
        player.acceleration = 10;
        player.maxSpeed = 60;
        // Угол шлейфа — противоположный направлению движения,
        // чтобы частицы оставались позади игрока.
        const moveAng =
          player.velocityX !== 0 || player.velocityY !== 0
            ? Math.atan2(player.velocityY, player.velocityX)
            : player.angle;
        ws.currentLobby.broadcast(
          msgpack.encode({
            type: 'shift_effect',
            pid: playerId,
            x: Math.round(player.x),
            y: Math.round(player.y),
            ang: moveAng + Math.PI,
          }),
        );
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
    // Используем ws.currentLobby напрямую — это надёжная ссылка на
    // объект Lobby. Раньше тут был getLobby(ws.lobbyId), но он не
    // знал пароль для запароленных лобби и возвращал null → cleanup
    // молча не выполнялся.
    const lobby = ws.currentLobby;
    if (lobby) {
      lobby.removeClient(ws);
      if (lobby.clients.size === 0 && lobby.id !== 'lobby_0') {
        lobbyManager.removeLobby(lobby.id);
      }
      // Игрок отключился (или удалили опустевшее лобби) — апдейт списка.
      broadcastLobbiesList();
    }
  });
});

function updateLobbiesInfo() {
  connect.app.get('/api/lobbies', (req, res) => {
    try {
      // CORS: фронт может быть открыт с другого origin (локальный
      // devserver, file://, CDN-статика). Сам WebSocket такой проверки
      // не имеет, а вот fetch — да. Без этого заголовка браузер
      // ругается на «No Access-Control-Allow-Origin» и список лобби
      // никогда не подгружается.
      res.set('Access-Control-Allow-Origin', '*');
      const lobbyList = lobbyManager.getLobbiesInfo();
      res.json(lobbyList);
    } catch (error) {
      console.error('Ошибка при получении списка лобби:', error);
      res.status(500).json({ error: 'failed' });
    }
  });
}
updateLobbiesInfo();
