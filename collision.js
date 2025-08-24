const physics = require('./physics.js');
const msgpack = require('@msgpack/msgpack');

function checkCollisions_bullet_player(state, bullet, index, broadcast) {
        const startX = bullet.x - bullet.velocityX;
        const startY = bullet.y - bullet.velocityY;
        const endX = bullet.x;
        const endY = bullet.y;
        for (const id in state.activePlayers) {
            const player = state.activePlayers[id];
            if (id == bullet.playerId) continue

            if (physics.lineCircleIntersection(startX, startY, endX, endY, player.x, player.y, player.radius, bullet.radius)) {
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
                        playerId: id,
                        killed: killed,
                        bulletId: bullet.playerId,
                        killerName: killerName,
                        bulletangle: bullet.angle,
                    }));

                    broadcast(msgpack.encode({
                        type: 'explosion_death',
                        x: player.x,
                        y: player.y,
                        angle: bullet.angle,
                        color: player.color
                    }));

                    broadcast(msgpack.encode({
                        bullet_id: bullet.playerId,
                        player_id: id,
                        type: 'removePlayer',
                        playerId: id
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
                        color: player.color
                    }));

                    broadcast(msgpack.encode({
                        type: 'updateHealth',
                        playerId: id,
                        health: player.health,
                        bullet: bullet,
                    }));
                }

                broadcast(msgpack.encode({
                    type: 'removeBullet',
                    bulletId: bullet.bulletId,
                    angle: bullet.angle,
                    ishit: true,
                }));
                state.bullets.splice(index, 1);
                return true
            }
        }
}

function checkCollisions(state, bullet, index, walls, broadcast) {
    const startX = bullet.x - bullet.velocityX;
    const startY = bullet.y - bullet.velocityY;
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

            state.bullets.splice(index, 1);
            broadcast(msgpack.encode({
                type: 'removeBullet',
                bulletId: bullet.bulletId,
                bulletX: intersection.point.x,
                bulletY: intersection.point.y,
                angle: newAngle,
                ishit: false,
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