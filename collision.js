const physics = require('./physics.js');
const msgpack = require('@msgpack/msgpack');

function checkCollisions_bullet_player(state, bullet, index, broadcast) {
        // Используем реальную предыдущую позицию (prevX/prevY), а не
        // x - velocity. На первом тике после спавна prev == current →
        // сегмент нулевой длины, что корректно: проверяется только сама
        // точка вылета, а не фейковый «трек назад» на длину velocity.
        const startX = bullet.prevX ?? (bullet.x - bullet.velocityX);
        const startY = bullet.prevY ?? (bullet.y - bullet.velocityY);
        const endX = bullet.x;
        const endY = bullet.y;
        for (const id in state.activePlayers) {
            const player = state.activePlayers[id];
            if (id == bullet.playerId) continue

            const shieldRadius = player.radius + 18; // чуть больше радиуса игрока
            const hitRadius = player.shieldActive ? shieldRadius : player.radius;

            if (physics.lineCircleIntersection(startX, startY, endX, endY, player.x, player.y, hitRadius, bullet.radius)) {

                // Щит поглощает пулю — урона нет
                if (player.shieldActive) {
                    broadcast(msgpack.encode({
                        type: 'removeBullet',
                        bid: bullet.bulletId,
                        bx: bullet.x,
                        by: bullet.y,
                        angle: bullet.angle,
                        ih: true,
                        sh: true,
                    }));
                    state.bullets.splice(index, 1);
                    return true;
                }

                if (player.health - bullet.damage <= 0) {
                    let killed = 'none';
                    let killerName = 'none';

                    if (state.allPlayersLobby[bullet.playerId]) {
                        killerName = state.allPlayersLobby[bullet.playerId].name;
                        state.allPlayersLobby[bullet.playerId].kills++;
                    }

                    if (state.allPlayersLobby[id]) {
                        killed = state.allPlayersLobby[id].name;
                        state.allPlayersLobby[id].deaths++;
                    }

                    broadcast(msgpack.encode({
                        type: 'playerDeath',
                        pid: id,             // playerId
                        kd: killed,          // killed
                        kn: killerName,      // killerName
                        ba: bullet.angle,    // bulletangle
                    }));

                    broadcast(msgpack.encode({
                        type: 'explosion_death',
                        x: player.x,
                        y: player.y,
                        angle: bullet.angle,
                        c: player.color      // color
                    }));

                    broadcast(msgpack.encode({
                        type: 'removePlayer',
                        pid: id              // playerId
                    }));
                    delete state.activePlayers[id];
                    player.deathTime=Date.now();
                    if (state.allPlayersLobby[id].isBot == true) {
                        delete state.allPlayersLobby[id];
                    }
                } else {
                    player.health -= bullet.damage;

                    broadcast(msgpack.encode({
                        type: 'explosion_tick',
                        x: player.x,
                        y: player.y,
                        angle: bullet.angle,
                        c: player.color      // color
                    }));

                    broadcast(msgpack.encode({
                        type: 'updateHealth',
                        pid: id,             // playerId
                        hp: player.health,   // health
                    }));
                }

                broadcast(msgpack.encode({
                    type: 'removeBullet',
                    bid: bullet.bulletId, // bulletId
                    angle: bullet.angle,
                    ih: true,             // ishit
                }));
                state.bullets.splice(index, 1);
                return true
            }
        }
}

function checkCollisions(state, bullet, index, walls, broadcast) {
    // См. комментарий выше — используем prevX/prevY чтобы первый тик
    // проверял только спавн-точку, а не уходил сегментом назад через
    // стену за спиной стрелка.
    const startX = bullet.prevX ?? (bullet.x - bullet.velocityX);
    const startY = bullet.prevY ?? (bullet.y - bullet.velocityY);
    const endX = bullet.x;
    const endY = bullet.y;
    for (let j = walls.length - 1; j >= 0; j--) {
        const wall = walls[j];
        const intersection = physics.lineRectIntersection(startX, startY, endX, endY, wall);
        if(intersection){
            const dirX = Math.cos(bullet.angle);
            const dirY = Math.sin(bullet.angle);
            const dot = dirX * intersection.normal.x + dirY * intersection.normal.y;
            const reflectX = dirX - 2 * dot * intersection.normal.x;
            const reflectY = dirY - 2 * dot * intersection.normal.y;
            const newAngle = Math.atan2(reflectY, reflectX);

            // Рикошет при касательном (очень остром) ударе:
            // |dot| мал → угол к нормали близок к 90° → почти параллельно стене.
            const RICOCHET_DOT_THRESHOLD = 0.45;
            const MAX_RICOCHETS = 2;
            if (Math.abs(dot) < RICOCHET_DOT_THRESHOLD && (bullet.ricochets || 0) < MAX_RICOCHETS) {
                const speed = Math.hypot(bullet.velocityX, bullet.velocityY) || 50;
                bullet.angle = newAngle;
                bullet.velocityX = reflectX * speed;
                bullet.velocityY = reflectY * speed;
                // Сдвигаем пулю чуть в сторону нормали, чтобы не зацепиться повторно
                bullet.x = intersection.point.x + intersection.normal.x * (bullet.radius + 1);
                bullet.y = intersection.point.y + intersection.normal.y * (bullet.radius + 1);
                // После телепорта в точку отскока prev должен совпадать с текущей,
                // иначе на следующем тике сегмент (prev → next) пройдёт назад
                // через стену и пуля «попадёт» в неё повторно.
                bullet.prevX = bullet.x;
                bullet.prevY = bullet.y;
                bullet.ricochets = (bullet.ricochets || 0) + 1;
                broadcast(msgpack.encode({
                    type: 'bulletRicochet',
                    bid: bullet.bulletId,
                    x: bullet.x,
                    y: bullet.y,
                    angle: bullet.angle,
                }));
                return false;
            }

            state.bullets.splice(index, 1);
            broadcast(msgpack.encode({
                type: 'removeBullet',
                bid: bullet.bulletId, // bulletId
                bx: intersection.point.x, // bulletX
                by: intersection.point.y, // bulletY
                angle: newAngle,
                ih: false,            // ishit
            }));
            return true;
        }
    }
}
function checkWallCollisions(player, walls) {
    const nextX = player.x + player.velocityX;
    let collisionX = false;

    for (const wall of walls) {
        const closestX = Math.max(wall.x, Math.min(nextX, wall.x + wall.width));
        const closestY = Math.max(wall.y, Math.min(player.y, wall.y + wall.height));

        const dx = nextX - closestX;
        const dy = player.y - closestY;

        if (dx * dx + dy * dy < player.radius * player.radius) {
            collisionX = true;
            break;
        }
    }

    if (!collisionX) {
        player.x = nextX;
    } else {
        player.velocityX = 0;
    }

    const nextY = player.y + player.velocityY;
    let collisionY = false;

    for (const wall of walls) {
        const closestX = Math.max(wall.x, Math.min(player.x, wall.x + wall.width));
        const closestY = Math.max(wall.y, Math.min(nextY, wall.y + wall.height));

        const dx = player.x - closestX;
        const dy = nextY - closestY;

        if (dx * dx + dy * dy < player.radius * player.radius) {
            collisionY = true;
            break;
        }
    }

    if (!collisionY) {
        player.y = nextY;
    } else {
        player.velocityY = 0;
    }
}

module.exports = {
    checkCollisions_bullet_player,
    checkCollisions,
    checkWallCollisions,
};