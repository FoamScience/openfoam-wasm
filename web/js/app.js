// Main application — wires together the worker, parsers, and renderer.

import {
    parseVectorField, parseLabelList, parseFaceList, parseBoundary,
    detectFieldType, parseScalarInternalField,
    parseVectorFieldMagnitude, parseVectorFieldComponent,
} from './foam-parser.js';

import { renderMesh } from './renderer.js';
import { parseFoamDict, serializeFoamDict, createDictForm } from './foam-dict.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────

const outputEl          = document.getElementById('output');
const statusEl          = document.getElementById('status');
const runBtn            = document.getElementById('runBtn');
const stopBtn           = document.getElementById('stopBtn');
const vizContainer      = document.getElementById('vizContainer');
const timeSelect        = document.getElementById('timeSelect');
const fieldSelect       = document.getElementById('fieldSelect');
const canvas            = document.getElementById('vizCanvas');
const resultsExplorer   = document.getElementById('resultsExplorer');
const fsTreeEl          = document.getElementById('fsTree');
const filePreviewEl     = document.getElementById('filePreview');
const registryExplorer  = document.getElementById('registryExplorer');
const registryTimeSelect = document.getElementById('registryTimeSelect');
const registrySummary   = document.getElementById('registrySummary');
const registryBody      = document.getElementById('registryBody');

// ── State ────────────────────────────────────────────────────────────────────

let meshData     = null;   // { points, vizFaces, vizFaceOwners, nCells }
let allFieldData = {};     // { time: { fieldName: text } }
let running      = false;

// Case editor: maps file label → { text, parsed, dst }
let caseFileStore = {};

// Saved init params for worker recreation
let initParams = null;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg, cls) {
    const span = document.createElement('span');
    if (cls === 'error') span.className = 'log-error';
    else if (cls === 'info') span.className = 'log-info';
    span.textContent = msg + '\n';
    outputEl.appendChild(span);
    outputEl.scrollTop = outputEl.scrollHeight;
}

window.clearOutput = () => { outputEl.innerHTML = ''; };

// ── Worker setup ─────────────────────────────────────────────────────────────

let worker = null;

function createWorker() {
    if (worker) worker.terminate();

    worker = new Worker('js/foam-worker.js');
    worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
            case 'log':
                log(msg.text, msg.cls);
                break;
            case 'status':
                statusEl.textContent = 'Status: ' + msg.text;
                break;
            case 'ready':
                statusEl.textContent = 'Status: Ready';
                runBtn.disabled = false;
                running = false;
                stopBtn.disabled = true;
                log('Both WASM modules loaded successfully!', 'info');
                break;
            case 'error':
                log(msg.text, 'error');
                statusEl.textContent = 'Status: Error';
                runBtn.disabled = false;
                running = false;
                stopBtn.disabled = true;
                break;
            case 'results':
                running = false;
                stopBtn.disabled = true;
                onResults(msg);
                break;
            case 'fileContent':
                showFileContent(msg.path, msg.content);
                break;
        }
    };
    return worker;
}

/** Terminate the worker and reinitialize with fresh WASM modules. */
function resetWorker() {
    log('Reinitializing WASM modules...', 'info');
    statusEl.textContent = 'Status: Reinitializing...';
    runBtn.disabled = true;
    createWorker();
    if (initParams) worker.postMessage(initParams);
}

// ── Case file config ─────────────────────────────────────────────────────────

const TUTORIAL_BASE = 'tutorials/basic/scalarTransportFoam/pitzDaily';
const CASE_FILES = [
    { src: `${TUTORIAL_BASE}/system/controlDict`,          dst: '/case/system/controlDict' },
    { src: `${TUTORIAL_BASE}/system/fvSchemes`,             dst: '/case/system/fvSchemes' },
    { src: `${TUTORIAL_BASE}/system/fvSolution`,            dst: '/case/system/fvSolution' },
    { src: `${TUTORIAL_BASE}/system/blockMeshDict`,         dst: '/case/system/blockMeshDict' },
    { src: `${TUTORIAL_BASE}/constant/transportProperties`, dst: '/case/constant/transportProperties' },
    { src: `${TUTORIAL_BASE}/0/T`,                          dst: '/case/0/T' },
    { src: `${TUTORIAL_BASE}/0/U`,                          dst: '/case/0/U' },
];

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    try {
        log('Fetching OpenFOAM files...', 'info');
        const [controlDict, cellModels, ...caseTexts] = await Promise.all([
            fetch('etc/controlDict').then(r => r.text()),
            fetch('etc/cellModels').then(r => r.text()),
            ...CASE_FILES.map(f => fetch(f.src).then(r => r.text())),
        ]);

        // Build case file store and editor
        CASE_FILES.forEach((f, i) => {
            // Derive a short label from the dst path: "/case/system/controlDict" → "system/controlDict"
            const label = f.dst.replace(/^\/case\//, '');
            caseFileStore[label] = { text: caseTexts[i], parsed: null, dst: f.dst };
        });
        buildCaseEditor();

        const baseUrl = new URL('.', location.href).href;
        initParams = {
            type: 'init',
            baseUrl,
            blockMeshUrl: new URL('build/blockMesh.js', location.href).href,
            solverUrl:    new URL('build/scalarTransportFoam.js', location.href).href,
            etcFiles:  { controlDict, cellModels },
            // Send original text for init (editor hasn't been touched yet)
            caseFiles: CASE_FILES.map((f, i) => ({ dst: f.dst, content: caseTexts[i] })),
        };
        createWorker();
        worker.postMessage(initParams);
    } catch (e) {
        log('Failed to fetch files: ' + e.message, 'error');
        statusEl.textContent = 'Status: Failed';
    }
}

