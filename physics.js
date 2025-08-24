// Функция для проверки пересечения отрезка с прямоугольником
function lineRectIntersection(startX, startY, endX, endY, rect) {
    const rectLeft = rect.x;
    const rectRight = rect.x + rect.width;
    const rectTop = rect.y;
    const rectBottom = rect.y + rect.height;

    const sides = [
        { x1: rectLeft, y1: rectTop, x2: rectRight, y2: rectTop, normal: { x: 0, y: -1 } }, // Верхняя сторона
        { x1: rectRight, y1: rectTop, x2: rectRight, y2: rectBottom, normal: { x: 1, y: 0 } }, // Правая сторона
        { x1: rectLeft, y1: rectBottom, x2: rectRight, y2: rectBottom, normal: { x: 0, y: 1 } }, // Нижняя сторона
        { x1: rectLeft, y1: rectTop, x2: rectLeft, y2: rectBottom, normal: { x: -1, y: 0 } } // Левая сторона
    ];

    for (const side of sides) {
        const intersectionPoint = lineLineIntersection(startX, startY, endX, endY, side.x1, side.y1, side.x2, side.y2)
        if (intersectionPoint) {
            return {
                point: intersectionPoint,
                normal: side.normal
            };
        }
        
        
    }

    return false;
}

function lineLineIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
    const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

    if (denominator === 0) {
        return false;
    }

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denominator;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denominator;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            x: x1 + t * (x2 - x1),
            y: y1 + t * (y2 - y1)
        };
    }
    return null;
}

function lineCircleIntersection(startX, startY, endX, endY, circleX, circleY, circleRadius, bulletRadius) {
    const dx = endX - startX;
    const dy = endY - startY;
    const fx = startX - circleX;
    const fy = startY - circleY;

    const totalRadius = circleRadius + bulletRadius;

    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - totalRadius * totalRadius;

    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) {
        return false;
    }

    const t1 = (-b - Math.sqrt(discriminant)) / (2 * a);
    const t2 = (-b + Math.sqrt(discriminant)) / (2 * a);

    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}




module.exports = {
    lineRectIntersection,
    lineCircleIntersection
};