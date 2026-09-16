'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { collectFromDataTransfer } = require('../src/droptree.js');

function mockFile(name, content, type) {
  return new File([content], name, { type: type || 'text/plain' });
}
function fileEntry(file) {
  return { isFile: true, isDirectory: false, file: (res, rej) => res(file) };
}
function dirEntry(name, children) {
  // real FileSystemDirectoryReader.readEntries returns batches of <=100 and
  // must be called repeatedly until it yields an empty array
  const batches = [children.slice(0, 2), children.slice(2), []];
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => ({ readEntries: (res) => res(batches.shift() || []) }),
  };
}
function dtWithItems(entries) {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files: [],
  };
}

test('plain file drop without entries support falls back to dataTransfer.files', async () => {
  const f1 = mockFile('a.log', 'one\n');
  const dt = { items: [{ kind: 'file' }], files: [f1] };
  const { files, skipped } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files, [f1]);
  assert.strictEqual(skipped, 0);
});

test('plain file drops use dataTransfer.files even when entry.file() is poisoned', async () => {
  // Chromium can open dataTransfer.files at >260-char paths, while the
  // entries API's entry.file() throws NotFoundError there — the drop must
  // keep using the working File objects for plain files
  const working = mockFile('deep.log', 'readable via dt.files\n');
  const poisoned = {
    isFile: true, isDirectory: false, name: 'deep.log',
    file: (res, rej) => rej(new Error('A requested file or directory could not be found at the time an operation was processed.')),
  };
  const dt = {
    items: [{ kind: 'file', webkitGetAsEntry: () => poisoned }],
    files: [working],
  };
  const { files, failed, skipped } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files, [working], 'dt.files File kept verbatim');
  assert.strictEqual(failed.length, 0);
  assert.strictEqual(skipped, 0);
});

test('falls back to entry.file() when dt.files has no slot for an item', async () => {
  const f = mockFile('from-entry.log', 'entry read\n');
  const dt = {
    items: [{ kind: 'file', webkitGetAsEntry: () => fileEntry(f) }],
    files: [], // synthetic drops may carry no files list at all
  };
  const { files, failed } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files.map((x) => x.name), ['from-entry.log']);
  assert.strictEqual(failed.length, 0);
});

test('entry.file() rejection in the fallback lands in failed[]', async () => {
  const dt = {
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, file: (res, rej) => rej(new Error('NotFoundError: too deep')) }) }],
    files: [],
  };
  const { files, failed } = await collectFromDataTransfer(dt);
  assert.strictEqual(files.length, 0);
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].error, /too deep/);
});

test('an item the browser exposes neither as file nor entry is reported', async () => {
  const dt = { items: [{ kind: 'file' }], files: [] };
  const { files, failed } = await collectFromDataTransfer(dt);
  assert.strictEqual(files.length, 0);
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].error, /did not expose/);
});

test('in a mixed drop the loose file comes from dataTransfer.files slot alignment', async () => {
  const working = mockFile('loose.log', 'loose\n');
  const poisoned = {
    isFile: true, isDirectory: false, name: 'loose.log',
    file: (res, rej) => rej(new Error('NotFoundError')),
  };
  const dt = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => dirEntry('dir', [fileEntry(mockFile('in.log', 'in\n'))]) },
      { kind: 'file', webkitGetAsEntry: () => poisoned },
    ],
    files: [mockFile('folder-pseudo-entry', ''), working], // slot 0 = folder pseudo, slot 1 = the file
  };
  const { files, failed } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files.map((f) => f.name), ['loose.log', 'dir/in.log'], 'folder walked, loose file from slot 1');
  assert.strictEqual(failed.length, 0);
});

test('folder drop loads every contained file with folder-relative names', async () => {
  const dt = dtWithItems([
    dirEntry('logs', [
      fileEntry(mockFile('a.log', 'alpha\n')),
      fileEntry(mockFile('b.log', 'beta\n')),
      fileEntry(mockFile('c.log', 'gamma\n')),
      dirEntry('sub', [fileEntry(mockFile('d.log', 'delta\n'))]),
    ]),
  ]);
  const { files, skipped } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files.map((f) => f.name), ['logs/a.log', 'logs/b.log', 'logs/c.log', 'logs/sub/d.log']);
  assert.strictEqual(files[3].size, 6);
  assert.strictEqual(skipped, 0);
});

