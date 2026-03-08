// OpenFOAM file format parsers
// Handles ASCII FoamFile-formatted mesh and field data.

/**
 * Skip past the FoamFile { ... } header and trailing comment blocks.
 * Returns the body text after the header.
 */
export function skipFoamHeader(text) {
    const foamIdx = text.indexOf('FoamFile');
    if (foamIdx === -1) return text;
    const braceStart = text.indexOf('{', foamIdx);
    if (braceStart === -1) return text;
    let depth = 1, i = braceStart + 1;
    while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
    }
    return text.substring(i).replace(/^(\s*\/\/[^\n]*\n)*/g, '').trim();
}

/**
 * Parse a vectorField file (e.g. polyMesh/points).
 * Format: N\n(\n(x y z)\n...\n)
 * Returns array of [x, y, z] triples.
 */
export function parseVectorField(text) {
    const body = skipFoamHeader(text);
    const parenStart = body.indexOf('(');
    const n = parseInt(body.substring(0, parenStart).trim());
    const vectors = [];
    const re = /\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)/g;
    let m;
    while ((m = re.exec(body)) !== null && vectors.length < n) {
        vectors.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    }
    return vectors;
}

/**
 * Parse a labelList file (e.g. polyMesh/owner).
 * Format: N\n(\n0\n1\n...\n)
 * Returns array of integers.
 */
export function parseLabelList(text) {
    const body = skipFoamHeader(text);
    const parenStart = body.indexOf('(');
    const parenEnd = body.lastIndexOf(')');
    const n = parseInt(body.substring(0, parenStart).trim());
    const inner = body.substring(parenStart + 1, parenEnd);
    return inner.trim().split(/\s+/).map(Number).slice(0, n);
}

/**
 * Parse a faceList file (e.g. polyMesh/faces).
 * Format: N\n(\n4(0 1 2 3)\n...\n)
 * Returns array of vertex-index arrays.
 */
export function parseFaceList(text) {
    const body = skipFoamHeader(text);
    const parenStart = body.indexOf('(');
    const n = parseInt(body.substring(0, parenStart).trim());
    const faces = [];
    const re = /(\d+)\(([\d\s]+)\)/g;
    let m;
    while ((m = re.exec(body)) !== null && faces.length < n) {
        faces.push(m[2].trim().split(/\s+/).map(Number));
    }
    return faces;
}

/**
 * Parse boundary patches from the polyMesh/boundary file.
 * Returns array of { name, type, nFaces, startFace }.
 */
export function parseBoundary(text) {
    const patches = [];
    const re = /(\w+)\s*\n\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const block = m[2];
        const typeM = block.match(/type\s+(\w+)/);
        const nFacesM = block.match(/nFaces\s+(\d+)/);
        const startFaceM = block.match(/startFace\s+(\d+)/);
        if (typeM && nFacesM && startFaceM) {
            patches.push({
                name: m[1],
                type: typeM[1],
                nFaces: parseInt(nFacesM[1]),
                startFace: parseInt(startFaceM[1]),
            });
        }
    }
    return patches;
}

/**
 * Detect the OpenFOAM field type from file content.
 * Returns 'scalar', 'vector', 'surfaceScalar', or 'unknown'.
 */
export function detectFieldType(text) {
    if (/class\s+volVectorField/.test(text)) return 'vector';
    if (/class\s+volScalarField/.test(text)) return 'scalar';
    if (/class\s+surfaceScalarField/.test(text)) return 'surfaceScalar';
    return 'unknown';
}

/**
 * Extract the internalField section from a volField file.
 * Returns { format: 'uniform'|'nonuniform', value?, listText?, count? }
 * or null if not found.
 */
function extractInternalField(text, listType) {
    const idx = text.indexOf('internalField');
    if (idx === -1) return null;
    const after = text.substring(idx);

    // uniform scalar: "internalField uniform 0;"
    // uniform vector: "internalField uniform (0 0 0);"
    if (listType === 'scalar') {
        const um = after.match(/internalField\s+uniform\s+([-\d.e+]+)/);
        if (um) return { format: 'uniform', value: parseFloat(um[1]) };
    } else {
        const um = after.match(/internalField\s+uniform\s+\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)/);
        if (um) return { format: 'uniform', value: [parseFloat(um[1]), parseFloat(um[2]), parseFloat(um[3])] };
    }

    // nonuniform List<T> N ( ... )
    const tag = listType === 'scalar' ? 'scalar' : 'vector';
    const re = new RegExp(`internalField\\s+nonuniform\\s+List<${tag}>\\s+(\\d+)\\s*\\(([\\s\\S]*?)\\)\\s*;`);
    const lm = after.match(re);
    if (lm) return { format: 'nonuniform', count: parseInt(lm[1]), listText: lm[2] };

    return null;
}

/**
 * Parse a volScalarField's internalField into a Float64Array.
 */
export function parseScalarInternalField(text, nCells) {
    const field = extractInternalField(text, 'scalar');
    if (!field) return new Float64Array(nCells).fill(0);

    if (field.format === 'uniform') {
        return new Float64Array(nCells).fill(field.value);
    }
    return Float64Array.from(field.listText.trim().split(/\s+/).map(Number));
}

/**
 * Parse a volVectorField's internalField and return magnitudes.
 */
export function parseVectorFieldMagnitude(text, nCells) {
    const field = extractInternalField(text, 'vector');
    if (!field) return new Float64Array(nCells).fill(0);

    if (field.format === 'uniform') {
        const [x, y, z] = field.value;
        return new Float64Array(nCells).fill(Math.sqrt(x * x + y * y + z * z));
    }

    const result = new Float64Array(field.count);
    const re = /\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)/g;
    let m, i = 0;
    while ((m = re.exec(field.listText)) !== null) {
        const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
        result[i++] = Math.sqrt(x * x + y * y + z * z);
    }
    return result;
}

/**
 * Parse a volVectorField's internalField and return one component.
 * @param comp 0=x, 1=y, 2=z
 */
export function parseVectorFieldComponent(text, nCells, comp) {
    const field = extractInternalField(text, 'vector');
    if (!field) return new Float64Array(nCells).fill(0);

    if (field.format === 'uniform') {
        return new Float64Array(nCells).fill(field.value[comp]);
    }

    const result = new Float64Array(field.count);
    const re = /\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)/g;
    let m, i = 0;
    while ((m = re.exec(field.listText)) !== null) {
        result[i++] = parseFloat(m[comp + 1]);
    }
    return result;
}
