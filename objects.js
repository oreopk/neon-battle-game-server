const functions = require('./functions.js');
const control = require('./control.js');
const msgpack = require('@msgpack/msgpack');
const { WEAPONS } = require('./weapons.js');

// Пул оружий, из которого боты берут ствол при создании.
// Берём все ключи из WEAPONS — захочешь исключить какое-то (например shotgun
// чтобы боты не лупили дробью), уберёшь его отсюда.
const BOT_WEAPON_POOL = Object.keys(WEAPONS);
function pickRandomWeaponName() {
    return BOT_WEAPON_POOL[Math.floor(Math.random() * BOT_WEAPON_POOL.length)];
}

// Длина одной очереди стрельбы бота — 2..5 выстрелов подряд,
// потом длинная передышка.
function randomBurstSize() {
    return 2 + Math.floor(Math.random() * 4);
}

function createPlayerData(playerId, isBot = false) {
    const radius = 25;
    let angle;
    let health;
    if(!isBot){
        angle = Math.random() * Math.PI * 2;
        health = 100;
    }
    else{
        health = 100;
        angle = 0;
    }

    return  {
        x: 0,
        y: 0,
        angle: angle,
        color: `hsl(${Math.random() * 360}, 100%, 50%)`,
        velocityX: 0,
        velocityY: 0,
        acceleration: 2,
        maxSpeed: 15,
        radius: radius,
        health: health,
        playerId: playerId,
        isBot: isBot,
        name: isBot ? `${playerId}__BOT` : playerId,
        shootAngle: Math.random() * Math.PI * 2,
        friction: 0.98,
        lastShotTime: 0,
        shootInterval: isBot ? 2000 : null,
        // balls_count — визуальный индикатор HP в шариках вокруг игрока.
        // Полное HP = balls_max_count шариков, каждое попадание уменьшает.
        balls_count: 10,
        balls_max_count: 10,
        shieldActive: false,
        kills: 0,
        deaths: 0,
        isShooting:false,
        currentShootMode: 'pistol',
        shield_on: false, // пока не используется на беке
        lastShootTime: 0, // Время последнего выстрела
        // Флаги «можно стрелять» по каждому оружию — выставляются в false
        // на момент анимации/кулдауна и обратно в true когда оружие готово.
        canShootPistol: true,
        canShootShotgun: true,
        canShootRifle: true,
        canShootOrbital: true,
        canShootSpiral: true,
        canShootVortex: true,
        canShootStarburst: true,
        canShootCrystal: true,
        canShootSwarm: true,
        deathTime:0,
        energy: 200,
        maxEnergy: 200,
        lastShiftTime: 0,
        lastShieldActivateTime: 0,
    };
}

function addPlayer(state,playerId, isBot = false, walls ,width_wall,height_wall) {

    const playerData = createPlayerData(playerId, isBot);
    const position = functions.getRandomPosition(playerData.radius, walls, width_wall, height_wall);

    if (!position) return null;

    playerData.x = position.x;
    playerData.y = position.y;

    state.allPlayersLobby[playerId] = playerData;
    state.activePlayers[playerId] = playerData;

    return playerData;
}

function respawnPlayer(playerId,state,walls,width_wall,height_wall,broadcast) {
    const player = state.allPlayersLobby[playerId];
    if (!player) return;

    player.health = 100;
    player.balls_count = player.balls_max_count;
    player.shieldActive = false;
    player.isShooting = false;
    player.velocityX = 0;
    player.velocityY = 0;
    player.energy = player.maxEnergy;
    player.energyDepletedAt = null;
    player.lastShiftTime = 0;
    player.lastShieldActivateTime = 0;
    // Сброс флагов поведения бота при респавне (на обычных игроков
    // не влияет — поля просто остаются false/0).
    player.waitingForEnergy = false;
    player.shootPauseUntil = 0;
    if (player.isBot) {
        player.burstShotsLeft = randomBurstSize();
    }

    const position = functions.getRandomPosition(player.radius, walls, width_wall, height_wall);
    // getRandomPosition может вернуть null, если все слоты заняты —
    // тогда оставляем игрока в его последней позиции, иначе .x/.y упадут с TypeError.
    if (position) {
        player.x = position.x;
        player.y = position.y;
    }

    state.activePlayers[playerId] = player;
    broadcast(msgpack.encode({
        type: 'respawn',
        id: playerId
    }));
}

