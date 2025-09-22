const path = require('path');
const fs = require('fs');
const readline = require('readline');
const getPixels = require('get-pixels');
const vec3 = require('vec3');
const mineflayer = require('mineflayer');

const actions = require('./actions.js');
const mcColor = require('./mc-colors.js');
const { buildModel } = require('./model-builder.js');
const { CommandManager } = require('./command-manager.js');

const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const palettes = JSON.parse(fs.readFileSync('palettes.json', 'utf8'));
const fsp = fs.promises;

const COLOR = {
    cyan: '\x1b[36m%s\x1b[0m',
    purple: '\x1b[35m%s\x1b[0m',
    blue: '\x1b[34m%s\x1b[0m',
    yellow: '\x1b[33m%s\x1b[0m',
    green: '\x1b[32m%s\x1b[0m',
    red: '\x1b[31m%s\x1b[0m',
};

const banner = `
    ███    ███  ██████       ██████  ██████  ██ ███    ██ ████████ ███████ ██████
    ████  ████ ██            ██   ██ ██   ██ ██ ████   ██    ██    ██      ██   ██
    ██ ████ ██ ██      █████ ██████  ██████  ██ ██ ██  ██    ██    █████   ██████
    ██  ██  ██ ██            ██      ██   ██ ██ ██  ██ ██    ██    ██      ██   ██
    ██      ██  ██████       ██      ██   ██ ██ ██   ████    ██    ███████ ██   ██
`;

const MAX_LOG_ENTRIES = 200;
const PROGRESS_SEGMENTS = 20;

let bot;

const printData = {
    isPrinting: false,
    progress: 0,
    bar: createBar(0),
    currentTask: null,
    cancelRequested: false,
    placedBlocks: 0,
    totalBlocks: 0,
    metadata: undefined,
};

const reader = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});
reader.setPrompt('> ');

const log = [];

const commandManager = new CommandManager({
    onUnknown: (name) => {
        addLog(`Command "${name}" not found. Type "help" to list available commands.`, COLOR.red);
    },
    onError: (error, parsed) => {
        const commandLabel = parsed?.name ? `"${parsed.name}"` : 'input';
        addLog(`Command ${commandLabel} failed: ${error.message}`, COLOR.red);
        console.error(error);
    },
});

function formatTimestamp() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function addLog(text, color = '') {
    const message = `[${formatTimestamp()}] ${text}`;
    log.push([color, message]);
    if (log.length > MAX_LOG_ENTRIES) {
        log.shift();
    }
}

function createBar(progressSegments) {
    const filled = Math.max(0, Math.min(PROGRESS_SEGMENTS, Math.round(progressSegments)));
    return `${'■'.repeat(filled)}${'□'.repeat(PROGRESS_SEGMENTS - filled)}`;
}

function updateProgressBar(progress) {
    const clamped = Math.max(0, Math.min(1, progress));
    printData.progress = clamped;
    printData.bar = createBar(clamped * PROGRESS_SEGMENTS);
}

function updatePrintProgress(completed, total) {
    printData.placedBlocks = completed;
    printData.totalBlocks = total;
    const progress = total > 0 ? completed / total : 0;
    updateProgressBar(progress);
}

function startPrintTask(name, totalBlocks, metadata = {}) {
    printData.isPrinting = true;
    printData.currentTask = name;
    printData.cancelRequested = false;
    printData.metadata = metadata;
    updatePrintProgress(0, totalBlocks);
}

function finishPrintTask({ cancelled } = {}) {
    if (!cancelled && printData.totalBlocks > 0) {
        updatePrintProgress(printData.totalBlocks, printData.totalBlocks);
    } else {
        updateProgressBar(0);
    }

    printData.isPrinting = false;
    printData.currentTask = null;
    printData.cancelRequested = false;
    printData.metadata = undefined;
    printData.placedBlocks = 0;
    printData.totalBlocks = 0;
}

function pushTask(taskName) {
    if (!bot) return () => {};
    if (!Array.isArray(bot.task)) bot.task = [];
    bot.task.push(taskName);
    return () => {
        if (!bot?.task) return;
        const index = bot.task.lastIndexOf(taskName);
        if (index !== -1) {
            bot.task.splice(index, 1);
        }
    };
}

