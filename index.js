const mineflayer = require('mineflayer');
const actions = require('./actions.js');
const getPixels = require('get-pixels');
const fs = require('fs');

const mcColor = require('./mc-colors.js');
const { buildModel } = require('./model-builder.js');

const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const palettes = JSON.parse(fs.readFileSync('palettes.json', 'utf8'));

const COLOR = {
    cyan: '\x1b[36m%s\x1b[0m',
    purple: '\x1b[35m%s\x1b[0m',
    blue: '\x1b[34m%s\x1b[0m',
    yellow: '\x1b[33m%s\x1b[0m',
    green: '\x1b[32m%s\x1b[0m',
    red: '\x1b[31m%s\x1b[0m'
};

const banner = `
    ███    ███  ██████       ██████  ██████  ██ ███    ██ ████████ ███████ ██████  
    ████  ████ ██            ██   ██ ██   ██ ██ ████   ██    ██    ██      ██   ██ 
    ██ ████ ██ ██      █████ ██████  ██████  ██ ██ ██  ██    ██    █████   ██████  
    ██  ██  ██ ██            ██      ██   ██ ██ ██  ██ ██    ██    ██      ██   ██ 
    ██      ██  ██████       ██      ██   ██ ██ ██   ████    ██    ███████ ██   ██ 
`;

let bot;

let printData = {
    isPrinting: false,
    progress: 0,
};

const readline = require("readline");

const reader = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let log = [
    [COLOR.cyan, 'Welcome to the himalayas!*']
];

function addLog(text, color='') {
    log.push([color, text]);
}

function createBar(x) {
    x = Math.round(x);
    return [...new Array(x).fill('■'), ...new Array(20-x).fill('□')].join('');
}

let healthBar = createBar(0);
let foodBar = createBar(0);
printData.bar = createBar(printData.progress*20);

function display() {
    console.clear();
    console.log(COLOR.cyan, banner);

    if (bot && bot.game && bot.game.gameMode === "survival") {
        console.log(COLOR.red, `Health: ${healthBar}`);
        console.log(COLOR.yellow, `Hunger: ${foodBar}`);
    }

    if (printData.isPrinting) {
        console.log(`Printed: ${printData.bar}`);
    }

    for (const entry of log) {
        if (entry.length === 2) {
            console.log(entry[0], entry[1]);
        } else {
            console.log(entry[0]);
        }
    }

    process.stdout.write(reader._prompt+reader.line);
}

setInterval(display, 100);

function getSetting(key) {
    return settings[key];
}

function setSetting(key, value) {
    settings[key] = value;
    saveSettings();
}

function saveSettings() {
    let data = JSON.stringify(settings, null, 4);
    fs.writeFileSync('settings.json', data);
}

async function drawImage(args) {
    if (!bot) {
        addLog('Join a server before drawing an image.', COLOR.yellow);
        return;
    }

    addLog('Drawing an image!', COLOR.green);

    if (!args[1]) {
        addLog('Usage: draw <image> <palette> <width>x<height>', COLOR.yellow);
        return;
    }

    let image;
    try {
        image = await loadImage(args[1]);
    } catch (error) {
        addLog(`Failed to load image: ${error.message}`, COLOR.red);
        return;
    }

    const paletteName = args[2] ?? 'concrete';
    const paletteKeys = paletteName.split('+');
    const missingPalettes = paletteKeys.filter((name) => !palettes[name]);

    if (missingPalettes.length) {
        addLog(`Unknown palette(s): ${missingPalettes.join(', ')}.`, COLOR.yellow);
        return;
    }
    const sizeArgument = args[3];
    let size = [];

    if (sizeArgument) {
        size = sizeArgument.split('x').map((value) => parseInt(value, 10)).filter((value) => !Number.isNaN(value));
    }

    if (size.length === 0) {
        size = [image.shape[0], image.shape[1]];
    }

    if (size.length === 1) {
        const scale = size[0] / image.shape[0];
        size.push(Math.round(image.shape[1] * scale));
    }

    await buildImage(
        image,
        paletteName,
        bot.entity.position.clone(),
        size,
    );
}

const commands = {};