function add_bot(state, walls, width_wall, height_wall, lobby, lobbyManager) {
    const playerId = Math.random().toString(36).substring(7) + "__BOT";
    const bot = addPlayer(state,playerId, true,walls,width_wall,height_wall);
    if (!bot) return;
    bot.lobbyId  = lobby.id;
    // Случайное оружие при создании бота — каждый бот «пожизненно» носит свой ствол.
    bot.botWeaponName = pickRandomWeaponName();
    bot.currentShootMode = bot.botWeaponName;
    // Состояние стрельбы бота:
    //  waitingForEnergy — после полного опустошения шкалы бот ждёт пока
    //  не наберёт хотя бы 50% (как просили), и только потом снова стреляет.
    //  shootPauseUntil — случайные длинные «передышки» между очередями,
    //  чтобы бот не палил равномерно как кулемёт.
    bot.waitingForEnergy = false;
    bot.shootPauseUntil = 0;
    bot.burstShotsLeft = randomBurstSize();
    bot.moveAngle = Math.random() * Math.PI * 2;
    bot.intervals = {
        // ВАЖНО: НЕ объявлять внутри `const bot = ...` — иначе TDZ блокирует
        // доступ к внешней `bot` через closure при clearInterval (TypeError
        // 'Cannot access bot before initialization'). Используем `b` для
        // текущего состояния из state.
        shooting: setInterval(() => {
            if (!state.activePlayers[playerId]) {
                clearInterval(bot.intervals.shooting);
                return;
            }
            const b = state.activePlayers[playerId];
            const weapon = WEAPONS[b.botWeaponName] || WEAPONS.pistol;
            const now = Date.now();

            // Поворот корпуса бота на ближайшего врага — даже когда не стреляет
            // (нет энергии, передышка и т.д.), чтобы спрайт всегда смотрел в цель.
            const nearestEnemy = functions.findNearestEnemy(b, state.activePlayers);
            if (nearestEnemy) {
                turnBotShootTowardsEnemy(b, nearestEnemy);
                b.angle = b.shootAngle;
            }

            // Ждём 50% энергии после полного опустошения.
            if (b.waitingForEnergy) {
                if (b.energy >= b.maxEnergy * 0.5) {
                    b.waitingForEnergy = false;
                } else {
                    return;
                }
            }

            // Длинная передышка между очередями.
            if (now < b.shootPauseUntil) return;
            if (!nearestEnemy) return;

            // Внутри очереди интервал ≈ cooldown оружия + небольшой джиттер,
            // чтобы стрельба выглядела как настоящая очередь, а не одиночные клики.
            const burstInterval = weapon.cooldown + Math.random() * 80;
            if (now - b.lastShotTime < burstInterval) return;

            // Не хватает энергии на этот выстрел — уходим в режим ожидания.
            if (b.energy < weapon.energyCost) {
                b.waitingForEnergy = true;
                return;
            }

            const currentLobby = lobbyManager.getLobby(b.lobbyId);
            if (!currentLobby) return;

            control.shoot({
                player: b,
                angle: b.shootAngle,
                state,
                playerId,
                broadcast: (message) => currentLobby.broadcast(message),
                weapon: weapon,
            });
            b.energy -= weapon.energyCost;
            b.lastShotTime = now;

            b.burstShotsLeft -= 1;
            if (b.burstShotsLeft <= 0) {
                // Очередь закончена — уходим в длинную передышку 0.8–2.5 сек,
                // потом готовим новую очередь.
                b.burstShotsLeft = randomBurstSize();
                b.shootPauseUntil = now + (800 + Math.random() * 1700);
            }
        }, 100),

        movement: setInterval(() => {
            if (state.activePlayers[playerId]) {
                state.activePlayers[playerId].moveAngle = Math.random() * Math.PI * 2;
            } else {
                clearInterval(bot.intervals.movement);
            }
        }, Math.random() * 200 + 1200)
    };
}