function ensureBotSpawned() {
    if (!bot || !bot.entity || !bot.entity.position) {
        throw new Error('Bot is not connected. Use "join" to connect to a server.');
    }
    return bot;
}

function parsePositiveInteger(value, label) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return numeric;
}

function parseSizeArgument(sizeArg, dimensions) {
    if (sizeArg === undefined || sizeArg === null || sizeArg === '') {
        return [dimensions.width, dimensions.height];
    }

    const text = String(sizeArg).toLowerCase().replace(/\s+/g, '');
    const match = text.match(/^(\d+)(?:x(\d+))?$/);

    if (!match) {
        throw new Error('Size must be provided as <width> or <width>x<height>.');
    }

    const width = parseInt(match[1], 10);
    if (width <= 0) {
        throw new Error('Width must be greater than zero.');
    }

    if (match[2]) {
        const height = parseInt(match[2], 10);
        if (height <= 0) {
            throw new Error('Height must be greater than zero.');
        }
        return [width, height];
    }

    const scale = width / dimensions.width;
    const inferredHeight = Math.max(1, Math.round(dimensions.height * scale));
    return [width, inferredHeight];
}

function getImageDimensions(image) {
    const shape = image.shape;

    if (shape.length === 3) {
        return { width: shape[0], height: shape[1], frames: 1 };
    }

    if (shape.length === 4) {
        return { width: shape[1], height: shape[2], frames: shape[0] };
    }

    throw new Error('Unsupported image format.');
}

function isRemoteResource(resource) {
    return /^https?:\/\//i.test(resource);
}

