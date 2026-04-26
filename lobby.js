const functions = require('./functions.js');
const collision = require('./collision.js');
const objects = require('./objects.js');
const walls_functions = require('./walls.js');
const { WEAPONS } = require('./weapons.js');
const msgpack = require('@msgpack/msgpack');
const WebSocket = require('ws');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

class Lobby {
  constructor(id, lobbyOwner, lobbyPassword = '', lobbyName = '') {
    this.id = id;
    // Имя, введённое пользователем при создании. Если пусто — UI
    // покажет техническое id ('lobby_5'). Раньше параметр lobbyName
    // вообще не сохранялся — теперь хранится отдельно от id.
    this.lobbyName = lobbyName || '';
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
    // Снапшот стартового набора стен — чёрная дыра по ходу матча будет их
    // съедать, и без бэкапа ресет матча оставлял бы поле без препятствий.
    // Глубокий клон, чтобы мутации live-стен (включая F/X пользователя)
    // не текли в снапшот.
    this.initialWalls = JSON.parse(JSON.stringify(this.walls));
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

  /**
   * Точечный апдейт полей state. ВАЖНО: мутируем существующий объект через
   * Object.assign, а не заменяем его новым `{...this.state, ...newState}`.
   *
   * Иначе все ссылки на старый state, захваченные в замыканиях, мгновенно
   * протухают:
   *   - `currentState` в WS-хендлерах server_2.js (захватывается при hello/
   *     joinLobby/createLobby и больше не переустанавливается),
   *   - `state` в setInterval'ах ботов (objects.add_bot/add_static_bot),
   *   - всё, что когда-нибудь ещё придёт.
   *
   * После такой подмены любая мутация state.matchStartTime/.bullets/etc.
   * на захваченной ссылке уходит в мусор, а реальное лобби живёт дальше
   * со своим `this.state`. Ровно из-за этого после первого resetMatch
   * переставала работать дебаг-кнопка +1min.
   *
   * Мутация in-place решает все такие баги разом.
   */
  setState(newState) {
    Object.assign(this.state, newState);
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
        weapons: WEAPONS,           // конфиг всех оружий — клиент строит таблицу динамически
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
    let lastWallEatCheck = 0;

    // Параметры чёрной дыры. Дыра «просыпается» когда до конца матча
    // остаётся <= BLACKHOLE_WAKE_AT_REMAINING_MS, и линейно усиливается
    // до strength=1 в момент, когда таймер достигает нуля.
    // Бои идут 10 минут — последние 3 минуты превращаются в выживание
    // подальше от центра, последняя минута уже почти не оставляет шансов.
    const BLACKHOLE_WAKE_AT_REMAINING_MS = 3 * MINUTE;
    const BLACKHOLE_EVENT_HORIZON_PLAYER = 90; // радиус «ядра» для игроков
    const BLACKHOLE_EVENT_HORIZON_BULLET = 60; // ядро для пуль (меньше)
    // Пули летят быстро (initial velocity > 100 у большинства оружий) и со
    // скромной тягой пролетали мимо центра почти по прямой — игрок не видел,
    // что дыра вообще на них действует. Тяга специально перекручена далеко
    // выше реалистичной массы (×12.5 от player.pull), чтобы кривизна
    // траектории была явной с любой дистанции. Swirl тоже усилен.
    const BLACKHOLE_PULL_BULLET  = 20.0;       // ускорение/тик при strength=1
    const BLACKHOLE_SWIRL_BULLET = 8.0;
    const BLACKHOLE_PULL_PLAYER  = 1.6;
    const BLACKHOLE_SWIRL_PLAYER = 0.55;
    const BLACKHOLE_FALLOFF      = 1500;       // дистанция «полной» силы
    // Радиус, в пределах которого стены полностью испаряются. Растёт
    // линейно со strength: 0 → 0 px, 1 → 800 px. Граничные стены карты
    // (id<0) не трогаем — иначе игроков выкидывает за пределы мира.
    const BLACKHOLE_WALL_EAT_RADIUS_MAX = 800;
    const BLACKHOLE_WALL_EAT_INTERVAL_MS = 500;

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

      // Сила чёрной дыры на этом тике. Активна только в последние
      // BLACKHOLE_WAKE_AT_REMAINING_MS до конца и только во время матча
      // (между endMatch и resetMatch — спокойные 5 секунд).
      const remainingMs = Math.max(0, this.state.matchDuration - elapsedTime);
      const bhStrength =
        !this.state.matchEnded && remainingMs < BLACKHOLE_WAKE_AT_REMAINING_MS
          ? 1 - remainingMs / BLACKHOLE_WAKE_AT_REMAINING_MS
          : 0;
      const bhActive = bhStrength > 0;
      const bhCx = this.state.width_map / 2;
      const bhCy = this.state.height_map / 2;

      // Чёрная дыра «жрёт» стены вокруг себя. Делаем не каждый тик —
      // 500мс хватает, и сетевой трафик от updateWalls остаётся вменяемым.
      // Радиус уничтожения = strength × MAX, поэтому первая стена пропадает
      // только после того как дыра набрала ~10-15% силы (≈ 7:30 elapsed).
      if (
        bhActive &&
        Date.now() - lastWallEatCheck >= BLACKHOLE_WALL_EAT_INTERVAL_MS
      ) {
        lastWallEatCheck = Date.now();
        const eatRadius = bhStrength * BLACKHOLE_WALL_EAT_RADIUS_MAX;
        const eatRadiusSq = eatRadius * eatRadius;
        let removedAny = false;
        for (let i = this.walls.length - 1; i >= 0; i--) {
          const w = this.walls[i];
          // Боковые границы карты (id < 0) не трогаем — на них держится мир.
          if (w.id < 0) continue;
          // Ближайшая точка прямоугольника стены к центру дыры — если она
          // в радиусе eat, считаем что дыра «коснулась» стены и съедает её.
          const closestX = Math.max(w.x, Math.min(bhCx, w.x + w.width));
          const closestY = Math.max(w.y, Math.min(bhCy, w.y + w.height));
          const dx = bhCx - closestX;
          const dy = bhCy - closestY;
          if (dx * dx + dy * dy <= eatRadiusSq) {
            this.walls.splice(i, 1);
            removedAny = true;
          }
        }
        if (removedAny) {
          this.broadcast(
            msgpack.encode({
              type: 'updateWalls',
              walls: this.walls,
            }),
          );
        }
      }

      const bulletUpdates = [];
      for (let index = 0; index < this.state.bullets.length; index++) {
        const bullet = this.state.bullets[index];

        // TTL — короткоживущие пули (ближний бой и т.п.) сами гаснут
        // по истечении времени. Без этого пули с отрицательным acceleration
        // зависают в нуле скорости и копятся вечно.
        if (bullet.spawnTime && Date.now() - bullet.spawnTime >= bullet.lifetime) {
          this.state.bullets.splice(index, 1);
          this.broadcast(
            msgpack.encode({
              type: 'removeBullet',
              bid: bullet.bulletId,
              angle: bullet.angle,
              ih: false,
            }),
          );
          index--;
          continue;
        }

        bullet.velocityX += Math.cos(bullet.angle) * bullet.acceleration;
        bullet.velocityY += Math.sin(bullet.angle) * bullet.acceleration;
        const currentSpeed = Math.hypot(bullet.velocityX, bullet.velocityY);

        if (currentSpeed > bullet.maxSpeed) {
          const ratio = bullet.maxSpeed / currentSpeed;
          bullet.velocityX *= ratio;
          bullet.velocityY *= ratio;
        }
        // Пули с отрицательным acceleration не должны лететь назад: при
        // достижении 0 их «толкает» в обратную сторону. Просто обнуляем.
        if (bullet.acceleration < 0 && currentSpeed < 0.5) {
          bullet.velocityX = 0;
          bullet.velocityY = 0;
        }

        // Чёрная дыра подгребает пули к центру. Применяем ПОСЛЕ обычной
        // тяги/maxSpeed-капа — так дыра реально может разогнать пулю
        // быстрее её обычного maxSpeed (астрономически достоверно:
        // гравитационный колодец ускоряет тело без верхнего предела).
        if (bhActive) {
          const dist = functions.applyBlackHole(bullet, bhCx, bhCy, bhStrength, {
            pullForce:  BLACKHOLE_PULL_BULLET,
            swirlForce: BLACKHOLE_SWIRL_BULLET,
            falloffRef: BLACKHOLE_FALLOFF,
          });
          if (dist <= BLACKHOLE_EVENT_HORIZON_BULLET) {
            this.state.bullets.splice(index, 1);
            this.broadcast(
              msgpack.encode({
                type: 'removeBullet',
                bid: bullet.bulletId,
                bx: Math.round(bullet.x),
                by: Math.round(bullet.y),
                angle: bullet.angle,
                ih: false,
                bh: true, // съедено чёрной дырой — клиент может нарисовать вспышку
              }),
            );
            index--;
            continue;
          }
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

        // Сохраняем текущую позицию как «предыдущую» ПЕРЕД сдвигом —
        // в следующем тике коллизии будут проверять реальный отрезок
        // (prev → next), а не reconstr через velocity.
        bullet.prevX = bullet.x;
        bullet.prevY = bullet.y;
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

        // balls_count теперь визуальный индикатор HP в долях от max.
        // Клиент рисует столько шариков, сколько осталось HP (0..max).
        player.balls_count = Math.max(
          0,
          Math.round((player.health / 100) * player.balls_max_count),
        );

        // Энергия:
        //  - щит быстро дренит (после задержки появления),
        //  - стрельба/шифт списывают энергию централизованно в server_2.js,
        //  - при достижении 0 наступает пауза ENERGY_DEPLETE_PAUSE_MS,
        //    в которой регенерация остановлена,
        //  - вне паузы регенерируется ENERGY_REGEN_PER_TICK/тик.
        const SHIELD_APPEAR_DELAY_MS = 300;
        const ENERGY_DEPLETE_PAUSE_MS = 2000;
        // 1.2/тик ≈ 75 энергии/сек. Цены оружия подобраны так, чтобы любое
        // удержание огня давало чистый минус 25-70/сек и за 3-8 секунд
        // опустошало 200 энергии — иначе при ENERGY_REGEN > spend rate
        // шкала никогда не пустеет и пауза не срабатывает.
        const ENERGY_REGEN_PER_TICK = 1.2;

        if (player.energy <= 0 && !player.energyDepletedAt) {
          player.energyDepletedAt = Date.now();
        }

        if (
          player.shieldActive &&
          Date.now() - player.lastShieldActivateTime >= SHIELD_APPEAR_DELAY_MS
        ) {
          player.energy -= 2;
          if (player.energy <= 0) {
            player.energy = 0;
            player.shieldActive = false;
            if (!player.energyDepletedAt) {
              player.energyDepletedAt = Date.now();
            }
          }
        } else if (!player.shieldActive && player.energy < player.maxEnergy) {
          const inDepletePause =
            player.energyDepletedAt &&
            Date.now() - player.energyDepletedAt < ENERGY_DEPLETE_PAUSE_MS;
          if (!inDepletePause) {
            player.energy = Math.min(
              player.maxEnergy,
              player.energy + ENERGY_REGEN_PER_TICK,
            );
            if (player.energy > 0) player.energyDepletedAt = null;
          }
        }

        player.velocityX *= player.friction;
        player.velocityY *= player.friction;

        if (Math.abs(player.velocityX) < 0.01) player.velocityX = 0;
        if (Math.abs(player.velocityY) < 0.01) player.velocityY = 0;

        // Дыра тянет игроков. Считаем ПОСЛЕ friction — иначе тяга мгновенно
        // съедается трением и игрока почти не двигает. Также игнорируем щит:
        // от гравитации он не спасает (по сюжету: масса > свет — какой щит).
        if (bhActive) {
          const dist = functions.applyBlackHole(player, bhCx, bhCy, bhStrength, {
            pullForce:  BLACKHOLE_PULL_PLAYER,
            swirlForce: BLACKHOLE_SWIRL_PLAYER,
            falloffRef: BLACKHOLE_FALLOFF,
          });
          if (dist <= BLACKHOLE_EVENT_HORIZON_PLAYER + player.radius) {
            this._killByBlackHole(id, player);
            // удалили из activePlayers — итерация по for..in устойчива к
            // удалению текущего ключа, но дальнейшую логику пропускаем.
            continue;
          }
        }

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
              me: p.maxEnergy ?? 200, // maxEnergy (?? 200 — fallback на случай древних объектов)
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
      // Чёрная дыра. Шлём только когда активна — экономим трафик в первые
      // 7 минут матча, когда дыры физически нет. Поля компактные: s/x/y.
      if (bhActive) {
        updateMsg.bh = {
          s: Number(bhStrength.toFixed(3)), // strength
          x: bhCx,
          y: bhCy,
        };
      }
      this.broadcast(msgpack.encode(updateMsg));
      // this.broadcast(msgpack.encode({
      //     type: 'update',
      //     activePlayers: existingPlayers,
      //     remainingTime: Math.max(0, Math.floor((this.state.matchDuration - elapsedTime) / 1000))
      // }));
    }, 16);
  }

  /**
   * Убивает игрока (или бота) от чёрной дыры. По сути — копия death-ветки
   * из collision.js#checkCollisions_bullet_player, но без kill-кредита
   * стрелку (это «environmental kill»). Шлём те же события смерти, чтобы
   * клиент стандартно проиграл анимацию + поставил игрока в очередь респавна.
   */
  _killByBlackHole(playerId, player) {
    let killed = 'none';
    if (this.state.allPlayersLobby[playerId]) {
      killed = this.state.allPlayersLobby[playerId].name || 'none';
      this.state.allPlayersLobby[playerId].deaths++;
    }

    this.broadcast(
      msgpack.encode({
        type: 'playerDeath',
        pid: playerId,
        kd: killed,
        kn: 'BLACK HOLE', // имя в kill-feed-е, чтобы было понятно кто «убил»
        ba: 0,
        bh: true,         // флаг: это смерть от дыры — клиент может усилить эффект
      }),
    );
    this.broadcast(
      msgpack.encode({
        type: 'explosion_death',
        x: player.x,
        y: player.y,
        angle: 0,
        c: player.color,
      }),
    );
    this.broadcast(
      msgpack.encode({
        type: 'removePlayer',
        pid: playerId,
      }),
    );

    delete this.state.activePlayers[playerId];
    player.deathTime = Date.now();

    // Бот не уважает респавн — удаляем полностью, как и при обычной смерти.
    if (
      this.state.allPlayersLobby[playerId] &&
      this.state.allPlayersLobby[playerId].isBot === true
    ) {
      delete this.state.allPlayersLobby[playerId];
    }
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

    // Восстанавливаем стены из снапшота (дыра по ходу матча их съела).
    // Мутируем массив in-place — внешние ссылки на this.walls не должны
    // протухать (например, в WS-хендлерах addWall/removeWall, в коллизиях).
    // wallIdCounter тоже сдвигаем выше нового максимума, чтобы новые KeyF
    // стены не получали id уже существующей.
    this.walls.length = 0;
    for (const w of this.initialWalls) {
      this.walls.push({ ...w });
    }
    this.state.wallIdCounter =
      this.walls.reduce((max, w) => Math.max(max, w.id), -1) + 1;
    this.broadcast(
      msgpack.encode({
        type: 'updateWalls',
        walls: this.walls,
      }),
    );

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
    const newLobby = new Lobby(lobbyID, lobbyOwner, lobbyPassword || '', lobbyName || '');
    this.lobbies.set(lobbyID, newLobby);
    console.log('Создано лобби:', {
      id: newLobby.id,
      name: newLobby.lobbyName,
      playersCount: newLobby.clients.size,
      maxPlayers: newLobby.maxPlayers,
      lobbyOwner: newLobby.lobbyOwner,
      hasPassword: !!lobbyPassword,
    });
    return newLobby;
  }

  /**
   * Получить лобби по id. Чистая функция: если лобби нет, возвращает null
   * и НЕ создаёт ничего нового. Раньше при промахе создавалось мусорное
   * лобби, что плодило фантомные записи.
   */
  getLobby(id) {
    if (!id) return null;
    return this.lobbies.get(id) || null;
  }

  /**
   * Можно ли войти в лобби с этим паролем. Открытые лобби — всегда да.
   */
  canJoinLobby(id, lobbyPassword) {
    const lobby = this.getLobby(id);
    if (!lobby) return false;
    if (lobby.clients.size >= lobby.maxPlayers) return false;
    if (lobby.lobbyPassword && lobby.lobbyPassword !== lobbyPassword) return false;
    return true;
  }

  /**
   * Найти первое открытое лобби (без пароля и со свободным местом),
   * или вернуть null. Используется при подключении нового игрока.
   * Если совсем ничего нет — вызывающий код решит что делать (например,
   * упасть в lobby_0).
   */
  findOpenLobby() {
    for (const lobby of this.lobbies.values()) {
      if (lobby.clients.size < lobby.maxPlayers && !lobby.lobbyPassword) {
        return lobby;
      }
    }
    return null;
  }

  getLobbiesInfo() {
    return Array.from(this.lobbies.values()).map((lobby) => ({
      id: lobby.id,
      name: lobby.lobbyName || '',
      playersCount: lobby.clients.size,
      lobbyOwner: lobby.lobbyOwner,
      hasPassword: !!lobby.lobbyPassword,
    }));
  }

  /**
   * Дефолтное лобби — всегда `lobby_0`. Раньше брался первый по порядку
   * элемент Map, что в worst-case могло быть удаляемым лобби.
   */
  getDefaultLobby() {
    return this.lobbies.get('lobby_0') || null;
  }

  moveToDefaultLobby(client) {
    const defaultLobby = this.getDefaultLobby();
    if (defaultLobby) {
      defaultLobby.addClient(client, client.playerId);
    }
  }

  removeLobby(id) {
    const lobby = this.lobbies.get(id);
    if (!lobby) return false;
    // Удаляем из Map ДО переезда клиентов — иначе moveToDefaultLobby
    // может в worst-case взять то же самое удаляемое лобби.
    this.lobbies.delete(id);
    lobby.clients.forEach((client) => {
      this.moveToDefaultLobby(client);
    });
    return true;
  }
}

module.exports = {
  Lobby,
  LobbyManager,
};
