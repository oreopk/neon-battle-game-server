const msgpack = require('@msgpack/msgpack');

function shoot(player, angle, state, playerId, broadcast, bulletCount, speed=100, maxSpread=0, sideOffset=0, forwardOffset=0, shootCooldown=0, abilityPropertyName=null, data=null, auto=false) {
    const currentTime = Date.now();
    
    if (currentTime - player.lastShootTime < shootCooldown) {
        return;
    }

    player[abilityPropertyName] = false;
    player.lastShootTime = currentTime;
    broadcast(msgpack.encode({
            type: 'canShoot',
            playerId: playerId,
            nameProperty: abilityPropertyName,
            canShoot: player[abilityPropertyName],
            shootCooldown: shootCooldown,
            lastShootTime: player.lastShootTime
    }));


    player.balls_count -= bulletCount;

    for (let i = 0; i < bulletCount; i++) {
        const spread = (Math.random() - 0.5) * 2 * maxSpread;
        const bulletAngle = angle + spread;
        const perpendicularAngle = angle + Math.PI / 2;

        const bulletX = player.x + Math.cos(angle) * forwardOffset + Math.cos(perpendicularAngle) * sideOffset;
        const bulletY = player.y + Math.sin(angle) * forwardOffset + Math.sin(perpendicularAngle) * sideOffset;

        const bullet = {
            bulletId: state.bulletCounter++,
            x: bulletX,
            y: bulletY,
            angle: bulletAngle,
            radius: 7,
            speed: speed,
            velocityX: Math.cos(bulletAngle) * speed,
            velocityY: Math.sin(bulletAngle) * speed,
            acceleration: 0.5,
            playerId: playerId,
            color: player.color,
            damage: 45,
            maxSpeed: 300
        };

        state.bullets.push(bullet);

        let type;
        if (data) {
            type = data.type;
        }

        broadcast(msgpack.encode({
            type: 'bullet',
            bulletId: bullet.bulletId,
            x: bullet.x,
            y: bullet.y,
            radius: bullet.radius,
            angle: bullet.angle,
            color: player.color,
            playerId: bullet.playerId,
            balls_count: player.balls_count,
            shoot_type: type
        }));
    }
}

function move(player, data, state) {
    const now = Date.now();

    if (now - player.lastUpdate >= 16) {
        player.lastUpdate = now;
        if (data.keys.w || data.keys.s || data.keys.a || data.keys.d) {
            if (data.keys.w) {
                player.velocityY -= player.acceleration;
            }
            if (data.keys.s) {
                player.velocityY += player.acceleration;
            }
            if (data.keys.a) {
                player.velocityX -= player.acceleration;
            }
            if (data.keys.d) {
                player.velocityX += player.acceleration;
            }

            const speed = Math.sqrt(player.velocityX * player.velocityX + player.velocityY * player.velocityY);
            if (speed > player.maxSpeed) {
                const ratio = player.maxSpeed / speed;
                player.velocityX *= ratio;
                player.velocityY *= ratio;
            }
        }
    }
}

module.exports = {
    shoot,
    move
};