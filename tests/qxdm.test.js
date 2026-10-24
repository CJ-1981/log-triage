'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFormat } = require('../src/detect.js');
const { parseLine } = require('../src/parser.js');

test('QXDM autodetection with standard packets', () => {
  const lines = [
    '19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message',
    '19:28:12.512  [MSG]  0x133C  [0x0000] 3GPP_NAS / HIGH / NAS_MM: [nas_emm_proc.c Line 432] EMM State: EMM-REGISTERED (0x02)',
    '19:28:13.001  [EV]   0x038A  LTE_RRC_STATE_CHANGE',
  ];
  const res = detectFormat(lines);
  assert.equal(res.format, 'qxdm');
  assert.ok(res.confidence >= 0.5);
});

test('QXDM autodetection with comment header and indented continuation lines', () => {
  const lines = [
    '%MOBILE PARSED MESSAGE FILE',
    '%QCAT VERSION : QCAT 06.05.00',
    '%LOG FILE NAME : C:\\QXDM_Logs\\Sample_Capture.isf',
    '19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message',
    '    Protocol Discriminator: LTE RRC (3)',
    '    Message Type: DL-DCCH-Message',
    '    value c1ému:',
    '19:28:13.001  [EV]   0x038A  LTE_RRC_STATE_CHANGE',
  ];
  const res = detectFormat(lines);
  assert.equal(res.format, 'qxdm');
  assert.ok(res.confidence >= 0.5);
});

test('QXDM autodetection with date-bearing timestamps', () => {
  const lines1 = [
    '2024 Oct 24  19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message',
    '2024 Oct 24  19:28:13.001  [EV]   0x038A  LTE_RRC_STATE_CHANGE',
  ];
  assert.equal(detectFormat(lines1).format, 'qxdm');

  const lines2 = [
    '2024-10-24 19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message',
    '2024-10-24 19:28:13.001  [EV]   0x038A  LTE_RRC_STATE_CHANGE',
  ];
  assert.equal(detectFormat(lines2).format, 'qxdm');
});

test('QXDM parser: standard [LOG] packet', () => {
  const line = '19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message';
  const rec = parseLine(line, 'qxdm');
  assert.equal(rec.ts, '01-01 19:28:12.345');
  assert.equal(rec.level, 'I');
  assert.equal(rec.tag, '0x11AB');
  assert.equal(rec.msg, 'LTE RRC OTA Message');
});

test('QXDM parser: date-bearing timestamps normalize to MM-DD', () => {
  const lineMon = '2024 Oct 24  19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message';
  const recMon = parseLine(lineMon, 'qxdm');
  assert.equal(recMon.ts, '10-24 19:28:12.345');
  assert.equal(recMon.level, 'I');
  assert.equal(recMon.tag, '0x11AB');
  assert.equal(recMon.msg, 'LTE RRC OTA Message');

  const lineIso = '2024-10-24 19:28:12.345  [LOG]  0x11AB  LTE RRC OTA Message';
  const recIso = parseLine(lineIso, 'qxdm');
  assert.equal(recIso.ts, '10-24 19:28:12.345');
});

test('QXDM parser: [MSG] severity mapping', () => {
  const lineHigh = '19:28:12.512  [MSG]  0x133C  [0x0000] 3GPP_NAS / HIGH / NAS_MM: [nas_emm_proc.c Line 432] EMM State: EMM-REGISTERED';
  const recHigh = parseLine(lineHigh, 'qxdm');
  assert.equal(recHigh.level, 'W');
  assert.equal(recHigh.tag, '0x133C');

  const lineErr = '19:28:12.512  [MSG]  0x133C  [0x0000] 3GPP_NAS / ERROR / NAS_MM: auth failed';
  assert.equal(parseLine(lineErr, 'qxdm').level, 'E');

  const lineFatal = '19:28:12.512  [MSG]  0x133C  [0x0000] 3GPP_NAS / FATAL / panic';
  assert.equal(parseLine(lineFatal, 'qxdm').level, 'F');

  const lineLow = '19:28:12.512  [MSG]  0x133C  [0x0000] 3GPP_NAS / LOW / details';
  assert.equal(parseLine(lineLow, 'qxdm').level, 'D');

  const lineMed = '19:28:12.512  [MSG]  0x133C  [0x0000] 3GPP_NAS / MED / normal info';
  assert.equal(parseLine(lineMed, 'qxdm').level, 'I');

  const lineNoSev = '19:28:12.512  [MSG]  0x133C  plain status print without severity';
  assert.equal(parseLine(lineNoSev, 'qxdm').level, 'I');
});

test('QXDM parser: [EV] event line', () => {
  const line = '19:28:13.001  [EV]   0x038A  LTE_RRC_STATE_CHANGE';
  const rec = parseLine(line, 'qxdm');
  assert.equal(rec.ts, '01-01 19:28:13.001');
  assert.equal(rec.level, 'I');
  assert.equal(rec.tag, '0x038A');
  assert.equal(rec.msg, 'LTE_RRC_STATE_CHANGE');

  const lineFail = '19:28:13.001  [EVENT] 0x038A LTE_RRC_RADIO_LINK_FAILURE';
  const recFail = parseLine(lineFail, 'qxdm');
  assert.equal(recFail.level, 'E');
  assert.equal(recFail.tag, '0x038A');
});

test('QXDM parser: continuation and comment lines', () => {
  const comment = '%MOBILE PARSED MESSAGE FILE';
  const recComment = parseLine(comment, 'qxdm');
  assert.equal(recComment.ts, null);
  assert.equal(recComment.level, null);
  assert.equal(recComment.msg, comment);

  const tree = '    Protocol Discriminator: LTE RRC (3)';
  const recTree = parseLine(tree, 'qxdm');
  assert.equal(recTree.ts, null);
  assert.equal(recTree.level, null);
  assert.equal(recTree.msg, tree);
});

test('QXDM parser: packet code without bracket prefix', () => {
  const line = '19:28:12.345 [MSG] [HIGH] [rrc.c:120] RRC Connection Request';
  const rec = parseLine(line, 'qxdm');
  assert.equal(rec.ts, '01-01 19:28:12.345');
  assert.equal(rec.level, 'W');
  assert.equal(rec.tag, 'MSG');
  assert.equal(rec.msg, '[HIGH] [rrc.c:120] RRC Connection Request');
});
