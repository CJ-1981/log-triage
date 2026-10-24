'use strict';
/* Unit tests for src/markdown.js — Markdown parsing and pure-JS Mermaid rendering */
const test = require('node:test');
const assert = require('node:assert/strict');
const LT = require('../src/markdown.js');

test('parseMarkdown: headings H1 through H6', () => {
  const md = '# Header 1\n## Header 2\n### Header 3\n#### Header 4\n##### Header 5\n###### Header 6';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<h1>Header 1</h1>'), 'renders h1');
  assert.ok(html.includes('<h2>Header 2</h2>'), 'renders h2');
  assert.ok(html.includes('<h3>Header 3</h3>'), 'renders h3');
  assert.ok(html.includes('<h4>Header 4</h4>'), 'renders h4');
  assert.ok(html.includes('<h5>Header 5</h5>'), 'renders h5');
  assert.ok(html.includes('<h6>Header 6</h6>'), 'renders h6');
});

test('parseMarkdown: inline formatting bold, italic, code, strikethrough', () => {
  const md = 'Text with **bold** and *italic* and `inline code` and ~~deleted~~.';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<strong>bold</strong>'), 'renders bold');
  assert.ok(html.includes('<em>italic</em>'), 'renders italic');
  assert.ok(html.includes('<code>inline code</code>'), 'renders code');
  assert.ok(html.includes('<del>deleted</del>'), 'renders strikethrough');
});

test('parseMarkdown: lists unordered, ordered, and task items', () => {
  const md = '- Item A\n- Item B\n\n1. First\n2. Second\n\n- [ ] Task incomplete\n- [x] Task complete';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<ul>'), 'renders unordered list wrapper');
  assert.ok(html.includes('<li>Item A</li>'), 'renders li');
  assert.ok(html.includes('<ol>'), 'renders ordered list wrapper');
  assert.ok(html.includes('<li>First</li>'), 'renders ordered li');
  assert.ok(html.includes('type="checkbox"'), 'renders task checkbox');
  assert.ok(html.includes('checked'), 'renders checked task');
});

test('parseMarkdown: blockquotes and horizontal rules', () => {
  const md = '> This is a quote\n\n---\n\nRegular text';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<blockquote>'), 'renders blockquote');
  assert.ok(html.includes('This is a quote'), 'renders quote content');
  assert.ok(html.includes('<hr'), 'renders hr');
});

test('parseMarkdown: GFM table', () => {
  const md = '| Name | Role |\n|---|---|\n| Alice | Admin |\n| Bob | User |';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<table>'), 'renders table');
  assert.ok(html.includes('<th>Name</th>'), 'renders th');
  assert.ok(html.includes('<td>Alice</td>'), 'renders td');
  assert.ok(html.includes('<td>User</td>'), 'renders second row td');
});

test('parseMarkdown: code blocks with language', () => {
  const md = '```javascript\nconst x = 42;\nconsole.log(x);\n```';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<pre><code class="language-javascript">'), 'renders pre code with class');
  assert.ok(html.includes('const x = 42;'), 'contains code');
});

test('parseMarkdown: XSS sanitization of unsafe HTML and links', () => {
  const md = '<script>alert("xss")</script>\n[click me](javascript:alert(1))\n<img src="x" onerror="alert(1)">';
  const html = LT.renderMarkdown(md);
  assert.ok(!html.includes('<script>alert'), 'scripts must be escaped or stripped');
  assert.ok(!html.includes('href="javascript:'), 'javascript links must be blocked');
  assert.ok(!html.includes('onerror="alert(1)"'), 'inline event handlers neutralized');
});

test('renderMermaid: flowchart graph TD and LR renders SVG', () => {
  const mermaidTD = 'graph TD\n  A[Start] --> B(Process)\n  B --> C{Decision}\n  C --> D[End]';
  const svg = LT.renderMermaid(mermaidTD);
  assert.ok(svg.includes('<svg'), 'flowchart output is an SVG');
  assert.ok(svg.includes('Start'), 'contains Start node label');
  assert.ok(svg.includes('Process'), 'contains Process node label');
  assert.ok(svg.includes('Decision'), 'contains Decision node label');
  assert.ok(svg.includes('End'), 'contains End node label');
  assert.ok(svg.includes('class="mermaid-diagram"'), 'carries diagram class');

  const mermaidLR = 'flowchart LR\n  Step1 --> Step2';
  const svgLR = LT.renderMermaid(mermaidLR);
  assert.ok(svgLR.includes('<svg'), 'LR flowchart produces SVG');
  assert.ok(svgLR.includes('Step1'), 'contains Step1');
  assert.ok(svgLR.includes('Step2'), 'contains Step2');
});

test('renderMermaid: sequence diagram renders participants and messages in SVG', () => {
  const seq = 'sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice';
  const svg = LT.renderMermaid(seq);
  assert.ok(svg.includes('<svg'), 'sequence diagram output is an SVG');
  assert.ok(svg.includes('Alice'), 'contains participant Alice');
  assert.ok(svg.includes('Bob'), 'contains participant Bob');
  assert.ok(svg.includes('Hello Bob'), 'contains message label');
  assert.ok(svg.includes('Hi Alice'), 'contains response label');
});