async function loadImage(resource) {
    const isRemote = isRemoteResource(resource);
    const resolved = isRemote ? resource : path.resolve(resource);

    if (!isRemote) {
        try {
            await fsp.access(resolved, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Unable to access image "${resource}": ${error.message}`);
        }
    }

    return new Promise((resolve, reject) => {
        getPixels(resolved, (err, image) => {
            if (err || !image) {
                reject(new Error(`Unable to load image "${resource}": ${err?.message || 'Unknown error'}`));
                return;
            }
            resolve(image);
        });
    });
}

function resolvePaletteArgument(paletteArg) {
    if (paletteArg === undefined || paletteArg === null || paletteArg === '') {
        throw new Error('Palette is required. Use "palettes" to list options.');
    }

    const text = String(paletteArg).trim();
    if (!text) {
        throw new Error('Palette is required. Use "palettes" to list options.');
    }

    const parts = text.split('+');
    const missing = parts.filter((part) => !palettes[part]);
    if (missing.length) {
        throw new Error(`Unknown palette(s): ${missing.join(', ')}.`);
    }

    return text;
}

function describeResource(resource) {
    try {
        const url = new URL(resource);
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length) return segments[segments.length - 1];
        return url.hostname;
    } catch {
        return path.basename(resource);
    }
}

function parseVectorFlag(value, { baseVector, allowRelative = false } = {}) {
    if (value === undefined || value === null) return null;
    if (value === true) {
        throw new Error('Vector flags require a value in the form x y z or x,y,z.');
    }

    const tokens = String(value)
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter(Boolean);

    if (tokens.length !== 3) {
        throw new Error('Vector flags require three coordinates (x y z).');
    }

    const base = baseVector || new vec3(0, 0, 0);

    const coordinates = tokens.map((token, index) => {
        if (allowRelative && token.startsWith('~')) {
            const offsetText = token.slice(1);
            const baseValue = index === 0 ? base.x : index === 1 ? base.y : base.z;

            if (offsetText === '') {
                return baseValue;
            }

            const offset = Number(offsetText);
            if (!Number.isFinite(offset)) {
                throw new Error(`Invalid relative coordinate "${token}".`);
            }
            return baseValue + offset;
        }

        const absolute = Number(token);
        if (!Number.isFinite(absolute)) {
            throw new Error(`Invalid coordinate "${token}".`);
        }
        return absolute;
    });

    return new vec3(coordinates[0], coordinates[1], coordinates[2]);
}

function determineBasePosition(flags = {}, botInstance = bot) {
    const activeBot = botInstance ?? ensureBotSpawned();
    let basePosition = activeBot.entity.position.clone();

    if (flags.origin !== undefined) {
        basePosition = parseVectorFlag(flags.origin, {
            allowRelative: true,
            baseVector: activeBot.entity.position,
        });
    }

    if (flags.offset !== undefined) {
        const offset = parseVectorFlag(flags.offset, { allowRelative: false });
        basePosition = basePosition.offset(offset.x, offset.y, offset.z);
    }

    return basePosition;
}

function describeBoolean(value) {
    return value ? 'enabled' : 'disabled';
}

function formatPercentage(value) {
    return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
}

function createCommandContext() {
    return { bot, settings, palettes, printData };
}

async function runCommand(commandText) {
    if (!commandText || !commandText.trim()) return;
    await commandManager.execute(commandText, createCommandContext());
}

reader.on('line', async (input) => {
    await runCommand(input);
    reader.prompt();
});
reader.prompt();

function display() {
    console.clear();
    console.log(COLOR.cyan, banner);

    if (bot && bot.game && bot.game.gameMode === 'survival') {
        console.log(COLOR.red, `Health: ${healthBar}`);
        console.log(COLOR.yellow, `Hunger: ${foodBar}`);
    }

    if (bot?.task?.length) {
        console.log(COLOR.purple, `Tasks: ${bot.task.join(', ')}`);
    }

    if (printData.isPrinting) {
        const percent = formatPercentage(printData.progress);
        let details = `Progress: ${printData.bar} ${percent}`;
        if (printData.totalBlocks) {
            details += ` (${printData.placedBlocks}/${printData.totalBlocks})`;
        }
        console.log(details);

        if (printData.currentTask) {
            console.log(`Task: ${printData.currentTask}`);
        }
        if (printData.metadata?.frameCount) {
            console.log(`Frame: ${printData.metadata.frame}/${printData.metadata.frameCount}`);
        }
        if (printData.cancelRequested) {
            console.log(COLOR.yellow, 'Cancellation requested…');
        }
    }

    for (const entry of log) {
        const [color, message] = entry;
        if (color) console.log(color, message);
        else console.log(message);
    }

    process.stdout.write((reader._prompt || '') + (reader.line || ''));
}

setInterval(display, 100);

let healthBar = createBar(0);
let foodBar = createBar(0);

function getSetting(key) {
    return settings[key];
}

function setSetting(key, value) {
    settings[key] = value;
    saveSettings();
}

function saveSettings() {
    const data = JSON.stringify(settings, null, 4);
    fs.writeFileSync('settings.json', data);
}

function registerCommands() {
    commandManager.register({
        name: 'help',
        aliases: ['?'],
        description: 'List available commands or get details for a specific command.',
        usage: 'help [command]',
        handler: ({ args, manager }) => {
            if (!args.length) {
                const commands = manager.listCommands();
                if (!commands.length) {
                    addLog('No commands have been registered yet.', COLOR.yellow);
                    return;
                }
                addLog(`Available commands (${commands.length}): ${commands.map((cmd) => cmd.name).join(', ')}`);
                addLog('Type "help <command>" for detailed information.');
                return;
            }

            const query = String(args[0]).toLowerCase();
            const command = manager.find(query);
            if (!command) {
                addLog(`Command "${query}" not found.`, COLOR.yellow);
                return;
            }

            if (command.description) {
                addLog(`${command.name}: ${command.description}`);
            } else {
                addLog(`${command.name}: No description available.`);
            }
            if (command.aliases?.length) {
                addLog(`Aliases: ${command.aliases.join(', ')}`);
            }
            if (command.usage) {
                addLog(`Usage: ${command.usage}`);
            }
        },
    });

    commandManager.register({
        name: 'clear',
        description: 'Clear the console log.',
        usage: 'clear',
        handler: () => {
            log.length = 0;
            addLog('Console cleared.', COLOR.green);
        },
    });

    commandManager.register({
        name: 'palettes',
        description: 'List available colour palettes.',
        usage: 'palettes',
        handler: () => {
            const names = Object.keys(palettes).sort();
            if (!names.length) {
                addLog('No palettes have been defined.', COLOR.yellow);
                return;
            }

            let line = `Palettes (${names.length}): `;
            for (const name of names) {
                if ((line + name).length > 90) {
                    addLog(line.trim());
                    line = '  ';
                }
                line += `${name}, `;
            }
            if (line.trim()) {
                addLog(line.replace(/,\s*$/, ''));
            }
        },
    });

    commandManager.register({
        name: 'chunk',
        description: 'Get or set the number of blocks processed per tick.',
        usage: 'chunk [size]',
        handler: ({ args }) => {
            if (!args.length) {
                addLog(`Chunk size is ${settings.chunkSize}.`);
                return;
            }

            const value = parsePositiveInteger(args[0], 'Chunk size');
            setSetting('chunkSize', value);
            addLog(`Chunk size set to ${value}.`, COLOR.green);
        },
    });

    commandManager.register({
        name: 'color',
        description: 'Choose whether to use average or dominant block colours.',
        usage: 'color [average|dominant]',
        handler: ({ args }) => {
            if (!args.length) {
                addLog(`Using the ${settings.color} colour of blocks.`);
                return;
            }

            const choice = String(args[0]).toLowerCase();
            if (!['average', 'dominant'].includes(choice)) {
                throw new Error('Colour source must be "average" or "dominant".');
            }

            setSetting('color', choice);
            addLog(`Now using the ${choice} colour of blocks.`, COLOR.green);
        },
    });

    commandManager.register({
        name: 'commands',
        description: 'Toggle using /setblock commands instead of manual placement.',
        usage: 'commands [on|off]',
        handler: ({ args }) => {
            if (!args.length) {
                addLog(`Command placement is ${describeBoolean(settings.commands)}.`);
                return;
            }

            const state = String(args[0]).toLowerCase();
            if (state === 'on') {
                setSetting('commands', true);
                addLog('Command placement enabled.', COLOR.green);
            } else if (state === 'off') {
                setSetting('commands', false);
                addLog('Command placement disabled.', COLOR.green);
            } else {
                throw new Error('Use "on" or "off" to control command placement.');
            }
        },
    });

    commandManager.register({
        name: 'mode',
        description: 'Switch colour distance calculation mode.',
        usage: 'mode [rgb|lab]',
        handler: ({ args }) => {
            if (!args.length) {
                addLog(`Colour mode is ${settings.mode}.`);
                return;
            }

            const choice = String(args[0]).toUpperCase();
            if (!['RGB', 'LAB'].includes(choice)) {
                throw new Error('Colour mode must be RGB or LAB.');
            }

            setSetting('mode', choice);
            addLog(`Colour mode set to ${choice}.`, COLOR.green);
        },
    });

    commandManager.register({
        name: 'settings',
        description: 'Inspect or update persisted settings.',
        usage: 'settings [key] [value]',
        handler: ({ args }) => {
            if (!args.length) {
                for (const [key, value] of Object.entries(settings)) {
                    addLog(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
                }
                return;
            }

            const key = String(args[0]);
            if (!(key in settings)) {
                throw new Error(`Unknown setting "${key}".`);
            }

            if (args.length === 1) {
                const value = settings[key];
                addLog(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
                return;
            }

            const rawValue = args.slice(1).join(' ');

            switch (key) {
                case 'chunkSize':
                    setSetting(key, parsePositiveInteger(rawValue, 'Chunk size'));
                    break;
                case 'commands':
                    if (['true', 'on', '1'].includes(rawValue.toLowerCase())) {
                        setSetting(key, true);
                    } else if (['false', 'off', '0'].includes(rawValue.toLowerCase())) {
                        setSetting(key, false);
                    } else {
                        throw new Error('Commands must be set to on/off or true/false.');
                    }
                    break;
                case 'mode':
                    {
                        const value = rawValue.toUpperCase();
                        if (!['RGB', 'LAB'].includes(value)) {
                            throw new Error('Mode must be RGB or LAB.');
                        }
                        setSetting(key, value);
                    }
                    break;
                case 'color':
                    {
                        const value = rawValue.toLowerCase();
                        if (!['average', 'dominant'].includes(value)) {
                            throw new Error('Colour must be average or dominant.');
                        }
                        setSetting(key, value);
                    }
                    break;
                default:
                    throw new Error(`Setting "${key}" cannot be modified via this command.`);
            }

            addLog(`Setting "${key}" updated.`, COLOR.green);
        },
    });

    commandManager.register({
        name: 'status',
        description: 'Display bot and printer status information.',
        usage: 'status',
        handler: () => {
            if (bot) {
                const position = bot.entity?.position;
                const location = position
                    ? `${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`
                    : 'Unknown';
                addLog(`Bot: connected as ${bot.username || 'PrinterBot'} at ${location}.`, COLOR.blue);
                if (bot.task?.length) {
                    addLog(`Active tasks: ${bot.task.join(', ')}`);
                } else {
                    addLog('Active tasks: none.');
                }
            } else {
                addLog('Bot is not connected.', COLOR.yellow);
            }

            if (printData.isPrinting) {
                const percent = formatPercentage(printData.progress);
                let summary = `Current job: ${printData.currentTask || 'Unknown'} (${percent}`;
                if (printData.totalBlocks) {
                    summary += `, ${printData.placedBlocks}/${printData.totalBlocks} blocks`;
                }
                summary += ')';
                addLog(summary);

                if (printData.metadata?.frameCount) {
                    addLog(`Frame ${printData.metadata.frame} of ${printData.metadata.frameCount}`);
                }
                if (printData.cancelRequested) {
                    addLog('Cancellation has been requested.', COLOR.yellow);
                }
            } else {
                addLog('Printer is idle.');
            }
        },
    });

    commandManager.register({
        name: 'stop',
        description: 'Request cancellation of the active build.',
        usage: 'stop',
        handler: () => {
            if (!printData.isPrinting) {
                addLog('No active build to cancel.', COLOR.yellow);
                return;
            }
            if (printData.cancelRequested) {
                addLog('Cancellation already requested.', COLOR.yellow);
                return;
            }
            printData.cancelRequested = true;
            addLog('Cancellation requested. The bot will stop after the current chunk.', COLOR.yellow);
        },
    });

    commandManager.register({
        name: 'join',
        description: 'Connect the bot to a Minecraft server.',
        usage: 'join [host] [port] [--username name] [--version version]',
        handler: ({ args, flags }) => {
            let host;
            let port;

            if (!args.length) {
                if (settings.lastJoin?.server) {
                    host = settings.lastJoin.server;
                    port = settings.lastJoin.port;
                } else {
                    throw new Error('No previous server stored. Provide a host and port.');
                }
            } else if (args.length === 1) {
                if (/^\d+$/.test(String(args[0]))) {
                    host = 'localhost';
                    port = args[0];
                } else {
                    host = args[0];
                    port = settings.lastJoin?.port ?? 25565;
                }
            } else {
                host = args[0];
                port = args[1];
            }

            const portNumber = parsePositiveInteger(port, 'Port');
            const username = flags.username || settings.lastJoin?.username || 'PrinterBot';
            const version = flags.version || undefined;
            const password = flags.password || undefined;
            const auth = flags.auth || undefined;

            joinServer(host, portNumber, { username, version, password, auth });
        },
    });

    commandManager.register({
        name: 'rejoin',
        description: 'Reconnect to the last server.',
        usage: 'rejoin',
        handler: () => {
            const lastJoin = settings.lastJoin;
            if (!lastJoin?.server || !lastJoin?.port) {
                throw new Error('No previous server stored.');
            }
            joinServer(lastJoin.server, lastJoin.port, {
                username: lastJoin.username || 'PrinterBot',
            });
        },
    });

    commandManager.register({
        name: 'draw',
        description: 'Build an image using the specified palette.',
        usage: 'draw <image> <palette> <width>x<height> [--size WxH] [--origin x,y,z] [--offset x,y,z] [--no-offset]',
        handler: async ({ args, flags }) => {
            const botInstance = ensureBotSpawned();

            if (args.length < 1) {
                throw new Error('Image path is required.');
            }

            const imagePath = args[0];
            const paletteInput = resolvePaletteArgument(flags.palette ?? args[1]);
            const sizeInput = flags.size ?? args[2];
            const applyDefaultOffset = !flags.noOffset;
            const basePosition = determineBasePosition(flags, botInstance);

            const texture = await loadImage(imagePath);
            const dimensions = getImageDimensions(texture);

            if (dimensions.frames > 1) {
                throw new Error('Animated images detected. Use the "gif" command.');
            }

            const size = parseSizeArgument(sizeInput, dimensions);
            const resourceName = describeResource(imagePath);

            addLog(`Drawing ${resourceName} (${size[0]}x${size[1]}) using palette ${paletteInput}.`, COLOR.green);

            const result = await buildImage(texture, paletteInput, basePosition, size, {
                applyDefaultOffset,
            });

            if (result.cancelled) {
                addLog(`Image build for ${resourceName} cancelled.`, COLOR.yellow);
            } else {
                addLog(`Image build for ${resourceName} completed.`, COLOR.green);
            }
        },
    });

    commandManager.register({
        name: 'gif',
        description: 'Build frames of a GIF vertically.',
        usage: 'gif <image> [palette] [size] [--frames n] [--frame index] [--spacing n] [--origin x,y,z] [--offset x,y,z] [--no-offset]',
        handler: async ({ args, flags }) => {
            const botInstance = ensureBotSpawned();

            if (args.length < 1) {
                throw new Error('GIF path is required.');
            }

            const imagePath = args[0];
            const paletteInput = resolvePaletteArgument(flags.palette ?? args[1] ?? 'new');
            const sizeInput = flags.size ?? args[2];
            const applyDefaultOffset = !flags.noOffset;
            const basePosition = determineBasePosition(flags, botInstance);

            const texture = await loadImage(imagePath);
            const dimensions = getImageDimensions(texture);

            if (dimensions.frames <= 1) {
                throw new Error('No animation frames detected. Use the "draw" command for static images.');
            }

            const size = parseSizeArgument(sizeInput, dimensions);
            const resourceName = describeResource(imagePath);

            let frameIndices = [...Array(dimensions.frames).keys()];

            if (flags.frame !== undefined) {
                if (flags.frame === true) {
                    throw new Error('Frame flag requires a numeric value.');
                }
                const frameIndex = parsePositiveInteger(flags.frame, 'Frame') - 1;
                if (frameIndex < 0 || frameIndex >= dimensions.frames) {
                    throw new Error(`Frame must be between 1 and ${dimensions.frames}.`);
                }
                frameIndices = [frameIndex];
            } else if (flags.frames !== undefined) {
                if (flags.frames === true) {
                    throw new Error('Frames flag requires a numeric value.');
                }
                const frameCount = parsePositiveInteger(flags.frames, 'Frames');
                frameIndices = frameIndices.slice(0, frameCount);
            }

            let spacing = 1;
            if (flags.spacing !== undefined) {
                if (flags.spacing === true) {
                    throw new Error('Spacing flag requires a numeric value.');
                }
                spacing = parsePositiveInteger(flags.spacing, 'Spacing');
            }

            addLog(`Building ${frameIndices.length} frame(s) from ${resourceName} using palette ${paletteInput}.`, COLOR.green);

            for (let i = 0; i < frameIndices.length; i++) {
                const frameIndex = frameIndices[i];
                const framePosition = basePosition.offset(0, i * spacing, 0);

                const result = await buildGif(texture, paletteInput, framePosition, size, frameIndex, {
                    applyDefaultOffset,
                    frame: frameIndex + 1,
                    frameCount: dimensions.frames,
                });

                if (result.cancelled) {
                    addLog(`Frame ${frameIndex + 1} cancelled.`, COLOR.yellow);
                    return;
                }
            }

            addLog(`GIF build for ${resourceName} completed.`, COLOR.green);
        },
    });

    commandManager.register({
        name: 'model',
        description: 'Build a textured OBJ model at the bot\'s position.',
        usage: 'model <modelPath> <texturePath> [size] [--type points] [--origin x,y,z] [--offset x,y,z]',
        handler: async ({ args, flags }) => {
            const botInstance = ensureBotSpawned();

            if (args.length < 2) {
                throw new Error('Model path and texture path are required.');
            }

            const modelPath = args[0];
            const texturePath = args[1];
            const sizeInput = flags.size ?? args[2];
            const size = sizeInput ? parsePositiveInteger(sizeInput, 'Model size') : 20;
            const buildType = flags.type || (flags.points ? 'points' : undefined);
            const basePosition = determineBasePosition(flags, botInstance);

            addLog(`Building model ${modelPath} at size ${size}.`, COLOR.green);

            await buildModel(botInstance, {
                path: modelPath,
                textureLocation: texturePath,
                position: basePosition,
                size,
            }, buildType);

            addLog('Model build completed.', COLOR.green);
        },
    });

    commandManager.register({
        name: 'sheep',
        description: 'Collect wool of the specified colour.',
        usage: 'sheep <colour_wool>',
        handler: async ({ args }) => {
            if (!args.length) {
                throw new Error('Specify the wool colour, e.g., sheep red_wool.');
            }
            const botInstance = ensureBotSpawned();
            await actions.getWool(botInstance, args[0]);
        },
    });

    commandManager.register({
        name: 'rot',
        description: 'Placeholder rotation command.',
        usage: 'rot',
        handler: () => {
            addLog('Rotation command not yet implemented.', COLOR.yellow);
        },
    });
}

registerCommands();

function joinServer(host = 'localhost', portNumber, options = {}) {
    if (!portNumber) {
        throw new Error('Port number is required to join a server.');
    }

    if (bot) {
        addLog('Closing existing bot connection.', COLOR.yellow);
        try {
            bot.quit('Reconnecting');
        } catch (error) {
            console.error('Failed to quit existing bot cleanly.', error);
        }
    }

    addLog(`Creating bot on "${host}" at ${portNumber}.`, COLOR.green);

    settings.lastJoin = {
        server: host,
        port: portNumber,
        username: options.username || 'PrinterBot',
    };
    saveSettings();

    bot = mineflayer.createBot({
        host,
        port: portNumber,
        username: options.username || 'PrinterBot',
        version: options.version,
        password: options.password,
        auth: options.auth,
    });

    bot.on('kicked', (reason) => {
        addLog(`Kicked: ${reason}`, COLOR.red);
    });

    bot.on('error', (error) => {
        addLog(`Error: ${error.message || error}`, COLOR.yellow);
    });

    bot.on('end', () => {
        addLog('Bot disconnected from server.', COLOR.yellow);
    });

    bot.on('health', () => {
        healthBar = createBar(bot.health);
        foodBar = createBar(bot.food);
    });

    bot.once('spawn', () => {
        actions.init(bot);
        bot.settings = settings;
        bot.loadPlugin(mcColor);
        bot.palettes = palettes;
        bot.task = [];

        addLog(`Joined server ${host}:${portNumber} as ${bot.username}.`, COLOR.green);
        try {
            bot.chat("I'm a happy little robot.");
        } catch (error) {
            console.error('Failed to send chat message:', error);
        }
    });

    bot.on('chat', (username, message) => {
        if (!settings.bosses.includes(username)) return;
        runCommand(message);
    });
}

async function loadImageData(path) {
    return loadImage(path);
}

function getBlock(image, x, z, palette = palettes.concrete, gif = false, t = 1) {
    let r;
    let g;
    let b;
    let alpha;

    if (!gif) {
        const px = Math.floor(image.shape[0] * x);
        const pz = Math.floor(image.shape[1] * z);

        r = image.get(px, pz, 0);
        g = image.get(px, pz, 1);
        b = image.get(px, pz, 2);
        alpha = image.get(px, pz, 3) ?? image.get(px, pz, 2);
    } else {
        const px = Math.floor(image.shape[1] * x);
        const pz = Math.floor(image.shape[2] * z);

        r = image.get(t, px, pz, 0);
        g = image.get(t, px, pz, 1);
        b = image.get(t, px, pz, 2);
        alpha = image.get(t, px, pz, 3) ?? 255;
    }

    const block = bot.colors.getBlock([r, g, b, alpha], palette);
    return block;
}

async function buildImage(texture, palette, startPosition = bot.entity.position.clone(), size = [64, 64], options = {}) {
    const botInstance = ensureBotSpawned();
    const removeTask = pushTask('draw');

    const applyDefaultOffset = options.applyDefaultOffset !== false;
    let targetStart = startPosition.clone();
    if (applyDefaultOffset) {
        targetStart = targetStart.offset(1, 0, 1);
    }

    const totalBlocks = size[0] * size[1];
    startPrintTask('Image build', totalBlocks);

    let cancelled = false;

    try {
        let zDirection = 1;
        let z = 0;

        for (let x = 0; x < size[0] && !cancelled; x += settings.chunkSize) {
            while (z >= 0 && z < size[1] && !cancelled) {
                for (let xx = 0; xx < settings.chunkSize && x + xx < size[0]; xx++) {
                    if (printData.cancelRequested) {
                        cancelled = true;
                        break;
                    }

                    const k = x + xx;
                    const block = getBlock(texture, k / size[0], z / size[1], palette);
                    const position = targetStart.offset(k, 0, z).floor();

                    if (settings.commands) {
                        botInstance.chat(`/setblock ${position.x} ${position.y} ${position.z} ${block}`);
                    } else {
                        if (block) await actions.placeBlock(botInstance, position, block);
                        else await actions.clearBlock(botInstance, position);
                    }

                    updatePrintProgress(printData.placedBlocks + 1, totalBlocks);
                }

                if (cancelled) break;

                await botInstance.waitForTicks(1);
                z += zDirection;
            }

            zDirection = -zDirection;
            z += zDirection;
        }
    } finally {
        finishPrintTask({ cancelled });
        removeTask();
    }

    return { cancelled };
}

async function buildGif(texture, palette, startPosition = bot.entity.position.clone(), size = [64, 64], frame = 0, options = {}) {
    const botInstance = ensureBotSpawned();
    const removeTask = pushTask('gif');

    const applyDefaultOffset = options.applyDefaultOffset !== false;
    let targetStart = startPosition.clone();
    if (applyDefaultOffset) {
        targetStart = targetStart.offset(1, 0, 1);
    }

    const totalBlocks = size[0] * size[1];
    startPrintTask(`GIF frame ${frame + 1}`, totalBlocks, {
        frame: options.frame || frame + 1,
        frameCount: options.frameCount || texture.shape[0] || 1,
    });

    let cancelled = false;

    try {
        let zDirection = 1;
        let z = 0;

        for (let x = 0; x < size[0] && !cancelled; x += settings.chunkSize) {
            while (z >= 0 && z < size[1] && !cancelled) {
                for (let xx = 0; xx < settings.chunkSize && x + xx < size[0]; xx++) {
                    if (printData.cancelRequested) {
                        cancelled = true;
                        break;
                    }

                    const k = x + xx;
                    const block = getBlock(texture, k / size[0], z / size[1], palette, true, frame);
                    const position = targetStart.offset(k, 0, z).floor();

                    if (settings.commands) {
                        botInstance.chat(`/setblock ${position.x} ${position.y} ${position.z} ${block}`);
                    } else {
                        if (block) await actions.placeBlock(botInstance, position, block);
                        else await actions.clearBlock(botInstance, position);
                    }

                    updatePrintProgress(printData.placedBlocks + 1, totalBlocks);
                }

                if (cancelled) break;

                await botInstance.waitForTicks(1);
                z += zDirection;
            }

            zDirection = -zDirection;
            z += zDirection;
        }
    } finally {
        finishPrintTask({ cancelled });
        removeTask();
    }

    return { cancelled };
}

addLog('Welcome to the Himalayas!');

module.exports = {
    loadImage: loadImageData,
    buildImage,
    buildGif,
    getBlock,
};

