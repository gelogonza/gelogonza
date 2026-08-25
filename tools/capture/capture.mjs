#!/usr/bin/env node
// Records project demos and encodes them as animated WebP for the README.
//
// Animated WebP, specifically: GitHub's markdown sanitizer strips <video>
// outright and renders an .mp4 image URL as a broken image, so neither
// survives in a README. WebP passes through as a plain <img>, autoplays,
// and loops -- at roughly a quarter of GIF's size for this kind of content.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

// Loaded lazily so `--check` works with nothing installed: it only reads files,
// which is what lets CI run it without a browser or ffmpeg on the runner.
let _ffmpegPath, _chromium;
const ffmpeg = async () => (_ffmpegPath ??= (await import('ffmpeg-static')).default);
const browserEngine = async () => (_chromium ??= (await import('playwright-core')).chromium);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const assetsDir = path.join(repoRoot, 'assets');
const targets = JSON.parse(fs.readFileSync(path.join(here, 'targets.json'), 'utf8'));

const ff = async (args) => run(await ffmpeg(), ['-hide_banner', '-loglevel', 'error', ...args]);
const kb = (f) => Math.round(fs.statSync(f).size / 1024);

// ---------------------------------------------------------------- synthetic input
// Real media is never committed: a track or a camera feed would bloat the repo
// (and redistribute someone else's audio). These stand in well enough to drive
// an audio- or motion-reactive visual.
async function synthAudio(out, seconds) {
  // four-on-the-floor kick + offbeat noise, enough transient content for an FFT
  const kick = 'sine=frequency=55:duration=' + seconds + ',tremolo=f=2:d=0.9';
  const hats = 'anoisesrc=duration=' + seconds + ':color=violet:amplitude=0.35,tremolo=f=8:d=0.95';
  const bass = 'sine=frequency=110:duration=' + seconds + ',tremolo=f=1:d=0.6';
  await ff(['-f', 'lavfi', '-i', kick, '-f', 'lavfi', '-i', hats, '-f', 'lavfi', '-i', bass,
    '-filter_complex', '[0][1][2]amix=inputs=3:weights=1.4 0.6 1.0,loudnorm=I=-9:TP=-0.5,volume=2.5',
    '-ac', '2', '-ar', '48000', '-acodec', 'pcm_s16le', out, '-y']);
  return out;
}

async function synthCamera(out, seconds) {
  // large flowing blobs -- a motion tracker latches onto these like a moving body
  await ff(['-f', 'lavfi', '-i',
    'life=size=80x60:mold=10:rate=25:ratio=0.15:death_color=#003844:life_color=#ffffff,scale=640:480,gblur=sigma=6',
    '-t', String(seconds), '-pix_fmt', 'yuv420p', out, '-y']);
  return out;
}

// ---------------------------------------------------------------- recording
async function record(t, tmp) {
  const [width, height] = t.viewport ?? [1000, 625];
  const args = ['--autoplay-policy=no-user-gesture-required'];
  const permissions = t.permissions ?? [];

  if (t.fakeAudio) {
    args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
    const wav = t.fakeAudio.file ?? await synthAudio(path.join(tmp, 'mic.wav'), t.fakeAudio.seconds ?? 30);
    args.push(`--use-file-for-fake-audio-capture=${wav}%noloop`);
  }
  if (t.fakeCamera) {
    if (!t.fakeAudio) args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
    const y4m = t.fakeCamera.file ?? await synthCamera(path.join(tmp, 'cam.y4m'), t.fakeCamera.seconds ?? 20);
    args.push(`--use-file-for-fake-video-capture=${y4m}`);
  }

  const browser = await (await browserEngine()).launch({ channel: 'chrome', args });
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, permissions,
    recordVideo: { dir: tmp, size: { width, height } },
  });
  const page = await ctx.newPage();
  await page.goto(t.source.url, { waitUntil: 'load' });

  // Boot sequences and shader warm-up mean "load" is not "ready". Wait for a
  // real signal when the target names one; otherwise fall back to settle time.
  if (t.readyWhen) await page.waitForSelector(t.readyWhen, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(t.settle ?? 3000);

  for (const step of t.steps ?? []) {
    try {
      if (step.wait) await page.waitForTimeout(step.wait);
      else if (step.key) await page.keyboard.press(step.key);
      else if (step.clickText) {
        await page.getByText(step.clickText, { exact: false }).first().click({ timeout: 6000 });
      } else if (step.click) {
        await page.locator(step.click).first().click({ timeout: 6000 });
      } else if (step.drag) {
        const box = await page.locator(step.drag.selector).first().boundingBox();
        if (!box) throw new Error(`no box for ${step.drag.selector}`);
        const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
        const { dx = -180, dy = 60, steps: n = 30 } = step.drag;
        await page.mouse.move(sx, sy); await page.mouse.down();
        for (let i = 1; i <= n; i++) {
          await page.mouse.move(sx + (dx * i) / n, sy + (dy * i) / n + Math.sin(i / 6) * 10, { steps: 1 });
          await page.waitForTimeout(20);
        }
        await page.mouse.up();
      }
    } catch (err) {
      console.warn(`  ! step failed (${JSON.stringify(step)}): ${err.message.split('\n')[0]}`);
    }
  }

  await page.waitForTimeout(t.tail ?? 1500);
  await ctx.close();
  await browser.close();
  const file = fs.readdirSync(tmp).find((f) => f.endsWith('.webm'));
  if (!file) throw new Error('playwright produced no recording');
  return path.join(tmp, file);
}

