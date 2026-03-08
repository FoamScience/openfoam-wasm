// Web Worker for running OpenFOAM WASM modules off the main thread.
// Communicates with the main thread via structured messages.
//
// Inbound messages:
//   { type: 'init', baseUrl, blockMeshUrl, solverUrl, etcFiles, caseFiles }
//   { type: 'run' }
//
// Outbound messages:
//   { type: 'log',     text, cls? }
//   { type: 'status',  text }
//   { type: 'ready' }
//   { type: 'error',   text }
//   { type: 'results', meshFiles, timeDirs, fieldNames, fieldData }

let blockMeshMod = null;
let solverMod = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkdirp(FS, path) {
    const parts = path.split('/').filter(Boolean);
    let dir = '';
    for (let i = 0; i < parts.length; i++) {
        dir += '/' + parts[i];
        try { FS.mkdir(dir); } catch (_) { /* exists */ }
    }
}

function writeFileRecursive(FS, path, content) {
    const parent = path.substring(0, path.lastIndexOf('/'));
    mkdirp(FS, parent);
    FS.writeFile(path, typeof content === 'string' ? content : new Uint8Array(content));
}

function setupEnv(mod) {
    mod.ENV = mod.ENV || {};
    mod.ENV['WM_PROJECT_DIR'] = '/openfoam';
    mod.ENV['WM_PROJECT'] = 'OpenFOAM';
    mod.ENV['FOAM_ETC'] = '/openfoam/etc';
}

function copyFS(srcFS, dstFS, path) {
    const entries = srcFS.readdir(path).filter(e => e !== '.' && e !== '..');
    for (const entry of entries) {
        const full = path + '/' + entry;
        const stat = srcFS.stat(full);
        if (srcFS.isDir(stat.mode)) {
            try { dstFS.mkdir(full); } catch (_) { /* exists */ }
            copyFS(srcFS, dstFS, full);
        } else {
            dstFS.writeFile(full, srcFS.readFile(full));
        }
    }
}

function post(type, data) { self.postMessage({ type, ...data }); }
function info(text)  { post('log', { text, cls: 'info' }); }
function error(text) { post('log', { text, cls: 'error' }); }

// ── Registry dump capture from stdout ────────────────────────────────────────

let registryDumpCapture = {};  // { time: "raw text block" }
let _regCapturing = false;
let _regTime = null;
let _regLines = [];

function processOutputLine(text) {
    // Detect BEGIN_REGISTRY_DUMP t=0.005 n=42
    const beginMatch = text.match(/^BEGIN_REGISTRY_DUMP\s+t=(\S+)/);
    if (beginMatch) {
        _regCapturing = true;
        _regTime = beginMatch[1];
        _regLines = [];
        return; // don't forward this marker line to the log
    }

    if (_regCapturing) {
        if (text.trim() === 'END_REGISTRY_DUMP') {
            registryDumpCapture[_regTime] = _regLines.join('\n');
            _regCapturing = false;
            _regTime = null;
            _regLines = [];
            return; // don't forward marker
        }
        _regLines.push(text);
        return; // don't forward registry dump content to log (too noisy)
    }

    // Normal log line
    post('log', { text });
}

function resetRegistryCapture() {
    registryDumpCapture = {};
    _regCapturing = false;
    _regTime = null;
    _regLines = [];
}

/** Run callMain, swallowing the Emscripten exit() exception. */
function safeCallMain(mod, args) {
    try {
        return mod.callMain(args);
    } catch (ex) {
        if (ex.message && ex.message.includes('exit')) return 0;
        throw ex;
    }
}

// ── Module loading ───────────────────────────────────────────────────────────

function writeSetupFiles(mod, etcFiles, caseFiles) {
    writeFileRecursive(mod.FS, '/openfoam/etc/controlDict', etcFiles.controlDict);
    writeFileRecursive(mod.FS, '/openfoam/etc/cellModels', etcFiles.cellModels);
    for (const f of caseFiles) {
        writeFileRecursive(mod.FS, f.dst, f.content);
    }
}

async function loadModule(scriptUrl, baseUrl, etcFiles, caseFiles) {
    importScripts(scriptUrl);
    // Both Emscripten modules export as `createOpenFOAM`; capture before next import overwrites it.
    const factory = createOpenFOAM;
    return factory({
        locateFile: (path) => baseUrl + 'build/' + path,
        print:    (text) => processOutputLine(text),
        printErr: (text) => post('log', { text, cls: 'error' }),
        preRun: [(mod) => {
            setupEnv(mod);
            writeSetupFiles(mod, etcFiles, caseFiles);
        }],
    });
}

// ── Result extraction ────────────────────────────────────────────────────────

function readTextFile(FS, path) {
    return new TextDecoder().decode(FS.readFile(path));
}

