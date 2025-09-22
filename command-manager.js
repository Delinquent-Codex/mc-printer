const DEFAULT_HISTORY_LIMIT = 100;

function normalizeFlagName(name) {
    return name
        .trim()
        .replace(/^[-\s]+/, '')
        .toLowerCase()
        .replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function normalizeFlagValue(value) {
    if (Array.isArray(value)) return value.map(normalizeFlagValue);
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();

    if (trimmed === '') return '';

    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (trimmed === 'undefined') return undefined;

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        if (!Number.isNaN(numeric)) {
            return numeric;
        }
    }

    return trimmed;
}

class CommandManager {
    constructor({ onUnknown, onError, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
        this.commands = new Map();
        this.aliasToName = new Map();
        this.history = [];
        this.historyLimit = historyLimit;
        this.onUnknown = typeof onUnknown === 'function' ? onUnknown : null;
        this.onError = typeof onError === 'function' ? onError : null;
    }

    register(definition) {
        if (!definition || typeof definition !== 'object') {
            throw new Error('Cannot register command without a definition object.');
        }

        const name = definition.name?.toLowerCase();
        if (!name) {
            throw new Error('Command definition must include a name.');
        }

        if (this.commands.has(name)) {
            throw new Error(`Command "${name}" is already registered.`);
        }

        const aliases = Array.isArray(definition.aliases)
            ? definition.aliases.map((alias) => alias.toLowerCase())
            : [];

        for (const alias of aliases) {
            if (this.aliasToName.has(alias)) {
                throw new Error(`Alias "${alias}" is already registered.`);
            }
        }

        if (typeof definition.handler !== 'function') {
            throw new Error(`Command "${name}" is missing a handler.`);
        }

        const command = {
            name,
            handler: definition.handler,
            usage: definition.usage || '',
            description: definition.description || '',
            aliases,
            hidden: Boolean(definition.hidden),
        };

        this.commands.set(name, command);

        for (const alias of aliases) {
            this.aliasToName.set(alias, name);
        }

        return command;
    }

    find(name) {
        if (!name) return undefined;

        const lowered = name.toLowerCase();

        if (this.commands.has(lowered)) {
            return this.commands.get(lowered);
        }

        const resolved = this.aliasToName.get(lowered);
        if (resolved) {
            return this.commands.get(resolved);
        }

        return undefined;
    }

    listCommands({ includeHidden = false } = {}) {
        return Array.from(this.commands.values())
            .filter((command) => includeHidden || !command.hidden)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async execute(input, context = {}) {
        const raw = typeof input === 'string' ? input.trim() : '';

        if (!raw) return;

        this.history.push(raw);
        if (this.history.length > this.historyLimit) {
            this.history.shift();
        }

        let parsed;
        try {
            parsed = this.parse(raw);
        } catch (error) {
            if (this.onError) {
                this.onError(error, { raw }, null);
                return;
            }
            throw error;
        }

        if (!parsed) return;

        const command = this.find(parsed.name);
        if (!command) {
            if (this.onUnknown) {
                this.onUnknown(parsed.name, parsed);
            }
            return;
        }

        try {
            await command.handler({
                ...parsed,
                context,
                manager: this,
                command,
            });
        } catch (error) {
            if (this.onError) {
                this.onError(error, parsed, command);
                return;
            }
            throw error;
        }
    }

    parse(input) {
        const tokens = this.tokenize(input);

        if (!tokens.length) {
            return null;
        }

        const name = tokens[0].toLowerCase();
        const { positional, flags } = this.extractFlags(tokens.slice(1));

        return {
            name,
            args: positional,
            flags,
            raw: input,
        };
    }

    tokenize(input) {
        const tokens = [];
        let current = '';
        let escapeNext = false;
        let quoteChar = null;

        for (let i = 0; i < input.length; i++) {
            const char = input[i];

            if (escapeNext) {
                current += char;
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (quoteChar) {
                if (char === quoteChar) {
                    quoteChar = null;
                } else {
                    current += char;
                }
                continue;
            }

            if (char === '"' || char === '\'') {
                quoteChar = char;
                continue;
            }

            if (/\s/.test(char)) {
                if (current !== '') {
                    tokens.push(current);
                    current = '';
                }
                continue;
            }

            current += char;
        }

        if (quoteChar) {
            throw new Error('Unterminated quote in command input.');
        }

        if (escapeNext) {
            throw new Error('Trailing escape character in command input.');
        }

        if (current !== '') {
            tokens.push(current);
        }

        return tokens;
    }

    extractFlags(tokens) {
        const positional = [];
        const flags = {};

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            if (!token.startsWith('--') || token === '--') {
                positional.push(token);
                continue;
            }

            let name = token.slice(2);
            let value = true;

            const equalsIndex = name.indexOf('=');
            if (equalsIndex !== -1) {
                value = name.slice(equalsIndex + 1);
                name = name.slice(0, equalsIndex);
            } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
                value = tokens[i + 1];
                i++;
            }

            const normalizedName = normalizeFlagName(name);
            const normalizedValue = normalizeFlagValue(value);

            if (flags[normalizedName] === undefined) {
                flags[normalizedName] = normalizedValue;
            } else if (Array.isArray(flags[normalizedName])) {
                flags[normalizedName].push(normalizedValue);
            } else {
                flags[normalizedName] = [flags[normalizedName], normalizedValue];
            }
        }

        return { positional, flags };
    }
}

module.exports = { CommandManager };