async function runCommand(commandText) {
    if (!commandText) {
        return;
    }

    const args = commandText.trim().split(/\s+/);

    let command = commands[args[0]];

    if (command) {
        await command(args);
        return;
    }

    //addLog(`Command "${args[0]}" not found.`, COLOR.red);

    switch(args[0]) {
        case 'commands':
            if (args.length === 1) {
                addLog(`Commands are ${settings.commands? 'enabled': 'disabled'}.`);
                break;
            }
            if (args[1].toLowerCase() === "on") settings.commands = true;
            else if (args[1].toLowerCase() === "off") settings.commands = false;
            else {
                addLog("Invalid state.", COLOR.yellow);
            }
            saveSettings();
            break;
        case 'draw':
            await drawImage(args);
            break;
        case 'gif':
            addLog('Building a gif machine!', COLOR.green);

            try {
                const image = await loadImage(args[1]);
                const palette = palettes.new;
                const size = args[2]?.split('x').map((n) => parseInt(n, 10)).filter((value) => !Number.isNaN(value)) || [];

                if (size.length === 0) {
                    size.push(image.shape[1], image.shape[2]);
                }

                if (size.length === 1) {
                    const scale = size[0] / image.shape[1];
                    size.push(Math.round(image.shape[2] * scale));
                }

                for (let i = 0; i < 1; i++) {
                    await buildGif(
                        image,
                        palette,
                        bot.entity.position.clone().offset(0, i, 0),
                        size,
                        i
                    );
                }
            } catch (error) {
                addLog(`Failed to load gif source: ${error.message}`, COLOR.red);
            }
            break;
        case 'join':
            addLog("Joining server!", COLOR.green);
            if (args.length === 3) {
                joinServer(args[1], parseInt(args[2]));
            } else if (args.length === 2) {
                joinServer("localhost", parseInt(args[1]));
            }
            break;
        case 'mode':
            if (args.length === 1) {
                addLog(`Color mode is ${settings.mode}.`);
                break;
            }
            if (args[1].toLowerCase() === "rgb") settings.mode = "RGB";
            else if (args[1].toLowerCase() === "lab") settings.mode = "LAB";
            else {
                addLog("Unknown color mode.", COLOR.yellow);
            }
            saveSettings();
            break;
        case 'rejoin':
            joinServer(settings.lastJoin.server, parseInt(settings.lastJoin.port));
            break;
        case 'rot':
            addLog("Rotating!!!", COLOR.green);
            break;
        case 'sheep':
            if (!args[1]) {
                addLog('Usage: sheep <wool_block>', COLOR.yellow);
                break;
            }

            addLog('Sheeping!', COLOR.yellow);
            await actions.getWool(bot, args[1]);
            break;
        default:
            addLog(`Command "${args[0]}" not found.`, COLOR.red);
    }
}

commands.chunk = async (arguments)=>{
    if (arguments.length === 1) {
        addLog(`Chunk size is ${settings.chunkSize}.`);
        return;
    }
    const size = parseInt(arguments[1], 10);

    if (Number.isNaN(size) || size <= 0) {
        addLog('Chunk size must be a positive number.', COLOR.yellow);
        return;
    }

    settings.chunkSize = size;
    addLog(`Chunk size set to ${settings.chunkSize}.`);
    saveSettings();
};

commands.clear = async ()=>{
    log = [];
    addLog('Console cleared.', COLOR.green);
};

commands.color = async (arguments)=>{
    if (arguments.length === 1) {
        addLog(`Using the ${settings.color} color of blocks.`);
        return;
    }
    if (arguments[1].toLowerCase() === "average") settings.color = "average";
    else if (arguments[1].toLowerCase() === "dominant") settings.color = "dominant";
    else {
        addLog("Invalid source color. (source color? Idk what to call it lmao)", COLOR.yellow);
    }
    saveSettings();
};

commands.model = async (arguments)=>{
    /*if (arguments.length === 0) {
        // Open menu
    }*/

    const modelPath = arguments[1];
    const textureLocation = arguments[2];
    const modelSize = parseInt(arguments[3], 10) || 20;

    if (!modelPath || !textureLocation) {
        addLog('Usage: model <model.obj> <texture.png> [size]', COLOR.yellow);
        return;
    }

    addLog('Building model....', COLOR.green);

    try {
        await buildModel(bot, {
            path: modelPath,
            textureLocation: textureLocation,
            position: bot.entity.position,
            size: modelSize,
        });

        addLog('Model has been built.', COLOR.green);
    } catch (error) {
        addLog(`Model build failed: ${error.message}`, COLOR.red);
    }
}

function inputLoop(command) {
    if (command) runCommand(command);
    reader.question(">", inputLoop);
}

inputLoop();