function add_static_bot(state, walls, width_wall, height_wall, lobby, lobbyManager) {
    const playerId = Math.random().toString(36).substring(7) + "__STATIC_BOT";
    const bot = addPlayer(state, playerId, true, walls, width_wall, height_wall);
    if (!bot) return;
    bot.lobbyId = lobby.id;
    bot.isStatic = true;      // не двигается
    bot.velocityX = 0;
    bot.velocityY = 0;
    bot.acceleration = 0;
    bot.botWeaponName = pickRandomWeaponName();
    bot.currentShootMode = bot.botWeaponName;
    bot.waitingForEnergy = false;
    bot.shootPauseUntil = 0;
    bot.burstShotsLeft = randomBurstSize();
    bot.intervals = {
        // То же замечание что и в add_bot — внутреннюю переменную называем `b`,
        // чтобы не попасть в TDZ для внешней `bot` при clearInterval.
        shooting: setInterval(() => {
            if (!state.activePlayers[playerId]) {
                clearInterval(bot.intervals.shooting);
                return;
            }
            const b = state.activePlayers[playerId];
            const weapon = WEAPONS[b.botWeaponName] || WEAPONS.pistol;
            const now = Date.now();

            const nearestEnemy = functions.findNearestEnemy(b, state.activePlayers);
            if (nearestEnemy) {
                turnBotShootTowardsEnemy(b, nearestEnemy);
                b.angle = b.shootAngle;
            }

            if (b.waitingForEnergy) {
                if (b.energy >= b.maxEnergy * 0.5) {
                    b.waitingForEnergy = false;
                } else {
                    return;
                }
            }

            if (now < b.shootPauseUntil) return;
            if (!nearestEnemy) return;

            const burstInterval = weapon.cooldown + Math.random() * 80;
            if (now - b.lastShotTime < burstInterval) return;

            if (b.energy < weapon.energyCost) {
                b.waitingForEnergy = true;
                return;
            }

            const currentLobby = lobbyManager.getLobby(b.lobbyId);
            if (!currentLobby) return;

            control.shoot({
                player: b,
                angle: b.shootAngle,
                state,
                playerId,
                broadcast: (message) => currentLobby.broadcast(message),
                weapon: weapon,
            });
            b.energy -= weapon.energyCost;
            b.lastShotTime = now;

            b.burstShotsLeft -= 1;
            if (b.burstShotsLeft <= 0) {
                b.burstShotsLeft = randomBurstSize();
                b.shootPauseUntil = now + (800 + Math.random() * 1700);
            }
        }, 100)
        // движения нет — стоит на месте
    };
}

function turnBotShootTowardsEnemy(bot, enemy) {
    if (!enemy) return;

    const dx = enemy.x - bot.x;
    const dy = enemy.y - bot.y;
    const exactAngle = Math.atan2(dy, dx);

    const spread = 0.2;
    const randomSpread = (Math.random() - 0.5) * 2 * spread;

    bot.shootAngle = exactAngle + randomSpread;
}

function updateBots(state) {
    for (const id in state.activePlayers) {
        const bot = state.activePlayers[id];
        if (!bot.isBot) continue;
        if (bot.isStatic) continue; // статичный бот не двигается

        // Движение бота — по moveAngle (рандомные блуждания), а angle оставляем
        // под поворот корпуса в сторону врага (его выставляет интервал стрельбы).
        const moveAngle = bot.moveAngle ?? bot.angle;
        bot.velocityX += Math.cos(moveAngle) * bot.acceleration;
        bot.velocityY += Math.sin(moveAngle) * bot.acceleration;

        const speed = Math.sqrt(bot.velocityX * bot.velocityX + bot.velocityY * bot.velocityY);
        if (speed > bot.maxSpeed) {
            const ratio = bot.maxSpeed / speed;
            bot.velocityX *= ratio;
            bot.velocityY *= ratio;
        }
    }
}

function check_new_player(state, broadcast){
    const existingPlayers = Object.keys(state.activePlayers).map(id => {
        const p = state.activePlayers[id];
        return {
            pid: id,  // playerId
            p: {      // player
                x: p.x,
                y: p.y,
                radius: p.radius,
                color: p.color,
                speed: p.speed,
                health: p.health,
                balls_count: p.balls_count,
            }
        };
    });
    broadcast(msgpack.encode({
        type: 'existingPlayers',
        ap: existingPlayers // activePlayers
    }));
}

module.exports = {
    addPlayer,
    createPlayerData,
    respawnPlayer,
    add_bot,
    add_static_bot,
    updateBots,
    check_new_player
};