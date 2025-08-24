const { Noise } = require('noisejs');
const noiseInstance = new Noise(Math.random());

const attractionStrength = 500;
const maxAttractionForce = 100;
const minAttractionForce = 0.1;

function applyAttraction(object, width, height) {

    const centerX = width / 2;
    const centerY = height / 2;

    const dx = centerX - object.x;
    const dy = centerY - object.y;

    let distance = Math.sqrt(dx * dx + dy * dy);

    const directionX = dx / distance;
    const directionY = dy / distance;

    let attractionForce = (attractionStrength / distance); 
    attractionForce = Math.max(attractionForce, minAttractionForce);
    attractionForce = Math.min(attractionForce, maxAttractionForce);

    if(distance>200){
        object.velocityX += directionX *attractionForce;
        object.velocityY += directionY *attractionForce;
    }
}

function findNearestEnemy(bot,activePlayers) {
    let nearestEnemy = null;
    let minDistance = Infinity;

    for (const id in activePlayers) {
        const player = activePlayers[id];

        if ( id === bot.playerId) continue;

        const dx = player.x - bot.x;
        const dy = player.y - bot.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < minDistance) {
            minDistance = distance;
            nearestEnemy = player;
        }
    }

    return nearestEnemy;
}


function isPositionValid(x, y, radius, walls) {
    for (const wall of walls) {
        const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.width));
        const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.height));

        const distanceX = x - closestX;
        const distanceY = y - closestY;
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;

        if (distanceSquared < radius * radius) {
            return false;
        }
    }
    return true;
}

function getRandomPosition(radius, walls, width, height) {
    let x, y;
    let attempts = 0;
    const maxAttempts = 100;

    do {
        x = Math.random() * (width - 2 * radius) + radius;
        y = Math.random() * (height - 2 * radius) + radius;
        attempts++;
    } while (!isPositionValid(x, y, radius, walls) && attempts < maxAttempts);

    if (attempts >= maxAttempts) {
        console.error("Не удалось найти свободную позицию для игрока/бота");
        return null;
    }

    return { x, y };
}


function makePlayerObservable(player, onChange) {
    if (!player || typeof player !== 'object') {
        throw new Error('Player must be an object');
    }
    return new Proxy(player, {
        set(target, prop, newValue) {
            const oldValue = target[prop];
            target[prop] = newValue;
            if (prop === 'name' || prop === 'kills' || prop === 'deaths' || prop === 'health') {
                onChange(target.playerId, prop, oldValue, newValue);
            }
            
            return true;
        }
    });
}

function makePlayersObservable(players, onChange) {
    if (!players || typeof players !== 'object') {
        throw new Error('Players storage must be an object');
    }

    return new Proxy(players, {
        set(target, playerId, newPlayer) {
            if (newPlayer && typeof newPlayer === 'object') {

                if (target[playerId]) {
                    return true;
                }

                const oldPlayer = target[playerId];
                target[playerId] = makePlayerObservable(newPlayer, (_, prop, oldVal, newVal) => {
                    onChange(playerId, prop, oldVal, newVal);
                });
                
                if (!oldPlayer) {
                    onChange(playerId, 'added', null, newPlayer);
                }
            }
            return true;
        },
        deleteProperty(target, playerId) {
            delete target[playerId];
            onChange(playerId, 'deleted', target[playerId], null);
            return true;
        }
    });
}


function generatePerlinNoiseStars(width, height, Count, minSize, maxSize) {
    const stars = [];
    const scale = 0.05;

    for (let i = 0; i < Count; i++) {
        const x = Math.max(20, Math.min(
            (noiseInstance.simplex2(i * scale, 0) + 1) * 0.5 * (width - maxSize),
            width - maxSize - 20
        ));
        const y = Math.max(20, Math.min(
            (noiseInstance.simplex2(0, i * scale) + 1) * 0.5 * (height - maxSize),
            height - maxSize - 20
        ));

        const radius = Math.max(minSize, Math.min(
            minSize + noiseInstance.simplex2(i * scale, i * scale) * (maxSize - minSize),
            maxSize
        ));

        const newStar = { x, y, radius: radius};
            stars.push(newStar);
    }
    return stars;
}





module.exports = {
    makePlayersObservable,
    applyAttraction,
    findNearestEnemy,
    getRandomPosition,
    generatePerlinNoiseStars
};