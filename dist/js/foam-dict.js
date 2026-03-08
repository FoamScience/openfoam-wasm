// Generic OpenFOAM dictionary parser, form generator, and serializer.
//
// Parses the FoamFile dictionary format into a structured tree,
// generates HTML form elements from it, and serializes edits back.

// ── Types ────────────────────────────────────────────────────────────────────
// Each node in the parsed tree:
//   { type: 'scalar',  value: number, raw: string }
//   { type: 'bool',    value: bool,   raw: string }
//   { type: 'word',    value: string }
//   { type: 'string',  value: string }       // quoted "..."
//   { type: 'vector',  value: number[] }     // (x y z)
//   { type: 'list',    value: string }       // raw text for complex lists
//   { type: 'dict',    entries: [{ key, node, comment? }], header?: string }
//   { type: 'verbatim', raw: string }        // unparseable, kept as-is

// ── Tokenizer / Parser ──────────────────────────────────────────────────────

/**
 * Parse an OpenFOAM dictionary file into a tree structure.
 * Returns { header: string|null, root: dictNode }.
 */
export function parseFoamDict(text) {
    // Separate FoamFile header from body
    let header = null;
    let body = text;

    const foamIdx = text.indexOf('FoamFile');
    if (foamIdx !== -1) {
        const braceStart = text.indexOf('{', foamIdx);
        if (braceStart !== -1) {
            let depth = 1, i = braceStart + 1;
            while (i < text.length && depth > 0) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') depth--;
                i++;
            }
            header = text.substring(0, i);
            body = text.substring(i);
        }
    }

    // Strip block-level comment lines (// *** ... ***) between header and content
    body = body.replace(/^(\s*\/\/[^\n]*\n)*/g, '').trim();

    const root = parseDict(body, true);
    return { header, root };
}

/**
 * Parse a dictionary body (between outer braces or at top level).
 */
