/**
 * Единый источник правды по оружию.
 *
 * Поля:
 *  - bulletCount, speed, damage — параметры пули
 *  - minSpread, maxSpread — разброс (рад). Первый выстрел после паузы идёт
 *    с minSpread; при удержании огня лерпится к maxSpread, после паузы
 *    (>500мс) сбрасывается обратно к minSpread.
 *  - sideOffset / forwardOffset — точка вылета пули в локальной системе игрока
 *    (+X вперёд, +Y вправо). Должно совпадать с дулом отрисовки оружия.
 *  - cooldown — мин. интервал между выстрелами (мс).
 *  - abilityProperty — имя bool-флага на player; ставится в false на момент
 *    анимации/кулдауна и обратно в true когда оружие готово.
 *  - energyCost — расход энергии за один выстрел (выстрел = одна команда shoot,
 *    даже если bulletCount > 1). Чем больше суммарный урон, тем больше расход.
 *  - bulletRadius — опционально, иначе считается из damage.
 */
const WEAPONS = {
  pistol: {
    // Чисто ближний бой — никаких пуль. Только AoE удар по дуге ~150°
    // вокруг игрока: сервер находит всех в пределах meleeRadius и в полу-
    // угле minSpread от направления взгляда, наносит damage за один свинг.
    // Клиент рисует расширяющееся полукольцо (shockwave), визуального трейла
    // и пуль нет.
    bulletCount: 0,
    speed: 0,
    damage: 40,
    minSpread: 1.3,           // 1.3 рад ≈ 75° полу-угол → ~150° полная дуга
    maxSpread: 1.3,
    sideOffset: 0,
    forwardOffset: 0,
    cooldown: 700,
    abilityProperty: 'canShootPistol',
    energyCost: 30,
    isMelee: true,
    meleeRadius: 150,         // дальность удара (px) — короткая
  },
  shotgun: {
    bulletCount: 5,
    speed: 55,
    damage: 25,
    minSpread: 0.3,
    maxSpread: 0.45,
    sideOffset: 20,
    forwardOffset: 100,
    cooldown: 800,
    abilityProperty: 'canShootShotgun',
    energyCost: 40,
  },
  rifle: {
    bulletCount: 1,
    speed: 160,
    damage: 28,
    minSpread: 0,
    maxSpread: 0.25,
    sideOffset: 0,
    forwardOffset: 110,
    cooldown: 100,
    abilityProperty: 'canShootRifle',
    energyCost: 9,
  },
  orbital: {
    bulletCount: 1,
    speed: 200,
    damage: 38,
    minSpread: 0,
    maxSpread: 0.08,
    sideOffset: 0,
    forwardOffset: 70,
    cooldown: 90,
    abilityProperty: 'canShootOrbital',
    energyCost: 9,
  },
  spiral: {
    bulletCount: 1,
    speed: 120,
    damage: 55,
    minSpread: 0,
    maxSpread: 0.3,
    sideOffset: 0,
    forwardOffset: 80,
    cooldown: 250,
    abilityProperty: 'canShootSpiral',
    energyCost: 18,
  },
  vortex: {
    bulletCount: 1,
    speed: 70,
    damage: 75,
    minSpread: 0.05,
    maxSpread: 0.18,
    sideOffset: 0,
    forwardOffset: 75,
    cooldown: 500,
    abilityProperty: 'canShootVortex',
    energyCost: 30,
  },
  starburst: {
    bulletCount: 1,
    speed: 220,
    damage: 20,
    minSpread: 0,
    maxSpread: 0.1,
    sideOffset: 0,
    forwardOffset: 90,
    cooldown: 70,
    abilityProperty: 'canShootStarburst',
    energyCost: 6,
  },
  crystal: {
    bulletCount: 1,
    speed: 140,
    damage: 90,
    minSpread: 0.1,
    maxSpread: 0.4,
    sideOffset: 0,
    forwardOffset: 100,
    cooldown: 700,
    abilityProperty: 'canShootCrystal',
    energyCost: 40,
  },
  swarm: {
    bulletCount: 3,
    speed: 95,
    damage: 18,
    minSpread: 0.4,
    maxSpread: 0.7,
    sideOffset: 0,
    forwardOffset: 60,
    cooldown: 180,
    abilityProperty: 'canShootSwarm',
    energyCost: 18,
  },
};

module.exports = { WEAPONS };
