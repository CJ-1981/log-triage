#!/usr/bin/env node
'use strict';
/* Generates a large synthetic mixed log for streaming/performance checks.
 * Usage: node tools/genbig.mjs [targetMB] [outFile]  (defaults: 300, tests/tmp/big.log) */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetMB = Number(process.argv[2] || 300);
const out = process.argv[3] || join(root, 'tests', 'tmp', 'big.log');
mkdirSync(dirname(out), { recursive: true });

const TAGS = ['ActivityManager', 'HMI-CAN', 'GNSS', 'Netd', 'WifiService', 'Auth', 'Telematics', 'CR_OTA', 'SensorHub', 'Modem'];
const LEVELS = ['V', 'D', 'I', 'I', 'I', 'W', 'E'];
const MSGS = [
  'heartbeat ecu=gateway alive seq=<N>',
  'position fix lat=48.858<N>00, 2.294<N>00 acc=<N>m',
  'VIN read: YV4AB9CD12EF34567 from ECU gateway',
  'token refresh failed, credential rejected for driver.jung@lotus-tech.example',
  'download stalled url=https://ota.example/pkg v2.41.<N>',
  'lease 192.168.1.<N>/24 gw 192.168.1.1',
  'client 10.20.30.<N> connected, uid=1027',
  'frame <N> drawn in <N>.<N>ms',
  'FATAL EXCEPTION: main at com.lotus.hmi.MainActivity.renderCluster(MainActivity.java:<N>)',
  'ANR in com.lotus.cluster (com.lotus.cluster/.ClusterService)',
  'watchdog miss=<N> serial SN-A1B2C3D4E5F6',
  'bssid=aa:bb:cc:11:22:33 rssi=-<N>',
];

const ws = createWriteStream(out);
const start = Date.now();
let bytes = 0;
let n = 0;
const target = targetMB * 1024 * 1024;

function pick(a) { return a[(Math.random() * a.length) | 0]; }
function pad(x, w) { return String(x).padStart(w, '0'); }

write();
function write() {
  let ok = true;
  while (ok && bytes < target) {
    const sec = (n % 86400);
    // deterministic rare marker every 100k lines (stress tests jump to these)
    const rare = (n % 100000 === 9999);
    const line = `08-24 ${pad((sec / 3600 | 0) % 24, 2)}:${pad((sec / 60 | 0) % 60, 2)}:${pad(sec % 60, 2)}.${pad((n % 1000), 3)}` +
      `  ${pad(1000 + (n % 9000), 4)}  ${pad(100 + (n % 8000), 4)} ${rare ? 'W' : pick(LEVELS)} ${rare ? 'RAREMARK' : pick(TAGS)}: ` +
      (rare ? 'RAREJUMPMARKER deterministic target seq=' + n : pick(MSGS).replaceAll('<N>', String(n % 9973))) + '\n';
    n++;
    bytes += line.length;
    ok = ws.write(line);
  }
  if (bytes < target) ws.once('drain', write);
  else ws.end(() => {
    console.log(`wrote ${out}: ${(bytes / 1024 / 1024).toFixed(1)} MB, ${n} lines, ${((Date.now() - start) / 1000).toFixed(1)}s`);
  });
}