/** Recursively scan a directory, returning a tree structure.
 *  Each node: { name, path, type:'dir'|'file', children?, size? } */
function scanDir(FS, dirPath) {
    const entries = FS.readdir(dirPath).filter(e => e !== '.' && e !== '..');
    const nodes = [];
    for (const name of entries) {
        const full = dirPath + '/' + name;
        try {
            const stat = FS.stat(full);
            if (FS.isDir(stat.mode)) {
                nodes.push({ name, path: full, type: 'dir', children: scanDir(FS, full) });
            } else {
                nodes.push({ name, path: full, type: 'file', size: stat.size });
            }
        } catch (_) { /* skip inaccessible entries */ }
    }
    // Sort: dirs first, then alphabetical; time-like names sorted numerically
    nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        const na = parseFloat(a.name), nb = parseFloat(b.name);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.name.localeCompare(b.name);
    });
    return nodes;
}

/** Read a file from FS, returning text content (truncated for large binary files). */
function readFilePreview(FS, path, maxBytes) {
    try {
        const data = FS.readFile(path);
        if (data.length > maxBytes) {
            return new TextDecoder().decode(data.slice(0, maxBytes)) + '\n... [truncated]';
        }
        return new TextDecoder().decode(data);
    } catch (_) { return '[unable to read]'; }
}

function extractResults(FS) {
    const meshFiles = {
        points:   readTextFile(FS, '/case/constant/polyMesh/points'),
        faces:    readTextFile(FS, '/case/constant/polyMesh/faces'),
        owner:    readTextFile(FS, '/case/constant/polyMesh/owner'),
        boundary: readTextFile(FS, '/case/constant/polyMesh/boundary'),
    };

    const entries = FS.readdir('/case');
    const timeDirs = entries
        .filter(e => e !== '.' && e !== '..' && !isNaN(parseFloat(e)))
        .sort((a, b) => parseFloat(a) - parseFloat(b));

    const lastTime = timeDirs[timeDirs.length - 1];
    const fieldNames = FS.readdir('/case/' + lastTime)
        .filter(e => e !== '.' && e !== '..' && e !== 'uniform');

    const fieldData = {};
    for (const t of timeDirs) {
        fieldData[t] = {};
        for (const f of fieldNames) {
            try { fieldData[t][f] = readTextFile(FS, `/case/${t}/${f}`); }
            catch (_) { /* field may not exist at all times */ }
        }
    }

    // Full filesystem tree for the results explorer
    const fsTree = scanDir(FS, '/case');

    // Registry dumps captured from stdout during the run
    const registryDumps = { ...registryDumpCapture };

    return { meshFiles, timeDirs, fieldNames, fieldData, fsTree, registryDumps };
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async function (e) {
    const msg = e.data;

    if (msg.type === 'init') {
        try {
            info('Loading blockMesh WASM module...');
            blockMeshMod = await loadModule(msg.blockMeshUrl, msg.baseUrl, msg.etcFiles, msg.caseFiles);

            info('Loading scalarTransportFoam WASM module...');
            solverMod = await loadModule(msg.solverUrl, msg.baseUrl, msg.etcFiles, msg.caseFiles);

            post('ready', {});
        } catch (err) {
            post('error', { text: 'Init failed: ' + err.message });
        }
    }

    if (msg.type === 'updateCaseFiles') {
        // Overwrite case files in both modules' FS with edited content
        for (const f of msg.caseFiles) {
            writeFileRecursive(blockMeshMod.FS, f.dst, f.content);
            writeFileRecursive(solverMod.FS, f.dst, f.content);
        }
    }

    if (msg.type === 'readFile') {
        // On-demand file content request from the results explorer
        try {
            const content = readFilePreview(solverMod.FS, msg.path, 256 * 1024);
            post('fileContent', { path: msg.path, content });
        } catch (err) {
            post('fileContent', { path: msg.path, content: '[error: ' + err.message + ']' });
        }
    }

    if (msg.type === 'run') {
        try {
            resetRegistryCapture();
            info('\n=== Running blockMesh ===');
            post('status', { text: 'Running blockMesh...' });
            safeCallMain(blockMeshMod, ['-case', '/case']);

            info('Copying mesh to solver...');
            copyFS(blockMeshMod.FS, solverMod.FS, '/case');

            info('\n=== Running scalarTransportFoam ===');
            post('status', { text: 'Running solver...' });
            safeCallMain(solverMod, ['-case', '/case']);

            info('\n=== Preparing results ===');
            post('status', { text: 'Reading results...' });
            const results = extractResults(solverMod.FS);
            post('results', results);
        } catch (err) {
            post('error', { text: 'Run failed: ' + err.message });
        }
    }
};