// ── Run ──────────────────────────────────────────────────────────────────────

window.runCase = () => {
    runBtn.disabled = true;
    stopBtn.disabled = false;
    running = true;
    // Send updated case files to the worker before running
    worker.postMessage({ type: 'updateCaseFiles', caseFiles: getCaseFilesForWorker() });
    worker.postMessage({ type: 'run' });
};

window.stopCase = () => {
    if (!running) return;
    log('\n=== Simulation stopped by user ===', 'error');
    running = false;
    stopBtn.disabled = true;
    // Terminate and recreate the worker with fresh WASM modules
    resetWorker();
};

// ── Results handling ─────────────────────────────────────────────────────────

function parseMesh(meshFiles) {
    const points = parseVectorField(meshFiles.points);
    const faces  = parseFaceList(meshFiles.faces);
    const owner  = parseLabelList(meshFiles.owner);
    const patches = parseBoundary(meshFiles.boundary);

    // For 2D cases, use the front half of the "empty" patch
    const emptyPatch = patches.find(p => p.type === 'empty');
    let vizFaces, vizFaceOwners;
    if (emptyPatch) {
        const halfN = Math.floor(emptyPatch.nFaces / 2);
        vizFaces     = faces.slice(emptyPatch.startFace, emptyPatch.startFace + halfN);
        vizFaceOwners = owner.slice(emptyPatch.startFace, emptyPatch.startFace + halfN);
    } else {
        const nInt = patches.length > 0 ? patches[0].startFace : faces.length;
        vizFaces     = faces.slice(0, Math.min(nInt, 5000));
        vizFaceOwners = owner.slice(0, vizFaces.length);
    }

    const nCells = Math.max(...owner) + 1;
    return { points, vizFaces, vizFaceOwners, nCells, patches };
}

function buildFieldOptions(fieldNames, fieldData, lastTime) {
    fieldSelect.innerHTML = '';
    for (const name of fieldNames) {
        const text = fieldData[lastTime]?.[name];
        if (!text) continue;
        const ftype = detectFieldType(text);

        if (ftype === 'scalar') {
            addOption(fieldSelect, name + ':scalar', name);
        } else if (ftype === 'vector') {
            addOption(fieldSelect, name + ':mag', `${name} (magnitude)`);
            addOption(fieldSelect, name + ':x',   `${name}x`);
            addOption(fieldSelect, name + ':y',   `${name}y`);
            addOption(fieldSelect, name + ':z',   `${name}z`);
        }
    }
}

function buildTimeOptions(timeDirs) {
    timeSelect.innerHTML = '';
    for (const t of timeDirs) {
        addOption(timeSelect, t, `t = ${t}`);
    }
    if (timeDirs.length > 0) {
        timeSelect.value = timeDirs[timeDirs.length - 1];
    }
}

function addOption(select, value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
}

function onResults(msg) {
    log('Parsing mesh...', 'info');
    meshData     = parseMesh(msg.meshFiles);
    allFieldData = msg.fieldData;

    log(`Mesh: ${meshData.points.length} points, ${meshData.vizFaces.length} viz faces, ${meshData.nCells} cells`, 'info');
    log(`Time steps: ${msg.timeDirs.length}, Fields: ${msg.fieldNames.join(', ')}`, 'info');

    buildFieldOptions(msg.fieldNames, msg.fieldData, msg.timeDirs[msg.timeDirs.length - 1]);
    buildTimeOptions(msg.timeDirs);

    vizContainer.style.display = 'block';
    statusEl.textContent = 'Status: Done';
    runBtn.disabled = false;
    visualize();

    // Build registry explorer from registryDump functionObject output
    if (msg.registryDumps) {
        buildRegistryExplorer(msg.registryDumps);
    }

    // Build filesystem explorer from the full case tree
    if (msg.fsTree) {
        buildResultsExplorer(msg.fsTree);
    }
}

