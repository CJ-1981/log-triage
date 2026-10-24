/* Log Triage — markdown.js: lightweight pure-JS Markdown parser & Mermaid diagram renderer.
 * 100% client-side, zero dependencies, offline deliverable. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign((root.LT || (root.LT = {})), factory());
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUrl(url) {
    if (!url) return '';
    const clean = String(url).trim();
    if (/^(?:javascript|data|vbscript):/i.test(clean)) {
      return '#';
    }
    return clean;
  }

  function isMarkdown(filename) {
    return !!(filename && /\.(md|markdown)$/i.test(String(filename)));
  }

  /* ---------------- Inline Markdown Parsing ---------------- */
  function parseInline(text) {
    if (!text) return '';
    // 1. Escape HTML special characters to prevent XSS
    let s = escapeHtml(text);

    // 2. Inline code: `code`
    const codeTokens = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      const idx = codeTokens.length;
      codeTokens.push('<code>' + code + '</code>');
      return '\x1aCODE' + idx + '\x1a';
    });

    // 3. Images: ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const safe = sanitizeUrl(url);
      return '<img src="' + escapeHtml(safe) + '" alt="' + escapeHtml(alt) + '" style="max-width:100%;height:auto">';
    });

    // 4. Links: [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = sanitizeUrl(url);
      return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });

    // 5. Bold & Italic & Strikethrough
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 6. Restore code tokens
    s = s.replace(/\x1aCODE(\d+)\x1a/g, (_, idx) => codeTokens[Number(idx)] || '');

    return s;
  }

  /* ---------------- Mermaid Flowchart & Sequence Renderer ---------------- */
  function renderMermaid(code) {
    try {
      const raw = String(code || '').trim();
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'));
      if (!lines.length) return '';

      const first = lines[0].toLowerCase();
      if (first.startsWith('graph') || first.startsWith('flowchart')) {
        return renderFlowchart(lines);
      }
      if (first.startsWith('sequencediagram')) {
        return renderSequenceDiagram(lines);
      }
      throw new Error('Unsupported diagram type: ' + lines[0]);
    } catch (err) {
      return '<div class="mermaid-fallback">' +
        '<div class="mermaid-warning">⚠️ Mermaid diagram could not be rendered: ' + escapeHtml(err.message) + '</div>' +
        '<pre><code>' + escapeHtml(code) + '</code></pre>' +
        '</div>';
    }
  }

  function renderFlowchart(lines) {
    const dirMatch = lines[0].match(/^(?:graph|flowchart)\s+([A-Za-z]+)/i);
    const dir = dirMatch ? dirMatch[1].toUpperCase() : 'TD';
    const isLR = dir === 'LR' || dir === 'RL';

    const nodes = new Map();
    const edges = [];

    function ensureNode(id, label, shape) {
      const cleanId = id.trim();
      if (!nodes.has(cleanId)) {
        nodes.set(cleanId, { id: cleanId, label: label || cleanId, shape: shape || 'rect' });
      } else {
        const cur = nodes.get(cleanId);
        if (label && cur.label === cur.id) cur.label = label;
        if (shape) cur.shape = shape;
      }
      return nodes.get(cleanId);
    }

    // Parse node with possible shape:
    // A([stadium]), A[(cylinder)], A((circle)), A{decision}, A(rounded), A[box], A
    function parseNodeSpec(str) {
      const s = str.trim();
      // stadium A([text])
      let m = s.match(/^([A-Za-z0-9_-]+)\(\[([^\]]+)\]\)$/);
      if (m) return ensureNode(m[1], m[2], 'stadium');
      // cylinder A[(text)]
      m = s.match(/^([A-Za-z0-9_-]+)\[\(([^)]+)\)\]$/);
      if (m) return ensureNode(m[1], m[2], 'cylinder');
      // circle A((text))
      m = s.match(/^([A-Za-z0-9_-]+)\(\(([^)]+)\)\)$/);
      if (m) return ensureNode(m[1], m[2], 'circle');
      // decision A{text}
      m = s.match(/^([A-Za-z0-9_-]+)\{([^}]+)\}$/);
      if (m) return ensureNode(m[1], m[2], 'decision');
      // rounded A(text)
      m = s.match(/^([A-Za-z0-9_-]+)\(([^)]+)\)$/);
      if (m) return ensureNode(m[1], m[2], 'rounded');
      // rect A[text]
      m = s.match(/^([A-Za-z0-9_-]+)\[([^\]]+)\]$/);
      if (m) return ensureNode(m[1], m[2], 'rect');
      // plain id
      m = s.match(/^([A-Za-z0-9_-]+)$/);
      if (m) return ensureNode(m[1], m[1], 'rect');
      return null;
    }

    // Regex for edge with optional label:
    // e.g. A --> B, A -->|label| B, A -- label --> B, A --- B, A -.-> B, A ==> B
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Match: LeftPart (-->|label| | -- label --> | --> | --- | -.-> | ==>) RightPart
      const connRegex = /^(.*?)\s*(?:(-->|---|-.->|==>)\s*\|([^|]+)\||--\s*([^-]+?)\s*-->|(-->|---|-.->|==>))\s*(.*)$/;
      const m = line.match(connRegex);
      if (m) {
        const left = parseNodeSpec(m[1]);
        const edgeType = m[2] || m[5] || '-->';
        const edgeLabel = (m[3] || m[4] || '').trim();
        const right = parseNodeSpec(m[6]);
        if (left && right) {
          edges.push({ from: left.id, to: right.id, type: edgeType, label: edgeLabel });
        }
      } else {
        // Maybe single node definition on line
        parseNodeSpec(line);
      }
    }

    if (nodes.size === 0) {
      throw new Error('No nodes found in flowchart');
    }

    // Layering / Ranking
    const inDegree = new Map();
    nodes.forEach((_, id) => inDegree.set(id, 0));
    edges.forEach((e) => {
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    });

    const ranks = new Map();
    nodes.forEach((_, id) => {
      if (inDegree.get(id) === 0) ranks.set(id, 0);
    });
    // Assign ranks through edges
    let changed = true;
    let maxIter = 100;
    while (changed && maxIter-- > 0) {
      changed = false;
      edges.forEach((e) => {
        const fromRank = ranks.has(e.from) ? ranks.get(e.from) : 0;
        const toRank = ranks.has(e.to) ? ranks.get(e.to) : 0;
        if (toRank <= fromRank) {
          ranks.set(e.to, fromRank + 1);
          changed = true;
        }
      });
    }
    // Any unranked nodes placed at rank 0
    nodes.forEach((_, id) => {
      if (!ranks.has(id)) ranks.set(id, 0);
    });

    // Group by rank
    const layers = [];
    ranks.forEach((rank, id) => {
      if (!layers[rank]) layers[rank] = [];
      layers[rank].push(id);
    });

    // Layout coordinates
    const NODE_W = 120;
    const NODE_H = 40;
    const GAP_X = 40;
    const GAP_Y = 60;
    const PAD = 30;

    const coords = new Map();
    let totalW = 0, totalH = 0;

    if (!isLR) {
      // Top-Down
      let maxLayerW = 0;
      layers.forEach((layer) => {
        const layerW = layer.length * NODE_W + (layer.length - 1) * GAP_X;
        if (layerW > maxLayerW) maxLayerW = layerW;
      });
      totalW = Math.max(300, maxLayerW + PAD * 2);
      totalH = layers.length * NODE_H + (layers.length - 1) * GAP_Y + PAD * 2;

      layers.forEach((layer, layerIdx) => {
        const layerW = layer.length * NODE_W + (layer.length - 1) * GAP_X;
        const startX = (totalW - layerW) / 2;
        const y = PAD + layerIdx * (NODE_H + GAP_Y);
        layer.forEach((id, nodeIdx) => {
          const x = startX + nodeIdx * (NODE_W + GAP_X);
          coords.set(id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
        });
      });
    } else {
      // Left-to-Right
      let maxLayerH = 0;
      layers.forEach((layer) => {
        const layerH = layer.length * NODE_H + (layer.length - 1) * GAP_Y;
        if (layerH > maxLayerH) maxLayerH = layerH;
      });
      totalW = layers.length * NODE_W + (layers.length - 1) * GAP_X + PAD * 2;
      totalH = Math.max(200, maxLayerH + PAD * 2);

      layers.forEach((layer, layerIdx) => {
        const layerH = layer.length * NODE_H + (layer.length - 1) * GAP_Y;
        const startY = (totalH - layerH) / 2;
        const x = PAD + layerIdx * (NODE_W + GAP_X);
        layer.forEach((id, nodeIdx) => {
          const y = startY + nodeIdx * (NODE_H + GAP_Y);
          coords.set(id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
        });
      });
    }

    // Build SVG
    const svgParts = [];
    svgParts.push('<svg class="mermaid-diagram" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" xmlns="http://www.w3.org/2000/svg">');
    svgParts.push('<defs>');
    svgParts.push('<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">');
    svgParts.push('<path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent, #61afef)"/>');
    svgParts.push('</marker>');
    svgParts.push('</defs>');

    // Draw Edges
    edges.forEach((e) => {
      const from = coords.get(e.from);
      const to = coords.get(e.to);
      if (!from || !to) return;

      let startX = from.cx, startY = from.cy;
      let endX = to.cx, endY = to.cy;

      if (!isLR) {
        startY = from.y + NODE_H;
        endY = to.y;
      } else {
        startX = from.x + NODE_W;
        endX = to.x;
      }

      const isDotted = e.type.includes('.');
      const isThick = e.type.includes('=');
      const hasArrow = e.type.includes('>');

      const strokeWidth = isThick ? '3' : '2';
      const dash = isDotted ? ' stroke-dasharray="4 3"' : '';
      const marker = hasArrow ? ' marker-end="url(#arrow)"' : '';

      svgParts.push('<path d="M ' + startX + ' ' + startY + ' L ' + endX + ' ' + endY + '" stroke="var(--accent, #61afef)" stroke-width="' + strokeWidth + '"' + dash + marker + ' fill="none"/>');

      if (e.label) {
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        const textW = e.label.length * 8 + 8;
        svgParts.push('<rect x="' + (midX - textW / 2) + '" y="' + (midY - 10) + '" width="' + textW + '" height="18" rx="3" fill="var(--card, #21252b)" stroke="var(--border, #3e4451)"/>');
        svgParts.push('<text x="' + midX + '" y="' + midY + '" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #abb2bf)" font-size="11" font-family="sans-serif">' + escapeHtml(e.label) + '</text>');
      }
    });

    // Draw Nodes
    nodes.forEach((node) => {
      const pos = coords.get(node.id);
      if (!pos) return;
      const x = pos.x, y = pos.y;
      const cx = pos.cx, cy = pos.cy;

      if (node.shape === 'decision') {
        const pts = cx + ',' + y + ' ' + (x + NODE_W) + ',' + cy + ' ' + cx + ',' + (y + NODE_H) + ' ' + x + ',' + cy;
        svgParts.push('<polygon points="' + pts + '" fill="var(--card, #282c34)" stroke="var(--warn, #e5c07b)" stroke-width="2"/>');
      } else if (node.shape === 'circle') {
        const r = NODE_H / 2;
        svgParts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--card, #282c34)" stroke="var(--success, #98c379)" stroke-width="2"/>');
      } else if (node.shape === 'rounded' || node.shape === 'stadium') {
        const rx = node.shape === 'stadium' ? NODE_H / 2 : 8;
        svgParts.push('<rect x="' + x + '" y="' + y + '" width="' + NODE_W + '" height="' + NODE_H + '" rx="' + rx + '" fill="var(--card, #282c34)" stroke="var(--accent, #61afef)" stroke-width="2"/>');
      } else {
        // default rect
        svgParts.push('<rect x="' + x + '" y="' + y + '" width="' + NODE_W + '" height="' + NODE_H + '" rx="4" fill="var(--card, #282c34)" stroke="var(--accent, #61afef)" stroke-width="2"/>');
      }

      svgParts.push('<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #abb2bf)" font-family="sans-serif" font-size="12" font-weight="500">' + escapeHtml(node.label) + '</text>');
    });

    svgParts.push('</svg>');
    return svgParts.join('');
  }

  function renderSequenceDiagram(lines) {
    const participants = [];
    const partMap = new Set();
    const messages = [];

    function addParticipant(name) {
      const clean = name.trim();
      if (!partMap.has(clean)) {
        partMap.add(clean);
        participants.push(clean);
      }
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // participant / actor definition: participant Alice
      const pMatch = line.match(/^(?:participant|actor)\s+([A-Za-z0-9_-]+)/i);
      if (pMatch) {
        addParticipant(pMatch[1]);
        continue;
      }
      // message: A->>B: text or A-->>B: text or A->B: text or A-->B: text
      const msgMatch = line.match(/^([A-Za-z0-9_-]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (msgMatch) {
        addParticipant(msgMatch[1]);
        addParticipant(msgMatch[3]);
        messages.push({
          from: msgMatch[1],
          type: msgMatch[2],
          to: msgMatch[3],
          text: msgMatch[4].trim(),
        });
      }
    }

    if (!participants.length) {
      throw new Error('No participants found in sequence diagram');
    }

    const BOX_W = 100;
    const BOX_H = 34;
    const COL_GAP = 70;
    const MSG_H = 44;
    const PAD = 24;

    const totalW = Math.max(340, PAD * 2 + participants.length * BOX_W + (participants.length - 1) * COL_GAP);
    const totalH = PAD * 2 + BOX_H * 2 + messages.length * MSG_H + 40;

    const xCoords = new Map();
    participants.forEach((name, idx) => {
      const x = PAD + idx * (BOX_W + COL_GAP) + BOX_W / 2;
      xCoords.set(name, x);
    });

    const svgParts = [];
    svgParts.push('<svg class="mermaid-diagram" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" xmlns="http://www.w3.org/2000/svg">');
    svgParts.push('<defs>');
    svgParts.push('<marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">');
    svgParts.push('<path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent, #61afef)"/>');
    svgParts.push('</marker>');
    svgParts.push('</defs>');

    // Vertical Lifelines & Header Boxes
    const topBoxY = PAD;
    const bottomBoxY = totalH - PAD - BOX_H;
    participants.forEach((name) => {
      const cx = xCoords.get(name);
      // Lifeline
      svgParts.push('<line x1="' + cx + '" y1="' + (topBoxY + BOX_H) + '" x2="' + cx + '" y2="' + bottomBoxY + '" stroke="var(--border, #3e4451)" stroke-width="1.5" stroke-dasharray="4 4"/>');

      // Top box
      svgParts.push('<rect x="' + (cx - BOX_W / 2) + '" y="' + topBoxY + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="4" fill="var(--card, #282c34)" stroke="var(--accent, #61afef)" stroke-width="2"/>');
      svgParts.push('<text x="' + cx + '" y="' + (topBoxY + BOX_H / 2) + '" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #abb2bf)" font-family="sans-serif" font-size="12" font-weight="600">' + escapeHtml(name) + '</text>');

      // Bottom box
      svgParts.push('<rect x="' + (cx - BOX_W / 2) + '" y="' + bottomBoxY + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="4" fill="var(--card, #282c34)" stroke="var(--accent, #61afef)" stroke-width="2"/>');
      svgParts.push('<text x="' + cx + '" y="' + (bottomBoxY + BOX_H / 2) + '" text-anchor="middle" dominant-baseline="central" fill="var(--fg, #abb2bf)" font-family="sans-serif" font-size="12" font-weight="600">' + escapeHtml(name) + '</text>');
    });

    // Messages
    messages.forEach((msg, idx) => {
      const fromX = xCoords.get(msg.from);
      const toX = xCoords.get(msg.to);
      if (fromX === undefined || toX === undefined) return;

      const y = topBoxY + BOX_H + 30 + idx * MSG_H;
      const isDashed = msg.type.includes('--');
      const hasArrow = msg.type.includes('>');
      const dash = isDashed ? ' stroke-dasharray="4 3"' : '';
      const marker = hasArrow ? ' marker-end="url(#seq-arrow)"' : '';

      svgParts.push('<line x1="' + fromX + '" y1="' + y + '" x2="' + toX + '" y2="' + y + '" stroke="var(--accent, #61afef)" stroke-width="1.5"' + dash + marker + '/>');

      const midX = (fromX + toX) / 2;
      svgParts.push('<text x="' + midX + '" y="' + (y - 8) + '" text-anchor="middle" fill="var(--fg, #abb2bf)" font-family="sans-serif" font-size="11">' + escapeHtml(msg.text) + '</text>');
    });

    svgParts.push('</svg>');
    return svgParts.join('');
  }

  /* ---------------- Full Markdown Document Parser ---------------- */
  function renderMarkdown(mdText) {
    if (!mdText) return '';
    const lines = String(mdText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // 1. Fenced Code Block: ``` or ~~~
      const fenceMatch = line.match(/^(\s*)(```|~~~)(.*)$/);
      if (fenceMatch) {
        const fence = fenceMatch[2];
        const lang = (fenceMatch[3] || '').trim().toLowerCase();
        const codeLines = [];
        i++;
        while (i < lines.length) {
          if (lines[i].trim().startsWith(fence)) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        const codeText = codeLines.join('\n');
        if (lang === 'mermaid') {
          out.push('<div class="mermaid-container">' + renderMermaid(codeText) + '</div>');
        } else {
          const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
          out.push('<pre><code' + cls + '>' + escapeHtml(codeText) + '</code></pre>');
        }
        continue;
      }

      // 2. Headings: # H1, ## H2 ...
      const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const lvl = hMatch[1].length;
        out.push('<h' + lvl + '>' + parseInline(hMatch[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // 3. Horizontal Rule: ---, ***, ___
      if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // 4. Blockquotes: > text
      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderMarkdown(quoteLines.join('\n')) + '</blockquote>');
        continue;
      }

      // 5. Tables: | Header | Header |
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[-\s:|]+\|?\s*$/.test(lines[i + 1])) {
        const tableLines = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim().length > 0) {
          tableLines.push(lines[i]);
          i++;
        }
        out.push(renderTable(tableLines));
        continue;
      }

      // 6. Unordered & Task Lists: - item, * item, + item
      const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
      if (ulMatch) {
        out.push('<ul>');
        while (i < lines.length) {
          const itemMatch = lines[i].match(/^(\s*)([-*+])\s+(.*)$/);
          if (!itemMatch) break;
          let content = itemMatch[3];
          const taskMatch = content.match(/^\[([ xX])\]\s*(.*)$/);
          if (taskMatch) {
            const checked = taskMatch[1].toLowerCase() === 'x' ? ' checked' : '';
            out.push('<li class="task-list-item"><input type="checkbox"' + checked + ' disabled> ' + parseInline(taskMatch[2]) + '</li>');
          } else {
            out.push('<li>' + parseInline(content) + '</li>');
          }
          i++;
        }
        out.push('</ul>');
        continue;
      }

      // 7. Ordered Lists: 1. item
      const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (olMatch) {
        out.push('<ol>');
        while (i < lines.length) {
          const itemMatch = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
          if (!itemMatch) break;
          out.push('<li>' + parseInline(itemMatch[3]) + '</li>');
          i++;
        }
        out.push('</ol>');
        continue;
      }

      // 8. Blank lines
      if (!line.trim()) {
        i++;
        continue;
      }

      // 9. Regular Paragraphs
      const pLines = [];
      while (i < lines.length && lines[i].trim() &&
             !lines[i].match(/^(\s*)(```|~~~)/) &&
             !lines[i].match(/^#{1,6}\s+/) &&
             !lines[i].match(/^>\s?/) &&
             !lines[i].match(/^(\s*)([-*+]|\d+\.)\s+/) &&
             !/^(?:---|\*\*\*|___)\s*$/.test(lines[i])) {
        pLines.push(lines[i]);
        i++;
      }
      if (pLines.length) {
        out.push('<p>' + pLines.map(parseInline).join('<br>') + '</p>');
      }
    }

    return out.join('\n');
  }

  function renderTable(lines) {
    if (lines.length < 2) return '';
    function splitRow(row) {
      return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    }

    const headers = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map((s) => {
      const left = s.startsWith(':');
      const right = s.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });

    const html = ['<table>', '<thead>', '<tr>'];
    headers.forEach((h, idx) => {
      const align = aligns[idx] || 'left';
      const style = align !== 'left' ? ' style="text-align:' + align + '"' : '';
      html.push('<th' + style + '>' + parseInline(h) + '</th>');
    });
    html.push('</tr>', '</thead>', '<tbody>');

    for (let r = 2; r < lines.length; r++) {
      const cells = splitRow(lines[r]);
      html.push('<tr>');
      headers.forEach((_, cIdx) => {
        const val = cells[cIdx] || '';
        const align = aligns[cIdx] || 'left';
        const style = align !== 'left' ? ' style="text-align:' + align + '"' : '';
        html.push('<td' + style + '>' + parseInline(val) + '</td>');
      });
      html.push('</tr>');
    }

    html.push('</tbody>', '</table>');
    return html.join('');
  }

  return {
    escapeHtml,
    sanitizeUrl,
    isMarkdown,
    parseInline,
    renderMermaid,
    renderMarkdown,
  };
}));
