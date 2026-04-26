const functions = require('./functions.js');
const control = require('./control.js');
const msgpack = require('@msgpack/msgpack');
const { WEAPONS } = require('./weapons.js');

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

    const position = functions.getRandomPosition(player.radius, walls, width_wall, height_wall);

    player.x = position.x;
    player.y = position.y;

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
    bot.intervals = {
        shooting: setInterval(() => {
            if (state.activePlayers[playerId]) {
                const bot = state.activePlayers[playerId];
                bot.shootInterval = Math.random() * 100 + 1000;
                const nearestEnemy = functions.findNearestEnemy(bot, state.activePlayers);
                if (nearestEnemy) {
                    turnBotShootTowardsEnemy(bot, nearestEnemy);
                    const currentTime = Date.now();
                    if (currentTime - bot.lastShotTime >= bot.shootInterval) {
                        const currentLobby = lobbyManager.getLobby(bot.lobbyId)
                        if (currentLobby) {
                            control.shoot({
                                player: bot,
                                angle: bot.shootAngle,
                                state,
                                playerId,
                                broadcast: (message) => currentLobby.broadcast(message),
                                weapon: WEAPONS.pistol,
                            });
                        }
                        bot.lastShotTime = currentTime;
                    }
                }
            } else {
                clearInterval(bot.intervals.shooting);
            }
        }, 100),

        movement: setInterval(() => {
            if (state.activePlayers[playerId]) {
                state.activePlayers[playerId].angle = Math.random() * Math.PI * 2;
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
    bot.intervals = {
        shooting: setInterval(() => {
            if (state.activePlayers[playerId]) {
                const bot = state.activePlayers[playerId];
                const nearestEnemy = functions.findNearestEnemy(bot, state.activePlayers);
                if (nearestEnemy) {
                    turnBotShootTowardsEnemy(bot, nearestEnemy);
                    const currentLobby = lobbyManager.getLobby(bot.lobbyId);
                    if (currentLobby) {
                        control.shoot({
                            player: bot,
                            angle: bot.shootAngle,
                            state,
                            playerId,
                            broadcast: (message) => currentLobby.broadcast(message),
                            weapon: WEAPONS.pistol,
                        });
                    }
                }
            } else {
                clearInterval(bot.intervals.shooting);
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

        bot.velocityX += Math.cos(bot.angle) * bot.acceleration;
        bot.velocityY += Math.sin(bot.angle) * bot.acceleration;

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