// ── Visualization ────────────────────────────────────────────────────────────

function getFieldValues(time, fieldSpec) {
    const [fieldName, mode] = fieldSpec.split(':');
    const text = allFieldData[time]?.[fieldName];
    if (!text) return null;

    const ftype = detectFieldType(text);
    const n = meshData.nCells;

    if (ftype === 'vector') {
        if (mode === 'mag') return parseVectorFieldMagnitude(text, n);
        if (mode === 'x')   return parseVectorFieldComponent(text, n, 0);
        if (mode === 'y')   return parseVectorFieldComponent(text, n, 1);
        if (mode === 'z')   return parseVectorFieldComponent(text, n, 2);
    }
    return parseScalarInternalField(text, n);
}

window.visualize = () => {
    const time = timeSelect.value;
    const fieldSpec = fieldSelect.value;
    if (!meshData || !time || !fieldSpec) return;

    const fieldValues = getFieldValues(time, fieldSpec);
    if (!fieldValues) {
        log(`No data for ${fieldSpec} at t=${time}`, 'error');
        return;
    }
    renderMesh(canvas, meshData, fieldValues, fieldSpec);
};

// ── Case editor ──────────────────────────────────────────────────────────────

const editorTabs = document.getElementById('caseEditorTabs');
const editorBody = document.getElementById('caseEditorBody');

/** Get the current case file contents (with any edits applied). */
function getCaseFilesForWorker() {
    return Object.values(caseFileStore).map(entry => ({
        dst: entry.dst,
        content: entry.parsed ? serializeFoamDict(entry.parsed) : entry.text,
    }));
}

/** Build tabbed editor UI for all case files. */
function buildCaseEditor() {
    editorTabs.innerHTML = '';
    editorBody.innerHTML = '';

    const labels = Object.keys(caseFileStore);

    for (const label of labels) {
        const entry = caseFileStore[label];

        // Tab (Bootstrap nav-item)
        const li = document.createElement('li');
        li.className = 'nav-item';
        const btn = document.createElement('button');
        btn.className = 'nav-link small py-1 px-2';
        btn.textContent = label.split('/').pop();
        btn.title = label;
        btn.addEventListener('click', () => showTab(label));
        li.appendChild(btn);
        editorTabs.appendChild(li);

        // Form panel
        const panel = document.createElement('div');
        panel.style.display = 'none';
        panel.dataset.label = label;

        try {
            entry.parsed = parseFoamDict(entry.text);
            const form = createDictForm(entry.parsed, () => {
                // Values update in-place on the parsed tree
            });
            panel.appendChild(form);
        } catch (err) {
            // Fallback: raw textarea for unparseable files
            const textarea = document.createElement('textarea');
            textarea.className = 'form-control form-control-sm font-monospace';
            textarea.style.height = '300px';
            textarea.value = entry.text;
            textarea.addEventListener('change', () => {
                entry.text = textarea.value;
                entry.parsed = null;
            });
            panel.appendChild(textarea);
        }

        editorBody.appendChild(panel);
    }

    if (labels.length > 0) showTab(labels[0]);
}

function showTab(label) {
    for (const li of editorTabs.children) {
        const btn = li.querySelector('.nav-link');
        if (btn) btn.classList.toggle('active', btn.title === label);
    }
    for (const panel of editorBody.children) {
        panel.style.display = panel.dataset.label === label ? 'block' : 'none';
    }
}

// ── Object Registry explorer ─────────────────────────────────────────────────

let registryData = {};  // { time: [ { className, objects: [{name, writeOpt}] } ] }

/** Parse a registryDump postProcessing file into structured data.
 *  Format:
 *    className
 *    {
 *        objName    AUTO_WRITE;
 *        objName2   NO_WRITE;
 *    }
 */
function parseRegistryDump(text) {
    const groups = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();
        // Skip comments and blank lines
        if (!line || line.startsWith('//')) { i++; continue; }

        // Expect a class name followed by {
        if (i + 1 < lines.length && lines[i + 1].trim() === '{') {
            const className = line;
            const objects = [];
            i += 2; // skip className and {
            while (i < lines.length) {
                const objLine = lines[i].trim();
                if (objLine === '}') { i++; break; }
                if (objLine) {
                    // "objName    AUTO_WRITE;" or "objName    NO_WRITE;"
                    const parts = objLine.replace(';', '').trim().split(/\s+/);
                    if (parts.length >= 2) {
                        objects.push({ name: parts[0], writeOpt: parts[1] });
                    } else if (parts.length === 1) {
                        objects.push({ name: parts[0], writeOpt: 'unknown' });
                    }
                }
                i++;
            }
            groups.push({ className, objects });
        } else {
            i++;
        }
    }
    return groups;
}