function joinServer(server="localhost", portNumber) {
    addLog(`Creating bot on "${server}" at ${portNumber}.`);

    settings.lastJoin = {
        server: server,
        port: portNumber,
    };

    saveSettings();

    bot = mineflayer.createBot({
        host: server,
        username: 'PrinterBot',
        port: portNumber,
    });

    bot.on('kicked', (reason)=>{
        addLog(reason, COLOR.red);
    });

    bot.on('error', (error)=>{
        addLog(error, COLOR.yellow);
    });

    bot.on('health', ()=>{
        healthBar = createBar(bot.health);
        foodBar = createBar(bot.food);
    });

    bot.task = [];

    bot.once('spawn', ()=>{
        actions.init(bot);

        bot.settings = settings;

        bot.loadPlugin(mcColor);
        bot.palettes = palettes;

        addLog('Joined server.', COLOR.green);
        bot.chat("I'm a happy little robot.");
    });

    bot.on('chat', (username, message)=>{
        if (!settings.bosses.includes(username)) return;
        runCommand(message);
    });
}

async function loadImage(path) {
    return new Promise((resolve, reject)=>{
        getPixels(path, (err, image)=>{
            if (err) {
                reject(err);
                return;
            }

            resolve(image);
        });
    });
}

function getBlock(image, x, z, palette=palettes.concrete, gif=false, t=1) {
    let r, g, b, alpha;

    if (!gif) {
        x = Math.floor(image.shape[0]*x);
        z = Math.floor(image.shape[1]*z);

        r = image.get(x, z, 0);
        g = image.get(x, z, 1);
        b = image.get(x, z, 2);
        alpha = image.shape[2] > 3 ? image.get(x, z, 3) : 255;
    } else {
        x = Math.floor(image.shape[1]*x);
        z = Math.floor(image.shape[2]*z);

        r = image.get(t, x, z, 0);
        g = image.get(t, x, z, 1);
        b = image.get(t, x, z, 2);
        alpha = 255;
    }

    let block = bot.colors.getBlock([r, g, b, alpha], palette);
    return block;
}

async function buildImage(texture, palette, startPosition=bot.entity.position.clone(), size=[64, 64]) {
    bot.task.push("draw");
    startPosition = startPosition.offset(1, 0, 1);

    printData.isPrinting = true;

    let zD = 1;
    let z = 0;

    for (let x = 0; x < size[0]; x += settings.chunkSize) {
        while (z < size[1] && z > -1) {
            printData.progress = x/size[0];
            printData.bar = createBar(printData.progress*20);

            for (let xx = 0; xx < settings.chunkSize && x+xx < size[0]; xx++) {
                const k = x+xx;

                const block = getBlock(texture, k/size[0], z/size[1], palette);
                const targetPosition = startPosition.offset(k, 0, z);

                if (settings.commands) {
                    const pos = targetPosition.floor();
                    bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} ${block}`);
                } else if (block && block !== 'air' && block !== 'cave_air' && block !== 'void_air') {
                    await actions.placeBlock(bot, targetPosition, block);
                } else {
                    await actions.clearBlock(bot, targetPosition);
                }
            }
            await bot.waitForTicks(1);
            z += zD;
        }
        //await actions.sleep(500);
        zD = -zD;
        z += zD;
    }

    printData.isPrinting = false;
    bot.task.pop();
}

async function buildGif(texture, palette, startPosition=bot.entity.position.clone(), size=[64, 64], frame=0) {
    bot.task.push("gif");
    startPosition = startPosition.offset(1, 0, 1);

    printData.isPrinting = true;

    let zD = 1;
    let z = 0;

    for (let x = 0; x < size[0]; x += settings.chunkSize) {
        while (z < size[1] && z > -1) {
            printData.progress = x/size[0];
            printData.bar = createBar(printData.progress*20);

            for (let xx = 0; xx < settings.chunkSize && x+xx < size[0]; xx++) {
                const k = x+xx;

                const block = getBlock(texture, k/size[0], z/size[1], palette, gif=true, frame);
                const targetPosition = startPosition.offset(k, 0, z);

                if (settings.commands) {
                    const pos = targetPosition.floor();
                    bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} ${block}`);
                } else if (block && block !== 'air' && block !== 'cave_air' && block !== 'void_air') {
                    await actions.placeBlock(bot, targetPosition, block);
                } else {
                    await actions.clearBlock(bot, targetPosition);
                }
            }
            await bot.waitForTicks(1);
            z += zD;
        }
        //await actions.sleep(500);
        zD = -zD;
        z += zD;
    }

    printData.isPrinting = false;
    bot.task.pop();
}

