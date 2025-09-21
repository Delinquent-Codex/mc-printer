const fs = require('fs');

const antiColor = require('./antimatter-color.js');
const colourDistances = require('./colour-distances.js');
const palettes = JSON.parse(fs.readFileSync('palettes.json', 'utf8'));

function parsePaletteString(paletteString) {
    const palette = [];

    for (const paletteName of paletteString.split('+')) {
        if (palettes[paletteName]) {
            palette.push(...palettes[paletteName]);
        }
    }

    return palette;
}

function colorDistanceRGB([r1, g1, b1], [r2, g2, b2]) {
    return colourDistances.rgb(r1, g1, b1, r2, g2, b2);
}

function colorDistanceLAB([r1, g1, b1], [r2, g2, b2]) {
    return antiColor.deltaE(
        antiColor.rgb2lab([r1, g1, b1]),
        antiColor.rgb2lab([r2, g2, b2])
    );
}

function getBlockFromColor(bot, [r, g, b, alpha], palette = 'zero-gravity', mode = 'rgb') {
    const settings = bot.settings;

    if (typeof palette === 'string') {
        palette = parsePaletteString(palette);
    }

    if (!palette.length) {
        return 'air';
    }

    if (alpha === 0) {
        return 'air';
    }

    let best = palette[0];

    for (const swatch of palette.slice(1)) {
        if (mode.toUpperCase() === 'LAB' || settings.mode === 'LAB') {
            const disA = colorDistanceLAB([r, g, b], best[settings.color]);
            const disB = colorDistanceLAB([r, g, b], swatch[settings.color]);
            best = disA < disB ? best : swatch;
        } else {
            const distanceA = colorDistanceRGB([r, g, b], best[settings.color]);
            const distanceB = colorDistanceRGB([r, g, b], swatch[settings.color]);
            best = distanceA < distanceB ? best : swatch;
        }
    }

    return best.block;
}

function plugin(bot) {
    bot.colors = {};
    bot.colors.palettes = palettes;

    bot.colors.getBlock = (color, palette = 'zero-gravity', mode = 'rgb')=>{
        return getBlockFromColor(bot, color, palette, mode);
    };
}

module.exports = plugin;