function buildRegistryExplorer(registryDumps) {
    registryData = {};
    const times = Object.keys(registryDumps)
        .sort((a, b) => parseFloat(a) - parseFloat(b));

    if (times.length === 0) return;

    for (const t of times) {
        registryData[t] = parseRegistryDump(registryDumps[t]);
    }

    // Populate time selector
    registryTimeSelect.innerHTML = '';
    for (const t of times) {
        addOption(registryTimeSelect, t, `t = ${t}`);
    }
    registryTimeSelect.value = times[times.length - 1];

    registryExplorer.style.display = 'block';
    showRegistryTime();
}

window.showRegistryTime = () => {
    const t = registryTimeSelect.value;
    const groups = registryData[t];
    if (!groups) return;

    registryBody.innerHTML = '';

    let totalObjects = 0;
    for (const g of groups) totalObjects += g.objects.length;
    registrySummary.textContent = `${totalObjects} objects in ${groups.length} types`;

    for (const group of groups) {
        const div = document.createElement('div');
        div.className = 'reg-class-group open';

        const header = document.createElement('div');
        header.className = 'reg-class-header';
        header.textContent = group.className + ' ';

        const countBadge = document.createElement('span');
        countBadge.className = 'badge bg-secondary';
        countBadge.textContent = group.objects.length;
        header.appendChild(countBadge);

        header.addEventListener('click', () => div.classList.toggle('open'));
        div.appendChild(header);

        const objList = document.createElement('div');
        objList.className = 'reg-class-objects';

        for (const obj of group.objects) {
            const row = document.createElement('div');
            row.className = 'reg-object';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = obj.name + ' ';
            row.appendChild(nameSpan);

            const writeBadge = document.createElement('span');
            if (obj.writeOpt === 'AUTO_WRITE') {
                writeBadge.className = 'badge bg-success';
                writeBadge.textContent = 'AUTO_WRITE';
            } else {
                writeBadge.className = 'badge bg-dark text-secondary';
                writeBadge.textContent = obj.writeOpt;
            }
            row.appendChild(writeBadge);

            objList.appendChild(row);
        }

        div.appendChild(objList);
        registryBody.appendChild(div);
    }
};

// ── Results explorer (filesystem tree) ───────────────────────────────────────

/** Classify a directory name for badge display. */
function classifyDir(name, path) {
    if (name === 'polyMesh')       return { label: 'mesh', cls: 'badge bg-warning text-dark' };
    if (name === 'system')         return { label: 'system', cls: 'badge bg-primary' };
    if (name === 'uniform')        return { label: 'uniform', cls: 'badge bg-secondary' };
    if (name === 'postProcessing') return { label: 'postProc', cls: 'badge bg-info text-dark' };
    if (!isNaN(parseFloat(name)))  return { label: 't=' + name, cls: 'badge bg-success' };
    return null;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Build a DOM tree from the fsTree structure. */
function buildFsTreeNode(node) {
    if (node.type === 'dir') {
        const div = document.createElement('div');
        div.className = 'fs-dir';

        const label = document.createElement('div');
        label.className = 'fs-dir-label';
        label.textContent = node.name + '/';

        // Add badge if applicable
        const badge = classifyDir(node.name, node.path);
        if (badge) {
            const span = document.createElement('span');
            span.className = badge.cls;
            span.style.fontSize = '10px';
            span.textContent = badge.label;
            label.appendChild(span);
        }

        label.addEventListener('click', () => div.classList.toggle('open'));
        div.appendChild(label);

        const children = document.createElement('div');
        children.className = 'fs-dir-children';
        for (const child of node.children) {
            children.appendChild(buildFsTreeNode(child));
        }
        div.appendChild(children);

        // Auto-expand top-level dirs
        if (node.path.split('/').length <= 3) div.classList.add('open');

        return div;
    } else {
        const div = document.createElement('div');
        div.className = 'fs-file';
        div.textContent = node.name;

        if (node.size != null) {
            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'fs-file-size';
            sizeSpan.textContent = formatSize(node.size);
            div.appendChild(sizeSpan);
        }

        div.addEventListener('click', () => {
            // Mark active
            fsTreeEl.querySelectorAll('.fs-file.active').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            // Request file content from worker
            filePreviewEl.textContent = 'Loading ' + node.path + '...';
            worker.postMessage({ type: 'readFile', path: node.path });
        });

        return div;
    }
}

function showFileContent(path, content) {
    filePreviewEl.textContent = '// ' + path + '\n\n' + content;
}

function buildResultsExplorer(fsTree) {
    fsTreeEl.innerHTML = '';
    filePreviewEl.textContent = '← Click a file to preview its contents';

    for (const node of fsTree) {
        fsTreeEl.appendChild(buildFsTreeNode(node));
    }
    resultsExplorer.style.display = 'block';
}

// ── Start ────────────────────────────────────────────────────────────────────

init();