test('renderMermaid: malformed syntax returns readable fallback without throwing', () => {
  const malformed = 'mermaid\n??? this is not valid syntax !!!';
  let svg = '';
  assert.doesNotThrow(() => {
    svg = LT.renderMermaid(malformed);
  });
  assert.ok(svg.includes('mermaid-fallback') || svg.includes('mermaid-warning'), 'contains fallback notice');
  assert.ok(svg.includes('this is not valid syntax'), 'displays input text');
});

test('renderMarkdown: integrated markdown with embedded mermaid block', () => {
  const md = '# Document\n\nIntroduction paragraph.\n\n```mermaid\ngraph TD\n  Client --> Server\n```\n\nConclusion.';
  const html = LT.renderMarkdown(md);
  assert.ok(html.includes('<h1>Document</h1>'), 'renders heading');
  assert.ok(html.includes('<p>Introduction paragraph.</p>'), 'renders paragraph');
  assert.ok(html.includes('<svg') && html.includes('Client') && html.includes('Server'), 'renders embedded mermaid SVG');
  assert.ok(html.includes('<p>Conclusion.</p>'), 'renders conclusion paragraph');
});

test('isMarkdown: identifies .md and .markdown files', () => {
  assert.equal(LT.isMarkdown('test.md'), true);
  assert.equal(LT.isMarkdown('path/to/doc.markdown'), true);
  assert.equal(LT.isMarkdown('UPPER.MD'), true);
  assert.equal(LT.isMarkdown('app.log'), false);
  assert.equal(LT.isMarkdown('file.txt'), false);
  assert.equal(LT.isMarkdown(''), false);
  assert.equal(LT.isMarkdown(null), false);
});

test('edge cases: empty and null inputs', () => {
  assert.equal(LT.renderMarkdown(''), '');
  assert.equal(LT.renderMarkdown(null), '');
  assert.equal(LT.parseInline(''), '');
  assert.equal(LT.parseInline(null), '');
  assert.equal(LT.renderMermaid(''), '');
  assert.equal(LT.renderMermaid('  \n%% only comments\n'), '');
  assert.equal(LT.sanitizeUrl(''), '');
  assert.equal(LT.sanitizeUrl(null), '');
  assert.equal(LT.sanitizeUrl('https://valid.com'), 'https://valid.com');
  assert.equal(LT.sanitizeUrl('data:text/html,bad'), '#');
});

test('renderMermaid: all flowchart shapes and edge types', () => {
  const code = `graph TD
    A([stadium]) -->|link 1| B[(database)]
    B --- C((circle))
    C -.-> D(rounded)
    D ==> E{decision}
    E -- label 2 --> A`;
  const svg = LT.renderMermaid(code);
  assert.ok(svg.includes('<svg'), 'generates SVG');
  assert.ok(svg.includes('stadium'), 'contains stadium node');
  assert.ok(svg.includes('database'), 'contains cylinder node');
  assert.ok(svg.includes('circle'), 'contains circle node');
  assert.ok(svg.includes('rounded'), 'contains rounded node');
  assert.ok(svg.includes('decision'), 'contains decision node');
  assert.ok(svg.includes('link 1'), 'contains link 1 label');
  assert.ok(svg.includes('label 2'), 'contains label 2 label');
});

test('renderMermaid: sequence diagram actor and all line types', () => {
  const code = `sequenceDiagram
    actor User
    participant System
    User->System: sync request
    System-->User: sync response
    User->>System: async request
    System-->>User: async response`;
  const svg = LT.renderMermaid(code);
  assert.ok(svg.includes('<svg'), 'generates SVG');
  assert.ok(svg.includes('User'), 'contains actor User');
  assert.ok(svg.includes('System'), 'contains participant System');
  assert.ok(svg.includes('sync request'), 'contains sync request');
  assert.ok(svg.includes('async response'), 'contains async response');
});

test('renderMermaid: empty diagrams and standalone nodes', () => {
  const fallbackEmpty = LT.renderMermaid('graph TD\n');
  assert.ok(fallbackEmpty.includes('mermaid-fallback'), 'handles empty graph');

  const fallbackSeq = LT.renderMermaid('sequenceDiagram\n');
  assert.ok(fallbackSeq.includes('mermaid-fallback'), 'handles empty sequenceDiagram');

  const solo = LT.renderMermaid('graph TD\n  SoloNode[Standalone]');
  assert.ok(solo.includes('Standalone'), 'renders standalone node');

  const lrShapes = LT.renderMermaid('graph LR\n  A([Pill]) --> B(Round) --> C{Diamond} --> D((Circle))');
  assert.ok(lrShapes.includes('<svg'), 'renders LR with multiple shapes');
});

