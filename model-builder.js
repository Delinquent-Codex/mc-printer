const fs = require('fs');
const getPixels = require('get-pixels');

function distanceBetweenPoints(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function lerp(a, b, t) {
    return (1.0 - t) * a + t * b;
}

function lerp2D([x1, y1], [x2, y2], t) {
    return [
        lerp(x1, x2, t),
        lerp(y1, y2, t),
    ];
}

function lerp3D(a, b, t) {
    return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
    };
}

async function loadImage(path) {
    return new Promise((resolve, reject) => {
        getPixels(path, (err, image) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(image);
        });
    });
}

function getTextureColor(texture, uv) {
    const x = Math.min(texture.shape[0] - 1, Math.max(0, Math.floor(uv[0] * texture.shape[0])));
    const y = Math.min(texture.shape[1] - 1, Math.max(0, Math.floor((1 - uv[1]) * texture.shape[1])));

    const r = texture.get(x, y, 0);
    const g = texture.get(x, y, 1);
    const b = texture.get(x, y, 2);
    const alpha = texture.shape[2] > 3 ? texture.get(x, y, 3) : 255;

    return [r, g, b, alpha];
}

function getBlockFromUV(bot, texture, uv) {
    const color = getTextureColor(texture, uv);
    return bot.colors.getBlock(color);
}

async function readModelFile(path) {
    const modelData = fs.readFileSync(path, 'utf8');
    return parseModelData(modelData);
}

function parseModelData(data) {
    const vertices = [];
    const vts = [];
    const faces = [];
    const uvs = [];

    const rows = data.split('\n').map((line) => line.trim()).filter(Boolean);
    const size = 1; // legacy scale value retained for compatibility.

    for (const row of rows) {
        const parts = row.split(/\s+/);

        if (parts[0] === 'v') {
            vertices.push({
                x: parseFloat(parts[1]),
                y: parseFloat(parts[2]),
                z: parseFloat(parts[3]),
            });
            continue;
        }

        if (parts[0] === 'vt') {
            vts.push([
                parseFloat(parts[1]),
                parseFloat(parts[2]),
            ]);
            continue;
        }

        if (parts[0] === 'f') {
            const face = [];
            const faceUVs = [];

            for (let i = 1; i < parts.length; i++) {
                const faceData = parts[i].split('/');

                face.push(parseInt(faceData[0], 10) - 1);

                if (faceData.length > 1 && faceData[1]) {
                    faceUVs.push(parseInt(faceData[1], 10) - 1);
                } else {
                    faceUVs.push(0);
                }
            }

            faces.push(face);
            uvs.push(faceUVs);
        }
    }

    return {
        size,
        vertices,
        faces,
        uvs,
        vts,
    };
}

let blocksPlaced = 0;

async function setBlock(bot, position, blockType) {
    if (blockType === 'air' || blockType === 'cave_air') {
        return;
    }

    await bot.chat(`/setblock ${position.x} ${position.y} ${position.z} ${blockType}`);

    if (blocksPlaced % bot.settings.chunkSize === 0) {
        await bot.waitForTicks(1);
    }
    blocksPlaced++;
}

// I don't currently use this function but I'm very tempted.
async function coolSetBlock(bot, position, blockType) {
    await bot.chat(`/setblock ${position.x} ${position.y} ${position.z} red_concrete`);
    await bot.waitForTicks(2);
    await bot.chat(`/setblock ${position.x} ${position.y} ${position.z} ${blockType}`);
}

async function buildLine(bot, pointA, pointB, texture, [uvA, uvB]) {
    const distance = Math.max(1, distanceBetweenPoints(pointA, pointB));

    for (let i = 0; i < distance; i++) {
        const point = lerp3D(pointA, pointB, i / distance);
        const pointUV = lerp2D(uvA, uvB, i / distance);

        const block = getBlockFromUV(bot, texture, pointUV);

        point.x = Math.floor(point.x);
        point.y = Math.floor(point.y);
        point.z = Math.floor(point.z);

        await setBlock(bot, point, block);
    }
}

async function buildTriangle(bot, pointA, pointB, pointC, texture, [uvA, uvB, uvC]) {
    const distance = Math.max(1, distanceBetweenPoints(pointA, pointB));

    for (let i = 0; i < distance; i++) {
        const pointAB = lerp3D(pointA, pointB, i / distance);
        const uvAB = lerp2D(uvA, uvB, i / distance);

        await buildLine(bot, pointAB, pointC, texture, [uvAB, uvC]);
    }
}

async function buildQuad(bot, pointA, pointB, pointC, pointD, texture, uv) {
    await buildTriangle(bot, pointA, pointB, pointC, texture, [uv[0], uv[1], uv[2]]);
    await buildTriangle(bot, pointC, pointD, pointA, texture, [uv[2], uv[3], uv[0]]);
}

async function buildModel(bot, { path, textureLocation, position, size }, buildType) {
    bot.chat(`Preparing model of ${path}. (${size})`);

    const model = await readModelFile(path);
    const texture = await loadImage(textureLocation);

    const scale = (1 / model.size) * size;

    bot.chat(`Building model of ${path}. (${size})`);

    if (buildType === 'points') {
        for (const vertex of model.vertices) {
            const pos = position.offset(vertex.x * scale, vertex.y * scale, vertex.z * scale).floor();

            await bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} light_blue_concrete`);
            await bot.waitForTicks(1);
        }

        return;
    }

    for (let index = 0; index < model.faces.length; index++) {
        const face = model.faces[index].map((vertexIndex) => {
            const vertex = model.vertices[vertexIndex];
            return position.offset(vertex.x * scale, vertex.y * scale, vertex.z * scale);
        });

        const faceUVs = model.uvs[index].map((vtIndex) => {
            return model.vts[vtIndex] || [0, 0];
        });

        if (face.length === 3) {
            await buildTriangle(bot, face[0], face[1], face[2], texture, faceUVs);
        } else if (face.length === 4) {
            await buildQuad(bot, face[0], face[1], face[2], face[3], texture, faceUVs);
        }

        for (let k = 0; k < face.length - 1; k++) {
            await buildLine(bot, face[k], face[k + 1], texture, [faceUVs[k], faceUVs[k + 1]]);
        }
    }
}

exports.buildModel = buildModel;
exports.parseModelData = parseModelData;
