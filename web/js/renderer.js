// 2D Canvas renderer for OpenFOAM mesh fields

/** Jet-like colormap: maps t in [0,1] to [r, g, b] in [0,255]. */
export function scalarToColor(t) {
    t = Math.max(0, Math.min(1, t));
    let r, g, b;
    if (t < 0.25)      { r = 0;               g = 4 * t;             b = 1; }
    else if (t < 0.5)  { r = 0;               g = 1;                 b = 1 - 4 * (t - 0.25); }
    else if (t < 0.75) { r = 4 * (t - 0.5);   g = 1;                 b = 0; }
    else                { r = 1;               g = 1 - 4 * (t - 0.75); b = 0; }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Draw a vertical colorbar with labels on a canvas context. */
function drawColorbar(ctx, minVal, maxVal, x, y, w, h) {
    for (let row = 0; row < h; row++) {
        const t = 1 - row / h;
        const [r, g, b] = scalarToColor(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y + row, w, 1);
    }
    ctx.strokeStyle = '#888';
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = '#e0e0e0';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    const nLabels = 4;
    for (let i = 0; i <= nLabels; i++) {
        const val = minVal + (maxVal - minVal) * (1 - i / nLabels);
        ctx.fillText(val.toFixed(3), x + w + 5, y + i * (h / nLabels) + 4);
    }
}

/** Compute axis-aligned bounding box of points (2D, uses x/y only). */
function computeBBox(points) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
}

/** Compute min/max of a typed array. */
function fieldRange(values) {
    let fMin = Infinity, fMax = -Infinity;
    for (const v of values) {
        if (v < fMin) fMin = v;
        if (v > fMax) fMax = v;
    }
    if (fMax === fMin) fMax = fMin + 1;
    return { fMin, fMax };
}

/**
 * Render mesh faces colored by field values onto a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ points, vizFaces, vizFaceOwners }} mesh
 * @param {Float64Array} fieldValues - per-cell values
 * @param {string} fieldLabel - e.g. "T:scalar" or "U:mag"
 */
export function renderMesh(canvas, mesh, fieldValues, fieldLabel) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    // Background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f0f23';
    ctx.fillRect(0, 0, W, H);

    const { points, vizFaces, vizFaceOwners } = mesh;
    if (vizFaces.length === 0 || points.length === 0) return;

    // Layout constants
    const MARGIN = 40;
    const RIGHT_MARGIN = 120;
    const COLORBAR_WIDTH = 20;

    // Fit mesh into canvas
    const bbox = computeBBox(points);
    const rangeX = bbox.maxX - bbox.minX;
    const rangeY = bbox.maxY - bbox.minY;
    const scaleX = (W - MARGIN - RIGHT_MARGIN) / rangeX;
    const scaleY = (H - 2 * MARGIN) / rangeY;
    const scale = Math.min(scaleX, scaleY);

    const offsetX = MARGIN + ((W - MARGIN - RIGHT_MARGIN) - rangeX * scale) / 2;
    const offsetY = MARGIN + ((H - 2 * MARGIN) - rangeY * scale) / 2;

    const tx = (x) => offsetX + (x - bbox.minX) * scale;
    const ty = (y) => H - (offsetY + (y - bbox.minY) * scale);

    // Field range
    const { fMin, fMax } = fieldRange(fieldValues);

    // Colorbar
    drawColorbar(ctx, fMin, fMax, W - 90, MARGIN + 10, COLORBAR_WIDTH, H - 2 * MARGIN - 20);

    // Draw faces
    for (let fi = 0; fi < vizFaces.length; fi++) {
        const face = vizFaces[fi];
        const cellId = vizFaceOwners[fi];
        const val = fieldValues[cellId] !== undefined ? fieldValues[cellId] : 0;
        const t = (val - fMin) / (fMax - fMin);
        const [r, g, b] = scalarToColor(t);

        ctx.beginPath();
        ctx.moveTo(tx(points[face[0]][0]), ty(points[face[0]][1]));
        for (let j = 1; j < face.length; j++) {
            ctx.lineTo(tx(points[face[j]][0]), ty(points[face[j]][1]));
        }
        ctx.closePath();
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fill();
    }

    // Title
    const [name, mode] = fieldLabel.split(':');
    const displayName = mode === 'mag' ? `|${name}|` : mode === 'scalar' ? name : `${name}.${mode}`;
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${displayName} — min: ${fMin.toFixed(4)}, max: ${fMax.toFixed(4)}`, MARGIN, 20);
}