test('readEntries batching is drained until an empty batch', async () => {
  // 5 children over batches of 2: 2 + 2 + 1 + empty
  const kids = [];
  for (let i = 0; i < 5; i++) kids.push(fileEntry(mockFile('f' + i + '.log', 'x\n')));
  const dt = dtWithItems([dirEntry('d', kids)]);
  const { files } = await collectFromDataTransfer(dt);
  assert.strictEqual(files.length, 5);
  assert.deepStrictEqual(files.map((f) => f.name), ['d/f0.log', 'd/f1.log', 'd/f2.log', 'd/f3.log', 'd/f4.log']);
});

test('mixed drop of loose files and folders is fully collected', async () => {
  const loose = mockFile('top.log', 'top\n');
  const dt = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => fileEntry(loose) },
      { kind: 'file', webkitGetAsEntry: () => dirEntry('dir', [fileEntry(mockFile('in.log', 'in\n'))]) },
    ],
    files: [loose],
  };
  const { files } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files.map((f) => f.name), ['top.log', 'dir/in.log']);
});

test('maxFiles guard skips items past the cap and reports the count', async () => {
  const kids = [];
  for (let i = 0; i < 8; i++) kids.push(fileEntry(mockFile('f' + i + '.log', 'x\n')));
  const dt = dtWithItems([dirEntry('d', kids)]);
  const { files, skipped } = await collectFromDataTransfer(dt, { maxFiles: 3 });
  assert.strictEqual(files.length, 3);
  assert.strictEqual(skipped, 5);
});

test('maxDepth guard stops descending past the limit', async () => {
  const deep = fileEntry(mockFile('deep.log', 'd\n'));
  let entry = dirEntry('l0', [deep]);
  for (let i = 1; i <= 20; i++) entry = dirEntry('l' + i, [entry]);
  const dt = dtWithItems([entry]);
  const { files } = await collectFromDataTransfer(dt, { maxDepth: 5 });
  assert.strictEqual(files.length, 0, 'file beyond depth cap not collected');
});

test('empty folder yields no files without failing', async () => {
  const dt = dtWithItems([dirEntry('empty', [])]);
  const { files, skipped } = await collectFromDataTransfer(dt);
  assert.strictEqual(files.length, 0);
  assert.strictEqual(skipped, 0);
});

test('falls back to the bare file when the File constructor is unavailable', async () => {
  const theFile = mockFile('x.log', 'x\n'); // built before the constructor is patched away
  const RealFile = globalThis.File;
  globalThis.File = undefined;
  try {
    const dt = dtWithItems([dirEntry('d', [fileEntry(theFile)])]);
    const { files } = await collectFromDataTransfer(dt);
    assert.deepStrictEqual(files.map((f) => f.name), ['x.log'], 'bare file kept without prefix');
  } finally {
    globalThis.File = RealFile;
  }
});

test('an unreadable file is isolated into failed[] without killing the batch', async () => {
  const longPath = 'C:\\\\' + 'deep\\'.repeat(50) + 'gone.log';
  const bad = { isFile: true, isDirectory: false, fullPath: longPath, file: (res, rej) => rej(new Error('A requested file or directory could not be found at the time an operation was processed.')) };
  const dt = dtWithItems([dirEntry('d', [bad, fileEntry(mockFile('ok.log', 'fine\n'))])]);
  const { files, failed, skipped } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files.map((f) => f.name), ['d/ok.log'], 'readable sibling still collected');
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].error, /could not be found/);
  assert.ok(failed[0].pathLen > 250, 'fullPath length reported for the long-path hint');
  assert.strictEqual(skipped, 0);
});

test('readEntries failure on a subfolder is reported without losing other files', async () => {
  const brokenDir = {
    isFile: false, isDirectory: true, name: 'broken',
    createReader: () => ({ readEntries: (res, rej) => rej(new Error('access denied')) }),
  };
  const dt = dtWithItems([dirEntry('root', [brokenDir, fileEntry(mockFile('good.log', 'g\n'))])]);
  const { files, failed } = await collectFromDataTransfer(dt);
  assert.deepStrictEqual(files.map((f) => f.name), ['root/good.log']);
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].error, /access denied/);
});
