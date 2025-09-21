const minecraftData = require('minecraft-data');
const prismarineItem = require('prismarine-item');
const pathfinder = require('./pathfinder.js');
const vec3 = require('vec3');
const fs = require('fs');

const woolBlocks = fs.readFileSync('wool-blocks.txt', 'utf8').split(/\r?\n/).filter(Boolean);

const botContexts = new WeakMap();

function init(bot) {
    if (!bot) {
        throw new Error('Cannot initialise actions without a bot instance.');
    }

    const version = bot.version ?? bot?.registry?.version?.minecraftVersion;

    if (!version && !bot.registry) {
        throw new Error('Bot version unavailable. Make sure the bot has spawned before calling action helpers.');
    }

    const mcData = bot.registry ?? minecraftData(version);
    const Item = bot.registry?.Item ?? prismarineItem(version);

    botContexts.set(bot, { mcData, Item });

    if (typeof bot.once === 'function') {
        bot.once('end', () => botContexts.delete(bot));
    }
}

function ensureContext(bot) {
    if (!bot) {
        throw new Error('Bot instance is required.');
    }

    if (!botContexts.has(bot)) {
        init(bot);
    }

    return botContexts.get(bot);
}

function sleep(time) {
    return new Promise(resolve=>setTimeout(resolve, time));
}

const checkOP = async (bot)=>{
    const matches = await bot.tabComplete('/setblo');
    return matches.length > 0;
};

const pathfind = async (bot, position, range = 1)=>{
    bot.task.push('pathfind');

    let botPosition = bot.entity.position;
    let path = pathfinder.path(bot, bot.entity.position, position, range);

    while (botPosition.distanceTo(position) > range) {
        path = pathfinder.path(bot, botPosition, position, range);

        if (path.length) {
            pathfinder.walk(bot, path[path.length-1].position);
        }

        await sleep(100);

        botPosition = bot.entity.position;
    }

    bot.clearControlStates();
    bot.task.pop();
};

let lastSheep;

const getWool = async (bot, block)=>{
    bot.task.push('collect wool');

    try {
        ensureContext(bot);

        const index = woolBlocks.indexOf(block);

        if (index === -1) {
            console.warn(`Unknown wool variant "${block}".`);
            return;
        }

        if (!lastSheep) {
            const sheep = bot.nearestEntity((entity)=>{
                return entity.name === 'sheep';
            });
            if (sheep) lastSheep = sheep.position;
        }

        if (lastSheep) {
            await pathfind(bot, lastSheep, 4);
        }

        const sheep = bot.nearestEntity((entity) => {
            return entity.name === 'sheep' && entity.metadata?.[16] === index;
        });

        if (sheep) {
            lastSheep = sheep.position;

            await pathfind(bot, sheep.position, 2);
            await equip(bot, 'shears');
            await bot.activateEntity(sheep);

            await sleep(1000);

            let wool = bot.nearestEntity((entity) => {
                return entity.name === 'item';
            });

            for (let loops = 0; loops < 5 && wool; loops++) {
                await pathfind(bot, wool.position.clone(), 1.2);

                wool = bot.nearestEntity((entity) => {
                    return entity.name === 'item';
                });
            }
        } else {
            console.log(`Can't find sheep for ${block}.`);
        }
    } finally {
        bot.task.pop();
    }
};

const clearBlock = async (bot, position)=>{
    bot.task.push('clear');

    try {
        if (bot.entity.position.distanceTo(position) > 5) {
            await pathfind(bot, position, 4);
        }

        const block = bot.blockAt(position);

        if (!block || block.name === 'air') {
            return;
        }

        if (bot.game.gameMode === 'survival') {
            // TODO: fetch tools for survival block breaking.
        }

        await bot.dig(block, true);

        // TODO: Remove entities from space too.
    } finally {
        bot.task.pop();
    }
};

function checkInventory(bot, itemName) {
    const items = bot.inventory.items();
    return items.filter((item) => item.name === itemName).length;
}

const equip = async (bot, item, slot='hand')=>{
    bot.task.push('equip');

    try {
        const { mcData, Item } = ensureContext(bot);
        const itemInfo = mcData.itemsByName[item];

        if (!itemInfo) {
            console.warn(`Unknown item "${item}" for version ${bot.version}.`);
            return;
        }

        const itemType = itemInfo.id;

        if (!checkInventory(bot, item)) {
            if (bot.game.gameMode === 'creative') {
                if (!bot.creative) {
                    console.warn('Creative inventory helper unavailable; cannot spawn items.');
                } else {
                    await bot.creative.setInventorySlot(36, new Item(itemType, 1));
                }
            } else if (item.endsWith('_wool')) {
                await getWool(bot, item);
            } else {
                console.log("Can't get item.");
            }
        }

        await bot.equip(itemType, slot);
    } finally {
        bot.task.pop();
    }
};

const placeBlock = async (bot, position, type="dirt")=>{
    bot.task.push('place');

    try {
        ensureContext(bot);

        await clearBlock(bot, position).catch(console.log);

        if (type === 'air' || type === 'cave_air' || type === 'void_air') {
            return;
        }

        await equip(bot, type);

        if (bot.entity.position.distanceTo(position) > 5) {
            await pathfind(bot, position, 4);
        }

        const referenceBlock = bot.blockAt(position.offset(0, -1, 0), false);

        if (!referenceBlock) {
            console.warn('Unable to find reference block for placement.');
            return;
        }

        await bot.placeBlock(referenceBlock, vec3(0, 1, 0)).catch(console.log);
    } finally {
        bot.task.pop();
    }
};

exports.sleep = sleep;
exports.checkOP = checkOP;
exports.getWool = getWool;
exports.pathfind = pathfind;
exports.clearBlock = clearBlock;
exports.placeBlock = placeBlock;
exports.init = init;