// ---------------------------------------------------------------- encoding
async function encode(src, t, tmp, out) {
  const { width = 560, fps = 12, quality = 45 } = t.encode ?? {};
  const vf = `fps=${fps},scale=${width}:-2`;
  const segments = t.segments ?? [t.clip ?? { start: 0, duration: 5 }];

  let joined;
  if (segments.length === 1) {
    joined = path.join(tmp, 'cut.mp4');
    await ff(['-ss', String(segments[0].start), '-t', String(segments[0].duration), '-i', src,
      '-an', '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', joined, '-y']);
  } else {
    const parts = [];
    for (const [i, s] of segments.entries()) {
      const p = path.join(tmp, `seg${i}.mp4`);
      await ff(['-ss', String(s.start), '-t', String(s.duration), '-i', src,
        '-an', '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', p, '-y']);
      parts.push(p);
    }
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
    joined = path.join(tmp, 'joined.mp4');
    await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined, '-y']);
  }

  await ff(['-i', joined, '-c:v', 'libwebp_anim', '-lossless', '0',
    '-q:v', String(quality), '-loop', '0', out, '-y']);
  return out;
}

// ---------------------------------------------------------------- verification
// A still WebP renders without error and silently defeats the whole point, so
// every output is parsed back to confirm it actually animates and loops.
function inspect(file) {
  const d = fs.readFileSync(file);
  if (d.subarray(0, 4).toString() !== 'RIFF' || d.subarray(8, 12).toString() !== 'WEBP') {
    throw new Error('not a WebP');
  }
  let off = 12, frames = 0, durationMs = 0, loop = null;
  while (off < d.length - 8) {
    const fourcc = d.subarray(off, off + 4).toString();
    const size = d.readUInt32LE(off + 4);
    if (fourcc === 'ANIM') loop = d.readUInt16LE(off + 12);
    if (fourcc === 'ANMF') { frames++; durationMs += d.readUIntLE(off + 20, 3); }
    off += 8 + size + (size & 1);
  }
  return { frames, seconds: durationMs / 1000, loop, kb: kb(file) };
}

// ---------------------------------------------------------------- commands
async function capture(t) {
  const out = path.join(assetsDir, `${t.name}.webp`);
  if (t.source.manual) {
    console.log(`- ${t.name}: needs a hand-recorded clip -- ${t.source.manual}`);
    console.log(`  drop a video at tools/capture/input/${t.name}.mov, then re-run`);
    const manualIn = path.join(here, 'input', `${t.name}.mov`);
    if (!fs.existsSync(manualIn)) return null;
    console.log(`  found ${path.relative(repoRoot, manualIn)} -- encoding`);
    t = { ...t, source: { video: manualIn } };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cap-${t.name}-`));
  try {
    const src = t.source.video ?? await record(t, tmp);
    await encode(src, t, tmp, out);
    const info = inspect(out);
    if (info.frames < 2) throw new Error(`encoded to a still (${info.frames} frame)`);
    if (info.loop !== 0) throw new Error(`loop flag is ${info.loop}, expected 0 (infinite)`);
    const budget = t.budgetKb ?? 1200;
    const flag = info.kb > budget ? `  !! over ${budget} KB budget` : '';
    console.log(`✓ ${t.name}: ${info.frames} frames, ${info.seconds.toFixed(1)}s, ${info.kb} KB${flag}`);
    return info;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function check() {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const refs = [...readme.matchAll(/assets\/([\w.-]+)/g)].map((m) => m[1]);
  let bad = 0, total = 0;
  for (const ref of new Set(refs)) {
    const file = path.join(assetsDir, ref);
    if (!fs.existsSync(file)) { console.log(`✗ ${ref}: referenced but missing`); bad++; continue; }
    total += kb(file);
    if (!ref.endsWith('.webp')) { console.log(`· ${ref}: static (${kb(file)} KB)`); continue; }
    try {
      const i = inspect(file);
      const ok = i.frames > 1 && i.loop === 0;
      console.log(`${ok ? '✓' : '✗'} ${ref}: ${i.frames} frames, ${i.seconds.toFixed(1)}s, ${i.kb} KB`);
      if (!ok) bad++;
    } catch (e) { console.log(`✗ ${ref}: ${e.message}`); bad++; }
  }
  for (const f of fs.readdirSync(assetsDir)) {
    if (!refs.includes(f)) { console.log(`· ${f}: orphaned (not referenced by README)`); }
  }
  console.log(`\n${total} KB across ${new Set(refs).size} referenced assets`);
  process.exitCode = bad ? 1 : 0;
}

const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.log('usage: capture.mjs <name|--all|--check|--list>');
  console.log('\ntargets:');
  for (const t of targets) console.log(`  ${t.name.padEnd(16)} ${t.source.url ?? t.source.manual ?? 'local video'}`);
} else if (arg === '--list') {
  for (const t of targets) console.log(t.name);
} else if (arg === '--check') {
  check();
} else if (arg === '--all') {
  for (const t of targets) { try { await capture(t); } catch (e) { console.error(`✗ ${t.name}: ${e.message}`); process.exitCode = 1; } }
} else {
  const t = targets.find((x) => x.name === arg);
  if (!t) { console.error(`unknown target: ${arg}`); process.exit(1); }
  try { await capture(t); } catch (e) { console.error(`✗ ${t.name}: ${e.message}`); process.exit(1); }
}
