const msgpack = require('@msgpack/msgpack');

/**
 * Произвести выстрел игроком/ботом по конфигу оружия.
 * @param {object} args
 * @param {object} args.player — стрелок
 * @param {number} args.angle — угол прицела (мировой)
 * @param {object} args.state — стейт лобби (нужен bulletCounter, bullets)
 * @param {string} args.playerId — id стрелка (для broadcast и owner-check)
 * @param {function} args.broadcast — функция рассылки (msg) => ws.send(msg)
 * @param {object} args.weapon — конфиг из WEAPONS (см. weapons.js)
 */
// Параметры heat-up: первый выстрел после паузы — minSpread,
// при удержании огня spread лерпится к maxSpread.
const SPREAD_RESET_MS = 500;
const SPREAD_GROW_RATE = 0.35;

function shoot({ player, angle, state, playerId, broadcast, weapon }) {
    const now = Date.now();

    if (now - player.lastShootTime < weapon.cooldown) return;

    // Динамический разброс — отдельное состояние на каждое оружие
    if (!player.spreadByWeapon) player.spreadByWeapon = {};
    const prevSpread = player.spreadByWeapon[weapon.abilityProperty];
    const elapsedSinceLastShot = now - player.lastShootTime;
    let currentSpread;
    if (prevSpread === undefined || elapsedSinceLastShot > SPREAD_RESET_MS) {
        currentSpread = weapon.minSpread;
    } else {
        currentSpread = Math.min(
            weapon.maxSpread,
            prevSpread + (weapon.maxSpread - prevSpread) * SPREAD_GROW_RATE,
        );
    }
    player.spreadByWeapon[weapon.abilityProperty] = currentSpread;

    player[weapon.abilityProperty] = false;
    player.lastShootTime = now;
    broadcast(msgpack.encode({
        type: 'canShoot',
        pid: playerId,                    // playerId
        np: weapon.abilityProperty,       // nameProperty
        cs: false,                        // canShoot
        shootCooldown: weapon.cooldown,
        lastShootTime: now,
    }));

    // balls_count больше не расходуется на стрельбу — это HP-индикатор.
    // Энергия списывается на уровне диспетчера в server_2.js.

    // Радиус пули зависит от урона (больше урон → крупнее пуля).
    // Можно переопределить явным weapon.bulletRadius.
    const bulletRadius = weapon.bulletRadius ?? (3 + weapon.damage * 0.08);

    for (let i = 0; i < weapon.bulletCount; i++) {
        const spread = (Math.random() - 0.5) * 2 * currentSpread;
        const bulletAngle = angle + spread;
        const perpendicularAngle = angle + Math.PI / 2;

        const bulletX = player.x
            + Math.cos(angle) * weapon.forwardOffset
            + Math.cos(perpendicularAngle) * weapon.sideOffset;
        const bulletY = player.y
            + Math.sin(angle) * weapon.forwardOffset
            + Math.sin(perpendicularAngle) * weapon.sideOffset;

        const bullet = {
            bulletId: state.bulletCounter++,
            x: bulletX,
            y: bulletY,
            // prevX/prevY — реальная предыдущая позиция пули. На спавне совпадает
            // с x/y, чтобы первый тик коллизий проверял лишь точку спавна,
            // а не «фантомный» сегмент назад на длину velocity (иначе пуля
            // могла «попасть» в стену ЗА спиной игрока, через которую сегмент
            // дотянулся бы при подходе вплотную).
            prevX: bulletX,
            prevY: bulletY,
            angle: bulletAngle,
            radius: bulletRadius,
            speed: weapon.speed,
            velocityX: Math.cos(bulletAngle) * weapon.speed,
            velocityY: Math.sin(bulletAngle) * weapon.speed,
            acceleration: 0.5,
            playerId: playerId,
            color: player.color,
            damage: weapon.damage,
            maxSpeed: 300,
        };

        state.bullets.push(bullet);

        broadcast(msgpack.encode({
            type: 'bullet',
            bid: bullet.bulletId,    // bulletId
            x: bullet.x,
            y: bullet.y,
            radius: bullet.radius,
            angle: bullet.angle,
            speed: bullet.speed,
            color: player.color,
            pid: bullet.playerId,    // playerId
            bc: player.balls_count,  // balls_count
        }));
    }
}

function move(player, data, state) {
    if (!state.activePlayers[player.playerId]) return; // игрок мёртв — не двигаем

    const now = Date.now();

    if (now - player.lastUpdate >= 16) {
        player.lastUpdate = now;
        if (data.keys.w || data.keys.s || data.keys.a || data.keys.d) {
            if (data.keys.w) player.velocityY -= player.acceleration;
            if (data.keys.s) player.velocityY += player.acceleration;
            if (data.keys.a) player.velocityX -= player.acceleration;
            if (data.keys.d) player.velocityX += player.acceleration;

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
    move,
};
