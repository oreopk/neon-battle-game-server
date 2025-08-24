

function isWallOverlapping(newWall, walls) {
    for (const wall of walls) {
        if (newWall.x < wall.x + wall.width &&
            newWall.x + newWall.width > wall.x &&
            newWall.y < wall.y + wall.height &&
            newWall.y + newWall.height > wall.y) {
            return true;
        }
    }
    return false;
}

function isInBlockedArea(wall) {
    const blockedArea = { x: 1500, y: 1500, width: 1000, height: 1000 };

    return (
        wall.x < blockedArea.x + blockedArea.width &&
        wall.x + wall.width > blockedArea.x &&
        wall.y < blockedArea.y + blockedArea.height &&
        wall.y + wall.height > blockedArea.y
    );
}

function generateRandomWalls(width, height, wallCount) {
    const walls = [];

    for (let i = 0; i < wallCount; i++) {
        const wallWidth = Math.random() * 600 + 20;
        const wallHeight = Math.random() * 400 + 20;
       
        const x = Math.random() * (width - wallWidth);
        const y = Math.random() * (height - wallHeight);
        
        const newWall = { id: i, x, y, width: wallWidth, height: wallHeight };

        if (!isWallOverlapping(newWall, walls) && !isInBlockedArea(newWall)) {
            walls.push(newWall);
        } else {
            i--;
        }
    }
    return walls;
}


module.exports = {
    generateRandomWalls
};