function parseDict(text, topLevel = false) {
    const entries = [];
    let pos = 0;

    // Skip leading whitespace and opening brace for non-toplevel
    if (!topLevel) {
        pos = skipWS(text, pos);
        if (text[pos] === '{') pos++;
    }

    while (pos < text.length) {
        pos = skipWS(text, pos);
        if (pos >= text.length) break;

        // Collect preceding comments
        let comment = '';
        while (pos < text.length && text.substring(pos).match(/^\/\//)) {
            const eol = text.indexOf('\n', pos);
            const line = eol === -1 ? text.substring(pos) : text.substring(pos, eol);
            comment += (comment ? '\n' : '') + line.trim();
            pos = eol === -1 ? text.length : eol + 1;
            pos = skipWS(text, pos, true); // skip blank lines only
        }

        pos = skipWS(text, pos);
        if (pos >= text.length) break;
        if (text[pos] === '}') { pos++; break; } // end of dict

        // Skip #include and other directives
        if (text[pos] === '#') {
            const eol = text.indexOf('\n', pos);
            const line = eol === -1 ? text.substring(pos) : text.substring(pos, eol);
            entries.push({ key: null, node: { type: 'verbatim', raw: line }, comment });
            pos = eol === -1 ? text.length : eol + 1;
            continue;
        }

        // Read key
        const keyResult = readToken(text, pos);
        if (!keyResult) break;
        const key = keyResult.token;
        pos = keyResult.end;

        pos = skipWS(text, pos);
        if (pos >= text.length) break;

        // Check what follows the key
        if (text[pos] === '{') {
            // Sub-dictionary
            const dictEnd = findMatchingBrace(text, pos);
            const dictBody = text.substring(pos, dictEnd + 1);
            const node = parseDict(dictBody);
            node.type = 'dict';
            entries.push({ key, node, comment: comment || undefined });
            pos = dictEnd + 1;
            // Skip optional semicolon after dict
            const afterDict = skipWS(text, pos);
            if (afterDict < text.length && text[afterDict] === ';') pos = afterDict + 1;
        } else {
            // Value — read until semicolon
            const semiPos = findSemicolon(text, pos);
            if (semiPos === -1) break;
            const rawValue = text.substring(pos, semiPos).trim();
            const node = classifyValue(rawValue);
            entries.push({ key, node, comment: comment || undefined });
            pos = semiPos + 1;
        }
    }

    return { type: 'dict', entries };
}

function skipWS(text, pos, blankOnly = false) {
    while (pos < text.length) {
        const ch = text[pos];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { pos++; continue; }
        // Block comments
        if (!blankOnly && ch === '/' && pos + 1 < text.length && text[pos + 1] === '*') {
            const end = text.indexOf('*/', pos + 2);
            pos = end === -1 ? text.length : end + 2;
            continue;
        }
        break;
    }
    return pos;
}

function readToken(text, pos) {
    pos = skipWS(text, pos);
    if (pos >= text.length) return null;

    // Quoted string
    if (text[pos] === '"') {
        const end = text.indexOf('"', pos + 1);
        if (end === -1) return null;
        return { token: text.substring(pos + 1, end), end: end + 1 };
    }

    // Unquoted word — may include balanced parens like div(phi,T)
    let end = pos;
    while (end < text.length) {
        const ch = text[end];
        if (/[\s{};[\]]/.test(ch)) break;
        if (ch === '(') {
            // Include balanced parentheses as part of the token
            // (handles keys like "div(phi,T)", "laplacian(nuEff,U)")
            let depth = 1;
            end++;
            while (end < text.length && depth > 0) {
                if (text[end] === '(') depth++;
                else if (text[end] === ')') depth--;
                end++;
            }
            continue;
        }
        if (ch === ')') break; // unmatched close paren — not part of token
        end++;
    }
    if (end === pos) return null;
    return { token: text.substring(pos, end), end };
}

function findMatchingBrace(text, pos) {
    let depth = 0;
    for (let i = pos; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return text.length - 1;
}

function findSemicolon(text, pos) {
    // Find semicolon, respecting nested parens/braces/quotes
    let depth = 0;
    let inQuote = false;
    for (let i = pos; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) { if (ch === '"') inQuote = false; continue; }
        if (ch === '"') { inQuote = true; continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        else if (ch === ';' && depth === 0) return i;
    }
    return -1;
}

/** Classify a raw value string into a typed node. */
function classifyValue(raw) {
    // Boolean
    if (/^(yes|no|true|false|on|off)$/i.test(raw)) {
        const val = /^(yes|true|on)$/i.test(raw);
        return { type: 'bool', value: val, raw };
    }

    // Scalar number
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
        return { type: 'scalar', value: parseFloat(raw), raw };
    }

    // Vector or short numeric list: (x y z ...)
    const vecMatch = raw.match(/^\(\s*(.*?)\s*\)$/s);
    if (vecMatch) {
        const inner = vecMatch[1].trim();
        const parts = inner.split(/\s+/);
        if (parts.length <= 6 && parts.every(p => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(p))) {
            return { type: 'vector', value: parts.map(Number) };
        }
        // Complex list
        return { type: 'list', value: raw };
    }

    // Quoted string
    if (raw.startsWith('"') && raw.endsWith('"')) {
        return { type: 'string', value: raw.slice(1, -1) };
    }

    // Word or multi-word value (scheme specs like "Gauss linear", identifiers, etc.)
    if (/^[\w.\/\-:*<>(),][\w.\/\-:*<>(),\s]*$/.test(raw) && !raw.includes('\n')) {
        return { type: 'word', value: raw };
    }

    // Fallback
    return { type: 'verbatim', raw };
}

// ── Serializer ───────────────────────────────────────────────────────────────

/**
 * Serialize a parsed dict tree back to OpenFOAM format.
 */
export function serializeFoamDict(parsed) {
    let out = '';
    if (parsed.header) {
        out += parsed.header + '\n';
        out += '// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n\n';
    }
    out += serializeEntries(parsed.root.entries, 0);
    out += '\n// ************************************************************************* //\n';
    return out;
}

function serializeEntries(entries, indent) {
    let out = '';
    const pad = '    '.repeat(indent);

    for (const entry of entries) {
        if (entry.comment) {
            for (const line of entry.comment.split('\n')) {
                out += pad + line + '\n';
            }
        }

        if (entry.key === null) {
            // Verbatim (e.g. #include)
            out += pad + entry.node.raw + '\n';
            continue;
        }

        if (entry.node.type === 'dict') {
            out += pad + entry.key + '\n';
            out += pad + '{\n';
            out += serializeEntries(entry.node.entries, indent + 1);
            out += pad + '}\n\n';
        } else {
            out += pad + entry.key + '    ' + serializeValue(entry.node) + ';\n';
        }
    }
    return out;
}

function serializeValue(node) {
    switch (node.type) {
        case 'scalar':  return String(node.value);
        case 'bool':    return node.value ? 'yes' : 'no';
        case 'word':    return node.value;
        case 'string':  return '"' + node.value + '"';
        case 'vector':  return '(' + node.value.join(' ') + ')';
        case 'list':    return node.value;
        case 'verbatim': return node.raw;
        default: return '';
    }
}

// ── Form Generator ───────────────────────────────────────────────────────────

/**
 * Generate an HTML form from a parsed dictionary.
 * Returns an HTMLElement (a <div> with nested fieldsets).
 *
 * @param {object} parsed - Output of parseFoamDict()
 * @param {function} onChange - Called with (parsed) whenever a value changes
 */
export function createDictForm(parsed, onChange) {
    const container = document.createElement('div');
    container.className = 'foam-dict-form';

    buildFormEntries(container, parsed.root.entries, () => {
        if (onChange) onChange(parsed);
    });

    return container;
}

function buildFormEntries(parent, entries, onChange) {
    for (const entry of entries) {
        if (entry.key === null) continue; // skip verbatim directives

        if (entry.node.type === 'dict') {
            const card = document.createElement('div');
            card.className = 'card card-body p-2 mb-1';

            const toggle = document.createElement('div');
            toggle.className = 'fw-semibold small text-info';
            toggle.style.cursor = 'pointer';
            toggle.textContent = entry.key;
            card.appendChild(toggle);

            const inner = document.createElement('div');
            inner.className = 'mt-1';
            buildFormEntries(inner, entry.node.entries, onChange);
            card.appendChild(inner);

            toggle.addEventListener('click', () => {
                inner.style.display = inner.style.display === 'none' ? 'block' : 'none';
            });

            parent.appendChild(card);
        } else {
            const row = document.createElement('div');
            row.className = 'foam-dict-row';

            const label = document.createElement('label');
            label.className = 'foam-dict-label';
            label.textContent = entry.key;
            if (entry.comment) label.title = entry.comment;
            row.appendChild(label);

            const input = createInput(entry.node, onChange);
            row.appendChild(input);
            parent.appendChild(row);
        }
    }
}

function createInput(node, onChange) {
    switch (node.type) {
        case 'scalar': {
            const input = document.createElement('input');
            input.type = 'number';
            input.value = node.value;
            input.step = 'any';
            input.className = 'form-control form-control-sm foam-input foam-input-number';
            input.addEventListener('change', () => {
                node.value = parseFloat(input.value);
                onChange();
            });
            return input;
        }
        case 'bool': {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = node.value;
            input.className = 'form-check-input';
            input.addEventListener('change', () => {
                node.value = input.checked;
                onChange();
            });
            return input;
        }
        case 'word':
        case 'string': {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = node.value;
            input.className = 'form-control form-control-sm foam-input foam-input-text';
            input.addEventListener('change', () => {
                node.value = input.value;
                onChange();
            });
            return input;
        }
        case 'vector': {
            const container = document.createElement('span');
            container.className = 'foam-input-vector';
            node.value.forEach((v, i) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.value = v;
                input.step = 'any';
                input.className = 'form-control form-control-sm foam-input-vec-component';
                input.addEventListener('change', () => {
                    node.value[i] = parseFloat(input.value);
                    onChange();
                });
                container.appendChild(input);
            });
            return container;
        }
        case 'list':
        case 'verbatim':
        default: {
            const textarea = document.createElement('textarea');
            textarea.value = node.raw || node.value || '';
            textarea.className = 'form-control form-control-sm foam-input foam-input-raw';
            textarea.rows = Math.min(4, (textarea.value.match(/\n/g) || []).length + 1);
            textarea.addEventListener('change', () => {
                if (node.type === 'list') node.value = textarea.value;
                else node.raw = textarea.value;
                onChange();
            });
            return textarea;
        }
    }
}
