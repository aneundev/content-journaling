'use strict';
// 컨텐츠 저널링 도구 로컬 서버
//  - index.html(화면) 제공
//  - 분석 기록과 설정을 data/ 폴더에 JSON 파일로 저장
//  - 유튜브 링크에서 영상 정보 · 자막 · 썸네일 · 도입부 화면을 받아옴 (yt-dlp, ffmpeg)
//    두 도구는 PC에 없으면 처음 실행할 때 bin/ 폴더에 자동으로 받는다
//  - 분석 결과를 긱어스에 글로 올림: PC에 있는 엣지(또는 크롬)를 화면 없이 띄워 조종한다. 따로 설치할 것이 없다
// 실행: START.bat 더블클릭  (또는 node server.js --open)

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');

const APP = 'content-journaling';
const VERSION = '1.0.0';
const PORT = Number(process.env.PORT) || 4780;
const PORT_TRIES = 10;         // 포트가 다른 프로그램에 쓰이고 있으면 다음 번호를 차례로 시도한다
const ROOT = __dirname;
const DATA = process.env.CJ_DATA_DIR || path.join(ROOT, 'data');
const BIN = path.join(ROOT, 'bin');
const WIN = process.platform === 'win32';

const FRAME_STEP = 5;          // 도입부 화면 캡처 간격(초)
const FRAME_COUNT = 6;         // 0~25초, 6장
const MAX_TRANSCRIPT = 150000; // 전체 자막 최대 글자 수

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(stdout);
      });
  });
}
const deps = { run, spawn }; // 테스트에서 교체할 수 있게 분리

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
const lastLine = s => String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

/* ---------- 외부 도구 찾기 ---------- */
// yt-dlp는 한 번 실행하는 데만 몇 초가 걸린다. 그래서 있는지 없는지는 파일 위치만 보고 바로 답하고(화면이 기다리지 않게),
// 버전 · 옵션처럼 실제로 실행해야 아는 것은 처음 필요할 때 한 번만 확인한다.
const exists = f => fsp.access(f).then(() => true, () => false);
async function onPath(name) { // PATH에서 실행 파일 찾기
  const file = process.platform === 'win32' ? name + '.exe' : name;
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, file);
    if (await exists(f)) return f;
  }
  return null;
}
const BIN_YTDLP = path.join(BIN, 'yt-dlp.exe'), BIN_FFMPEG = path.join(BIN, 'ffmpeg.exe');
let ytdlpPath = null, ytdlpInfo = null, ffmpegPath = null;
async function locateYtdlp() {
  if (ytdlpPath && await exists(ytdlpPath)) return ytdlpPath;
  const cands = [path.join(ROOT, 'bin', 'yt-dlp.exe'), path.join(ROOT, 'bin', 'yt-dlp'), await onPath('yt-dlp')];
  if (process.env.LOCALAPPDATA) { // winget 설치 위치: 바로가기(Links) 또는 패키지 폴더 (PATH가 아직 갱신되지 않은 창에서도 찾도록)
    const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    cands.push(path.join(winget, 'Links', 'yt-dlp.exe'));
    try {
      for (const n of await fsp.readdir(path.join(winget, 'Packages'))) {
        if (n.startsWith('yt-dlp.yt-dlp_')) cands.push(path.join(winget, 'Packages', n, 'yt-dlp.exe'));
      }
    } catch {}
  }
  ytdlpPath = null;
  for (const c of cands) { if (c && await exists(c)) { ytdlpPath = c; break; } }
  return ytdlpPath; // 없으면 요청마다 다시 찾는다 (나중에 설치한 경우)
}
// yt-dlp를 실제로 실행해 버전과 옵션을 확인한다 (몇 초 걸림). 같은 파일에 대해서는 한 번만 하고, 동시에 온 요청은 같은 결과를 기다린다.
function ytdlpDetails(file) {
  if (!ytdlpInfo || ytdlpInfo.file !== file) {
    const info = { file, version: null, jsRuntimes: false };
    info.ready = (async () => {
      try { info.version = (await deps.run(file, ['--version'], { timeout: 30000 })).trim(); } catch {}
      // 최신 yt-dlp는 유튜브 추출에 JS 런타임이 필요하다. 옵션이 있는 버전이면 지금 쓰는 Node를 지정한다.
      try { info.jsRuntimes = (await deps.run(file, ['--help'], { timeout: 30000 })).includes('--js-runtimes'); } catch {}
      return info;
    })();
    ytdlpInfo = info;
  }
  return ytdlpInfo.ready;
}
// ffmpeg: 이 폴더의 bin → PC에 설치된 것(PATH) 순서로 찾고, 실제로 실행되는 것만 쓴다
async function locateFfmpeg() {
  if (ffmpegPath && await exists(ffmpegPath)) return ffmpegPath;
  ffmpegPath = null;
  for (const c of [BIN_FFMPEG, await onPath('ffmpeg')]) {
    if (!c || !(await exists(c))) continue;
    try { await deps.run(c, ['-version'], { timeout: 20000 }); ffmpegPath = c; break; } catch {}
  }
  return ffmpegPath;
}
async function getTools() {
  const ytdlp = await locateYtdlp(), ffmpeg = await locateFfmpeg();
  return { ytdlp, ffmpeg, version: ytdlp && ytdlpInfo && ytdlpInfo.file === ytdlp ? ytdlpInfo.version : null };
}

/* ---------- 처음 실행 준비: 없는 도구를 bin 폴더에 받는다 ---------- */
// 받는 곳은 아래 주소로 고정한다. (ffmpeg는 압축을 풀 프로그램이 따로 필요 없는 gzip 한 파일짜리를 쓴다)
const DOWNLOADS = {
  ytdlp: { label: '유튜브 도구(yt-dlp)', file: BIN_YTDLP, url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', check: ['--version'] },
  ffmpeg: { label: '화면 캡처 도구(ffmpeg)', file: BIN_FFMPEG, url: 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-win32-x64.gz', gzip: true, check: ['-version'] },
};
const DOWNLOAD_TIMEOUT = 15 * 60 * 1000;
const YTDLP_UPDATE_GAP = 24 * 60 * 60 * 1000; // 유튜브가 자주 바뀌므로 하루에 한 번 새 버전을 확인한다
const YTDLP_RETRY_GAP = 60 * 60 * 1000;       // 영상 정보를 받지 못했을 때 새 버전을 다시 확인하는 최소 간격
const updateStamp = path.join(BIN, 'yt-dlp.checked');
// bin 폴더에 받아 둔 yt-dlp를 스스로 새 버전으로 바꾸게 한다. 실제로 바뀌었으면 true. (PC에 따로 설치한 것은 건드리지 않는다)
let updating = null, updateTriedAt = 0;
function updateYtdlp() {
  if (!updating) {
    updateTriedAt = Date.now();
    updating = (async () => {
      try {
        const out = await deps.run(BIN_YTDLP, ['-U'], { timeout: 180000 });
        ytdlpInfo = null; // 버전이 바뀌었을 수 있다
        return /Updated yt-dlp to/i.test(out);
      } finally {
        await fsp.writeFile(updateStamp, String(Date.now())).catch(() => {});
        updating = null;
      }
    })();
  }
  return updating;
}

// 임시 파일(.part)에 다 받은 뒤 이름을 바꾼다. 받다가 끊기면 쓰다 만 파일이 남지 않는다.
async function download(d, onProgress) {
  await fsp.mkdir(path.dirname(d.file), { recursive: true });
  const tmp = d.file + '.part';
  try {
    const r = await fetch(d.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0; let got = 0;
    const count = new Transform({ transform(chunk, _enc, cb) { got += chunk.length; if (onProgress) onProgress(got, total); cb(null, chunk); } });
    await pipeline([Readable.fromWeb(r.body), count, ...(d.gzip ? [zlib.createGunzip()] : []), fs.createWriteStream(tmp)]);
    await fsp.rename(tmp, d.file);
    await deps.run(d.file, d.check, { timeout: 60000 }); // 받은 파일이 실제로 실행되는지 확인
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    await fsp.rm(d.file, { force: true }).catch(() => {});
    throw e;
  }
}
const mb = n => (n / 1048576).toFixed(0) + 'MB';
// 진행 상황을 한 줄에서 덮어쓰며 보여 준다 (창이 아닌 곳으로 출력될 때는 줄이 쌓이지 않게 생략한다)
function progressLine(label) {
  let last = -1;
  return (got, total) => {
    if (!process.stdout.isTTY) return;
    const pct = total ? Math.floor(got / total * 100) : Math.floor(got / 1048576);
    if (pct === last) return;
    last = pct;
    process.stdout.write(`\r  ${label} 받는 중… ${total ? `${pct}% (${mb(got)} / ${mb(total)})` : mb(got)}   `);
  };
}
const clearLine = () => { if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(72) + '\r'); };
let preparing = ''; // 준비 중이면 지금 하고 있는 일 (화면에 보여 준다)
async function prepareTools() {
  if (!WIN) return; // 자동으로 받는 것은 윈도우용 실행 파일이다. 다른 운영체제에서는 직접 설치한 것을 쓴다.
  const t = await getTools();
  const need = [!t.ytdlp && DOWNLOADS.ytdlp, !t.ffmpeg && DOWNLOADS.ffmpeg].filter(Boolean);
  if (need.length) console.log('  처음 실행 준비: 필요한 도구를 받습니다. 인터넷 속도에 따라 1~3분 걸립니다.\n');
  for (const d of need) {
    preparing = d.label + ' 받는 중';
    try {
      await download(d, progressLine(d.label));
      clearLine();
      console.log(`  ✔ ${d.label} 준비 완료`);
      if (d === DOWNLOADS.ytdlp) await fsp.writeFile(updateStamp, String(Date.now())).catch(() => {});
    } catch (e) {
      clearLine();
      console.log(`  ✘ ${d.label}를 받지 못했습니다: ${e.message || e}`);
      console.log(d === DOWNLOADS.ytdlp
        ? '    인터넷 연결을 확인한 뒤 이 창을 닫고 START를 다시 실행해 주세요. (이 도구가 없으면 영상을 분석할 수 없습니다)'
        : '    영상 분석은 할 수 있지만 도입부 화면 캡처는 빠집니다. 다음에 실행할 때 다시 받습니다.');
    }
  }
  // 받아 둔 지 하루가 지난 yt-dlp는 새 버전이 있는지 확인한다
  if ((await locateYtdlp()) === BIN_YTDLP && !need.includes(DOWNLOADS.ytdlp)) {
    let checked = 0;
    try { checked = Number(await fsp.readFile(updateStamp, 'utf8')) || 0; } catch {}
    if (Date.now() - checked >= YTDLP_UPDATE_GAP) {
      preparing = '유튜브 도구 새 버전 확인 중';
      console.log('  유튜브 도구 새 버전 확인 중…');
      try { console.log(await updateYtdlp() ? '  ✔ 유튜브 도구를 새 버전으로 바꿨습니다' : '  ✔ 유튜브 도구가 최신 버전입니다'); }
      catch { console.log('  (새 버전을 확인하지 못했습니다. 지금 버전으로 계속합니다)'); }
    }
  }
  preparing = '';
}

/* ---------- 유튜브 ---------- */
function youtubeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;
  return u.href;
}

// 원어 자막을 우선 고른다: 직접 올린 원어 자막 → 자동 생성 원어 자막 → 그 외
function pickCaption(info) {
  const subs = info.subtitles || {}, auto = info.automatic_captions || {};
  const ok = (o, k) => Array.isArray(o[k]) && o[k].length > 0;
  const manual = Object.keys(subs).filter(k => k !== 'live_chat' && ok(subs, k));
  const autos = Object.keys(auto).filter(k => ok(auto, k));
  const base = k => k.toLowerCase().split('-')[0];
  const lang = String(info.language || '').toLowerCase();
  const pick = (k, isAuto) => ({ lang: k, auto: isAuto, tracks: (isAuto ? auto : subs)[k] });
  let k;
  if (lang && (k = manual.find(x => x.toLowerCase() === lang) || manual.find(x => base(x) === base(lang)))) return pick(k, false);
  if ((k = autos.find(x => x.endsWith('-orig')))) return pick(k, true);
  if (lang && (k = autos.find(x => x.toLowerCase() === lang) || autos.find(x => base(x) === base(lang)))) return pick(k, true);
  if ((k = manual.find(x => base(x) === 'ko') || manual.find(x => base(x) === 'en') || manual[0])) return pick(k, false);
  if ((k = autos.find(x => base(x) === 'ko') || autos.find(x => base(x) === 'en'))) return pick(k, true);
  return null;
}

function parseCaption(text, ext) {
  const cues = [];
  if (ext === 'json3') {
    for (const ev of JSON.parse(text).events || []) {
      if (!ev.segs) continue;
      const t = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (t) cues.push({ t: (ev.tStartMs || 0) / 1000, text: t });
    }
    return cues;
  }
  // WebVTT: 자동 자막은 같은 줄이 겹쳐 나오므로 직전과 같은 줄은 버린다
  let prev = '';
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const ls = block.split('\n');
    const i = ls.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = ls[i].match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) continue;
    const t = (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    for (const raw of ls.slice(i + 1)) {
      const line = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (line && line !== prev) { cues.push({ t, text: line }); prev = line; }
    }
  }
  return cues;
}

const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// step초 단위로 묶어 "[m:ss] 텍스트" 줄로 만든다
function formatCues(cues, { to = Infinity, step = 30 } = {}) {
  const out = []; let bucket = -1;
  for (const c of cues) {
    if (c.t >= to) break;
    const b = Math.floor(c.t / step);
    if (b !== bucket) { out.push(`[${clock(c.t)}] ${c.text}`); bucket = b; } else out[out.length - 1] += ' ' + c.text;
  }
  return out.join('\n');
}

async function fetchCaptions(info, url, t, base, dir) {
  const pick = pickCaption(info);
  if (!pick) return null;
  let cues = [];
  const track = pick.tracks.find(x => x.ext === 'json3') || pick.tracks.find(x => x.ext === 'vtt');
  if (track && track.url) {
    try {
      const r = await fetch(track.url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) cues = parseCaption(await r.text(), track.ext);
    } catch {}
  }
  if (!cues.length) { // 직접 받기가 막히면 yt-dlp에게 자막 파일을 받게 한다
    try {
      await deps.run(t.ytdlp, [...base, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', pick.lang,
        '--sub-format', 'json3/vtt', '-o', path.join(dir, 'sub.%(ext)s'), url], { timeout: 90000 });
      const f = (await fsp.readdir(dir)).find(n => n.startsWith('sub.') && /\.(json3|vtt)$/.test(n));
      if (f) cues = parseCaption(await fsp.readFile(path.join(dir, f), 'utf8'), f.endsWith('.json3') ? 'json3' : 'vtt');
    } catch {}
  }
  return cues.length ? { lang: pick.lang, auto: pick.auto, cues } : null;
}

async function fetchThumbnail(info) {
  if (!info.thumbnail) return null;
  try {
    const r = await fetch(info.thumbnail, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null;
    return { media_type: type, data: buf.toString('base64') };
  } catch { return null; }
}

async function extractFrames(clip, dir, ffmpeg = 'ffmpeg') {
  await deps.run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip,
    '-vf', `fps=1/${FRAME_STEP}:round=up,scale=640:-2`, '-frames:v', String(FRAME_COUNT), '-q:v', '6',
    path.join(dir, 'f%02d.jpg')], { timeout: 45000 });
  const files = (await fsp.readdir(dir)).filter(n => /^f\d+\.jpg$/.test(n)).sort();
  return Promise.all(files.map(async (n, i) => ({
    t: i * FRAME_STEP, media_type: 'image/jpeg', data: (await fsp.readFile(path.join(dir, n))).toString('base64'),
  })));
}

// 영상 앞 30초만 내려받아 화면을 캡처한다. 실패해도 나머지 분석은 계속한다.
async function fetchIntroFrames(url, t, base, dir) {
  if (!t.ffmpeg) return [];
  try {
    // 구간만 받는 일은 yt-dlp가 ffmpeg에게 시킨다. bin 폴더에 받아 둔 ffmpeg도 찾을 수 있게 위치를 알려 준다.
    await deps.run(t.ytdlp, [...base, '--ffmpeg-location', t.ffmpeg, '-f', 'bv*[height<=480]/b[height<=480]/wv*/w', '--download-sections', '*0-30',
      '--no-part', '-o', path.join(dir, 'clip.%(ext)s'), url], { timeout: 60000 });
    const clip = (await fsp.readdir(dir)).find(n => n.startsWith('clip.'));
    return clip ? await extractFrames(path.join(dir, clip), dir, t.ffmpeg) : [];
  } catch { return []; }
}

const cache = new Map();
async function getVideo(url) {
  const t = await getTools();
  if (!t.ytdlp) throw httpError(501, '유튜브 도구(yt-dlp)가 준비되지 않았습니다. 검은 창을 닫고 START를 다시 실행해 주세요.');
  let base, info;
  for (let attempt = 0; !info; attempt++) {
    const { jsRuntimes } = await ytdlpDetails(t.ytdlp);
    // 지금 이 서버를 돌리고 있는 Node를 그대로 지정한다 (Node를 PC에 설치하지 않고 bin 폴더의 것을 쓰는 경우에도 찾을 수 있게)
    base = ['--no-playlist', '--no-warnings', '--encoding', 'utf-8', ...(jsRuntimes ? ['--js-runtimes', 'node:' + process.execPath] : [])];
    try {
      info = JSON.parse(await deps.run(t.ytdlp, [...base, '-J', '--skip-download', url], { timeout: 90000 }));
    } catch (e) {
      // 유튜브 쪽이 바뀌면 예전 yt-dlp로는 영상 정보를 받지 못한다. bin 폴더에 받아 둔 것이면 새 버전으로 바꾸고, 바뀌었을 때만 한 번 더 시도한다.
      const canUpdate = attempt === 0 && t.ytdlp === BIN_YTDLP && Date.now() - updateTriedAt >= YTDLP_RETRY_GAP;
      if (canUpdate && await updateYtdlp().catch(() => false)) continue;
      throw httpError(502, '영상 정보를 가져오지 못했습니다: ' + (lastLine(e.stderr) || e.message));
    }
  }
  if (cache.has(info.id)) return cache.get(info.id);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cj-yt-'));
  try {
    const [cap, thumbnail, frames] = await Promise.all([
      fetchCaptions(info, url, t, base, dir), fetchThumbnail(info), fetchIntroFrames(url, t, base, dir),
    ]);
    let transcript = cap ? formatCues(cap.cues, { step: 30 }) : '', truncated = false;
    if (transcript.length > MAX_TRANSCRIPT) {
      transcript = transcript.slice(0, transcript.lastIndexOf('\n', MAX_TRANSCRIPT));
      truncated = true;
    }
    const d = String(info.upload_date || '');
    const out = {
      id: info.id, url: info.webpage_url || url, title: info.title || '', channel: info.channel || info.uploader || '',
      duration: info.duration || 0, viewCount: info.view_count ?? null, likeCount: info.like_count ?? null,
      uploadDate: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '',
      description: String(info.description || '').slice(0, 2000),
      caption: cap ? { lang: cap.lang, auto: cap.auto } : null,
      intro: cap ? formatCues(cap.cues, { to: 60, step: 5 }) : '',
      transcript, transcriptTruncated: truncated,
      thumbnail, frames,
    };
    cache.set(info.id, out);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return out;
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------- 브라우저 조종 (긱어스에 글 올리기용) ---------- */
// PC에 설치된 엣지(윈도우에 기본으로 들어 있다)나 크롬을 화면 없이 띄워 DevTools 프로토콜로 조종한다. 따로 설치할 것이 없다.
// 평소 쓰는 브라우저와 섞이지 않게 전용 프로필(data/browser)을 쓰고, 긱어스 로그인 상태는 그 안에 남는다.
const BROWSER_PROFILE = path.join(DATA, 'browser');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killTree(child) {
  if (WIN && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill();
}
let browserPath = null;
async function findBrowser() {
  if (browserPath && await exists(browserPath)) return browserPath;
  const dirs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [process.env.CJ_BROWSER,
    ...dirs.map(d => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...dirs.map(d => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    await onPath('msedge'), await onPath('chrome')];
  browserPath = null;
  for (const c of cands) { if (c && await exists(c)) { browserPath = c; break; } }
  return browserPath;
}

// 탭 하나를 다루는 도구들. S(method, params)는 그 탭에 DevTools 명령을 보낸다.
function makeTab(S) {
  const evaluate = async (fn, arg) => {
    const r = await S('Runtime.evaluate', { expression: `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '화면에서 스크립트 오류가 났습니다');
    return r.result.value;
  };
  // 지금 주소. 화면이 넘어가는 도중에도 읽을 수 있게 방문 기록에서 읽는다.
  const url = async () => { try { const h = await S('Page.getNavigationHistory'); return h.entries[h.currentIndex].url; } catch { return ''; } };
  const goto = async target => {
    await S('Page.navigate', { url: target });
    for (let i = 0; i < 100; i++) { await sleep(200); if (await evaluate(() => document.readyState === 'complete').catch(() => false)) break; }
  };
  const has = sel => evaluate(s => !!document.querySelector(s), sel).catch(() => false);
  // 실제 마우스로 누른다 (목록 열기처럼 마우스 누름에 반응하는 단추는 스크립트로 누르면 열리지 않는다)
  const clickAt = async (p, what) => {
    if (!p) throw new Error(`누를 곳을 찾지 못했습니다: ${what}`);
    const ev = (type, extra) => S('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, ...extra });
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await ev('mousePressed', { buttons: 1 }); await ev('mouseReleased', { buttons: 0 });
  };
  const click = async sel => clickAt(await evaluate(s => {
    const el = document.querySelector(s); if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); // 부드럽게 넘기는 화면이어도 바로 그 자리에 오게
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel), sel);
  // 역할(button · option)과 보이는 글자가 정확히 같은 것을 누른다. scope를 주면 그 안에서만, 없으면 열려 있는 창(dialog) 안을 먼저 찾는다.
  const findRole = (role, name, scope) => evaluate(a => {
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const sel = a.role === 'button' ? 'button,[role="button"]' : `[role="${a.role}"]`;
    const roots = a.scope ? [...document.querySelectorAll(a.scope)] : [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]'), document];
    for (const root of roots) {
      const el = [...root.querySelectorAll(sel)].find(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.disabled && (norm(e.innerText) === a.name || norm(e.getAttribute('aria-label')) === a.name);
      });
      if (!el) continue;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, { role, name, scope: scope || '' });
  const clickRole = async (role, name, scope) => clickAt(await findRole(role, name, scope), `${role} "${name}"`);
  // 입력 칸을 채운다: 칸을 골라 전체 선택한 뒤 글자를 넣는다(키보드로 붙여넣은 것처럼 들어가 화면이 알아챈다). 그래도 다르면 값을 직접 넣는다.
  const fill = async (sel, value) => {
    const ok = await evaluate(s => { const el = document.querySelector(s); if (!el) return false; el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus(); if (el.select) el.select(); return true; }, sel);
    if (!ok) throw new Error(`입력 칸을 찾지 못했습니다: ${sel}`);
    await S('Input.insertText', { text: String(value) });
    const same = await evaluate(a => document.querySelector(a.sel).value === a.value, { sel, value: String(value) });
    if (!same) await evaluate(a => {
      const el = document.querySelector(a.sel), proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, a.value);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel, value: String(value) });
  };
  const press = async key => { // Escape 같은 키 하나
    const code = { Escape: 27, Enter: 13 }[key] || 0;
    for (const type of ['keyDown', 'keyUp']) await S('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
  };
  // 화면이 스스로 동작할 준비(리액트가 그 칸에 붙는 것)가 끝날 때까지 기다린다. 그 전에 넣은 글자는 화면이 준비되면서 지워질 수 있다.
  const hydrated = async (sel, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      const ok = await evaluate(s => { const el = document.querySelector(s); return !!el && Object.keys(el).some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')); }, sel).catch(() => false);
      if (ok) return true;
      await sleep(250);
    }
    return false; // 끝내 확인하지 못해도 그대로 진행한다 (넣은 값은 누르기 전에 다시 확인한다)
  };
  const value = sel => evaluate(s => { const el = document.querySelector(s); return el ? el.value : null; }, sel).catch(() => null);
  return { evaluate, url, goto, has, click, findRole, clickRole, fill, press, hydrated, value };
}

// 지난번에 띄운 브라우저가 아직 살아 있으면(올리는 도중에 검은 창을 닫은 경우 등) 같은 프로필로 새로 띄울 수 없다. 먼저 정리한다.
const portFile = path.join(BROWSER_PROFILE, 'DevToolsActivePort');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
async function readPort() { // 브라우저가 고른 연결 포트와 주소 (프로필 폴더의 파일에 적힌다)
  try { const [p, w] = (await fsp.readFile(portFile, 'utf8')).trim().split('\n'); return +p && w ? { port: +p, wsPath: w.trim() } : null; } catch { return null; }
}
const portAlive = port => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
// 이 도구의 전용 프로필로 떠 있는 엣지 · 크롬만 골라 끝낸다 (평소 쓰는 브라우저는 건드리지 않는다)
function killProfileBrowsers() {
  if (!WIN) return Promise.resolve();
  const script = "$p=$env:CJ_PROFILE; Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise(res => execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, CJ_PROFILE: BROWSER_PROFILE }, windowsHide: true, timeout: 40000 }, () => res()));
}
async function clearOldBrowser() {
  const old = await readPort();
  if (old && await portAlive(old.port)) {
    try { // 살아 있으면 먼저 정상 종료를 시킨다
      const ws = new WebSocket(`ws://127.0.0.1:${old.port}${old.wsPath}`);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch {}
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) { await sleep(500); alive = await portAlive(old.port); }
    if (alive) { await killProfileBrowsers(); await sleep(1000); }
  }
  await fsp.rm(portFile, { force: true }).catch(() => {});
}

// 브라우저를 화면 없이 띄우고 탭 하나를 연다. 끝나면 close()로 닫는다.
async function launchBrowser() {
  const exe = await findBrowser();
  if (!exe) throw httpError(501, '엣지나 크롬 브라우저를 찾지 못해 긱어스에 올릴 수 없습니다');
  if (typeof WebSocket !== 'function') throw httpError(501, '지금 쓰는 Node.js가 오래되어 긱어스에 올릴 수 없습니다 (22 이상 필요)');
  await fsp.mkdir(BROWSER_PROFILE, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    await clearOldBrowser();
    try { return await startBrowser(exe); }
    catch (e) {
      if (attempt >= 1 || !e.retry) throw e;
      await killProfileBrowsers(); await sleep(1000); // 프로필을 붙잡고 있는 것이 남아 있었을 수 있다. 정리하고 한 번만 다시 띄운다.
    }
  }
}
async function startBrowser(exe) {
  const child = deps.spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${BROWSER_PROFILE}`, '--window-size=1280,900',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; }); child.on('error', () => { exited = true; });
  const kill = () => { if (!exited) killTree(child); };
  try {
    let at = null;
    for (let i = 0; i < 240 && !at && !exited; i++) { await sleep(250); at = await readPort(); } // 느린 PC를 생각해 1분까지 기다린다
    if (!at) throw Object.assign(new Error('브라우저를 시작하지 못했습니다'), { retry: true });
    const ws = new WebSocket(`ws://127.0.0.1:${at.port}${at.wsPath}`);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(Object.assign(new Error('브라우저에 연결하지 못했습니다'), { retry: true })), { once: true }); });
    let seq = 0; const pending = new Map();
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { pending.delete(id); reject(e); }
    });
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); return; }
      // 화면이 띄우는 확인 창(alert · confirm)은 받아들이고 넘어간다
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => {});
    });
    ws.addEventListener('close', () => { for (const p of pending.values()) p.reject(new Error('브라우저와의 연결이 끊겼습니다')); pending.clear(); });
    const ver = await send('Browser.getVersion');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => send(method, params, sessionId);
    await S('Page.enable'); await S('Runtime.enable');
    // "화면 없이 띄운 브라우저"라는 표시를 뗀다 (그 표시만 보고 막는 사이트가 있다)
    await S('Emulation.setUserAgentOverride', { userAgent: String(ver.userAgent || '').replace(/Headless/g, '') });
    const close = async () => { // 로그인 상태가 프로필에 저장되도록 먼저 정상 종료를 시키고, 안 닫히면 끝낸다
      try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch {}
      for (let i = 0; i < 20 && !exited; i++) await sleep(250);
      kill();
      for (let i = 0; i < 40 && !exited; i++) await sleep(250); // 완전히 끝난 뒤에 돌아간다 (바로 다음 올리기가 같은 프로필을 쓸 수 있게)
    };
    return { tab: makeTab(S), close, kill };
  } catch (e) { kill(); for (let i = 0; i < 20 && !exited; i++) await sleep(250); throw e; }
}

/* ---------- 긱어스에 글 올리기 ---------- */
// 할 수 있는 일을 한 가지로 고정한다: AG 마스터마인드의 "컨텐츠저널링" 카테고리에 글 하나를 게시하고 그 글 주소를 돌려준다
const GEEKUS = { write: 'https://geekus.kr/ag-mastermind/post/write', home: 'https://geekus.kr/ag-mastermind', login: 'https://geekus.kr/login', category: '컨텐츠저널링' };
const GEEKUS_POST_RE = /^https:\/\/geekus\.kr\/ag-mastermind\/post\/\d+$/;
const POST_TIMEOUT = 150 * 1000;
class PostError extends Error { constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; } }
let geekusBusy = false; // 한 번에 하나만 (같은 프로필로 브라우저를 두 개 띄울 수 없다)

// 순서: 글쓰기 화면 열기 → (로그인이 풀려 있으면 로그인) → 카테고리 · 제목 · 본문 넣기 → 제대로 들어갔는지 확인 → 게시 → 글 주소 얻기
async function geekusPost(post, { onStep } = {}) {
  if (geekusBusy) throw httpError(409, '긱어스에 올리는 작업이 이미 진행 중입니다. 끝난 뒤 다시 눌러 주세요.');
  geekusBusy = true;
  const t0 = Date.now(), steps = []; // 지나온 단계와 걸린 시간 (오류가 나면 어디까지 갔는지 보여 준다)
  const secs = ms => (ms / 1000).toFixed(1) + '초';
  const say = text => { steps.push({ at: Date.now() - t0, text }); if (onStep) onStep(`${steps.length}단계 · ${text}`); };
  const fail = (code, message, extra) => { throw new PostError(code, message, extra); };
  // 비밀번호 · 이메일은 오류 메시지와 로그 파일에 남기지 않는다
  const mask = s => [post.password, post.email].filter(x => x && x.length >= 3).reduce((a, x) => a.split(x).join('***'), String(s));
  const clean = u => String(u).split(/[?#]/)[0].replace(/\/$/, '');
  const postUrl = u => { const m = clean(u).match(GEEKUS_POST_RE); return m ? m[0] : ''; };
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
  let browser = null, tab = null, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; if (browser) browser.kill(); }, POST_TIMEOUT);

  const run = async () => {
    say('브라우저 준비하는 중');
    browser = await launchBrowser(); tab = browser.tab;
    if (timedOut) browser.kill();
    const formReady = () => tab.evaluate(() => { const el = document.querySelector('main .ProseMirror'); return !!(el && el.editor && document.querySelector('main [role="combobox"]') && document.querySelector('main textarea.editor-title-input')); }).catch(() => false);
    // 글쓰기 화면이 준비되는지, 로그인하라고 다른 화면으로 넘기는지 기다린다
    const openWrite = async () => {
      await tab.goto(GEEKUS.write);
      for (let i = 0; i < 50; i++) {
        if (clean(await tab.url()) !== GEEKUS.write) return 'moved';
        if (await formReady()) return 'ready';
        await sleep(300);
      }
      return 'timeout';
    };

    say('글쓰기 화면 여는 중');
    let opened = await openWrite();
    if (opened === 'moved') { // 로그인이 풀려 있으면 소개 화면으로 돌려보낸다
      if (!post.email || !post.password) fail('login_required', '긱어스에 로그인되어 있지 않습니다. ⚙ 설정에 긱어스 이메일과 비밀번호를 넣은 뒤 다시 눌러 주세요.');
      say('긱어스에 로그인하는 중');
      await tab.goto(GEEKUS.login);
      for (let i = 0; i < 60 && !(await tab.has('input[name="password"]')); i++) await sleep(300);
      await tab.hydrated('input[name="password"]'); // 느린 PC에서는 화면이 준비되기 전에 넣은 글자가 지워진다
      // 지난 계정을 기억해 비밀번호만 묻는 화면에서는 계정 칸이 type="hidden"으로 남아 있다. 숨은 칸은 입력할 수 없으므로 보이는 칸만 센다.
      const ID = 'input[name="identifier"]:not([type="hidden"])', PW = 'input[name="password"]:not([type="hidden"])';
      const remembered = await tab.evaluate(() => { const el = document.querySelector('input[name="identifier"][type="hidden"]'); return el ? el.value : ''; });
      const sameAccount = !(await tab.has(ID)) && remembered.trim().toLowerCase() === String(post.email).trim().toLowerCase(); // 기억된 계정이 설정의 계정과 같으면 비밀번호만 넣는다
      if (!sameAccount && !(await tab.has(ID))) { // 다른 계정이 기억돼 있으면 계정 입력 화면으로 바꾼다
        await tab.clickRole('button', '변경');
        for (let i = 0; i < 20 && !(await tab.has(ID)); i++) await sleep(300);
      }
      if ((!sameAccount && !(await tab.has(ID))) || !(await tab.has(PW))) fail('login_failed', '긱어스 로그인 화면에서 입력 칸을 찾지 못했습니다. (로그인 화면이 바뀌었을 수 있습니다)');
      say(sameAccount ? '기억된 계정으로 비밀번호 넣는 중' : '이메일 · 비밀번호 넣는 중');
      // 넣은 값이 잠시 뒤에도 그대로인지 확인하고 나서 누른다 (지워졌으면 다시 넣는다)
      const typed = async () => (sameAccount || await tab.value(ID) === post.email) && await tab.value(PW) === post.password;
      for (let i = 0; i < 3; i++) {
        if (!sameAccount) await tab.fill(ID, post.email);
        await tab.fill(PW, post.password);
        await sleep(500);
        if (await typed()) break;
      }
      if (!(await typed())) fail('login_failed', '긱어스 로그인 화면에 이메일과 비밀번호를 넣지 못했습니다. 잠시 뒤에 다시 눌러 주세요.');
      say('로그인 버튼 누르고 결과 기다리는 중');
      await tab.click('button[type="submit"]');
      for (let i = 0; i < 60 && clean(await tab.url()) === GEEKUS.login; i++) await sleep(500); // 로그인되면 다른 화면으로 넘어간다
      if (clean(await tab.url()) === GEEKUS.login) {
        // 긱어스가 화면에 띄운 안내(비밀번호가 틀렸다 등)가 있으면 함께 알려 준다
        const page = await tab.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => '');
        fail('login_failed', '긱어스 로그인에 실패했습니다. ⚙ 설정의 긱어스 이메일과 비밀번호를 확인하세요.', { page });
      }
      say('로그인 완료, 글쓰기 화면으로 돌아가는 중');
      opened = await openWrite();
      if (opened === 'moved') fail('login_failed', '긱어스 로그인에 실패했습니다. ⚙ 설정의 긱어스 이메일과 비밀번호를 확인하세요.');
    }
    if (opened !== 'ready') fail('not_ready', '글쓰기 화면이 15초 안에 준비되지 않았습니다. (편집기 · 카테고리 · 제목 칸 중 찾지 못한 것이 있습니다)');

    say('카테고리 고르는 중');
    let cats = [];
    for (let i = 0; i < 3 && !cats.length; i++) { // 카테고리 목록 열기: 열리지 않았으면 다시 누른다
      const open = await tab.evaluate(() => { const c = document.querySelector('main [role="combobox"]'); return !!c && c.getAttribute('aria-expanded') === 'true'; });
      if (!open) await tab.click('main [role="combobox"]');
      for (let j = 0; j < 10 && !cats.length; j++) {
        await sleep(200);
        cats = await tab.evaluate(() => [...document.querySelectorAll('[role="option"]')].map(o => (o.innerText || '').trim()));
      }
    }
    if (!cats.includes(GEEKUS.category)) {
      await tab.press('Escape');
      fail('no_category', `"${GEEKUS.category}" 카테고리를 찾지 못했습니다. (있는 카테고리: ${cats.join(', ')})`);
    }
    await tab.clickRole('option', GEEKUS.category, 'body');
    say('제목 넣는 중');
    await tab.fill('main textarea.editor-title-input', post.title);
    say('본문 편집기 비우는 중');
    const hasEditor = await tab.evaluate(() => {
      const el = document.querySelector('main .ProseMirror'), ed = el && el.editor;
      if (ed) ed.chain().focus().clearContent(true).run();
      return !!ed;
    });
    if (!hasEditor) fail('editor', '본문 편집기를 찾지 못해 게시하지 않았습니다.');
    // 본문 맨 위: 편집기의 "영상" 버튼으로 유튜브 영상을 임베드한다 (동영상 추가 창에 링크를 넣고 "추가")
    let embedded = false;
    if (post.video) {
      say('유튜브 영상 임베드하는 중');
      const LINK = 'input[placeholder="YouTube, Loom, Vimeo 링크"]';
      await tab.click('main form button[aria-label="영상"]');
      for (let i = 0; i < 25 && !(await tab.has(LINK)); i++) await sleep(200);
      if (await tab.has(LINK)) {
        await tab.fill(LINK, post.video);
        await tab.clickRole('button', '추가');
        for (let i = 0; i < 30 && !embedded; i++) {
          await sleep(200);
          embedded = await tab.evaluate(() => (document.querySelector('main .ProseMirror').editor.getJSON().content || []).some(n => n.type === 'videoAttachment'));
        }
      }
      if (!embedded) { // 영상 없이 올리지 않는다: 열려 있는 창을 닫고 멈춘다
        await tab.press('Escape');
        fail('embed_failed', '유튜브 영상을 글에 임베드하지 못해 게시하지 않았습니다. (긱어스 편집기의 영상 추가 창이 바뀌었을 수 있습니다)');
      }
    }
    // 그 아래에 분석 내용을 이어 붙인다
    say('본문 넣는 중');
    const body = await tab.evaluate(h => {
      const ed = document.querySelector('main .ProseMirror').editor;
      ed.chain().focus('end').insertContent(h).run();
      return { ok: ed.getText().trim().length > 0, chars: ed.getText().length, blocks: (ed.getJSON().content || []).map(n => n.type) };
    }, post.html);
    if (!body.ok) fail('editor', '본문 편집기에 내용을 넣지 못해 게시하지 않았습니다.');
    // 넣은 것이 실제로 들어갔는지 확인한 뒤에만 게시한다
    say('넣은 내용 확인 중');
    const state = await tab.evaluate(() => {
      const btn = [...document.querySelectorAll('main form button')].find(b => (b.innerText || '').trim() === '게시');
      return {
        category: (document.querySelector('main [role="combobox"]').innerText || '').trim(),
        title: document.querySelector('main textarea.editor-title-input').value,
        canPost: !!btn && !btn.disabled,
      };
    });
    if (state.category !== GEEKUS.category || state.title !== post.title || !state.canPost) {
      const why = [];
      if (state.category !== GEEKUS.category) why.push(`카테고리가 "${state.category}"로 되어 있음`);
      if (state.title !== post.title) why.push(`제목이 다르게 들어감 ("${String(state.title).slice(0, 40)}")`);
      if (!state.canPost) why.push('게시 버튼이 없거나 눌리지 않는 상태');
      fail('not_ready', '글쓰기 화면에 내용이 제대로 들어가지 않아 게시하지 않았습니다: ' + why.join(', '), { state });
    }
    // 시험용: 게시 직전에 멈춘다. 게시 버튼을 누를 자리를 찾을 수 있는지까지만 확인한다.
    if (post.dryRun) return { dryRun: true, state, chars: body.chars, embedded, blocks: body.blocks, postButtonFound: !!(await tab.findRole('button', '게시', 'main form')) };

    say('게시하는 중');
    await tab.clickRole('button', '게시', 'main form'); // 게시 버튼은 여기서 한 번만 누른다
    let url = '', confirmed = false;
    for (let i = 0; i < 60 && !url; i++) {
      await sleep(500);
      const now = await tab.url();
      url = postUrl(now);
      if (url || (now && clean(now) !== GEEKUS.write)) break; // 글 화면 또는 글 목록으로 넘어갔다
      if (!confirmed && i >= 3) { // 확인 창이 뜨는 경우 한 번만 눌러 준다
        confirmed = await tab.evaluate(() => {
          const d = document.querySelector('[role="alertdialog"],[role="dialog"]');
          const b = d && [...d.querySelectorAll('button')].find(x => ['게시', '게시하기', '확인', '등록'].includes((x.innerText || '').trim()));
          if (b) b.click();
          return !!b;
        }).catch(() => false);
      }
    }
    if (!url) { // 글 화면으로 바로 넘어가지 않은 경우: 글 목록에서 방금 올린 제목의 글을 눌러 주소를 얻는다
      say('올린 글 주소 확인 중');
      if (clean(await tab.url()) !== GEEKUS.home) await tab.goto(GEEKUS.home);
      for (let i = 0; i < 10 && !url; i++) {
        await sleep(700);
        const hit = await tab.evaluate(t => {
          const h = [...document.querySelectorAll('main h3')].find(x => (x.innerText || '').replace(/\s+/g, ' ').trim() === t);
          if (!h) return '';
          const a = h.querySelector('a') || h.closest('a');
          if (a && a.getAttribute('href')) return a.href;
          h.click();
          return 'clicked';
        }, oneLine(post.title)).catch(() => '');
        if (hit === 'clicked') { for (let j = 0; j < 12 && !url; j++) { await sleep(500); url = postUrl(await tab.url()); } }
        else if (hit) url = postUrl(hit);
      }
    }
    if (url) return { url };
    fail('url_not_found', '게시 버튼을 눌렀지만 글 목록에서 올린 글을 찾지 못했습니다. 긱어스에서 글이 올라갔는지 먼저 확인해 주세요. (다시 올리면 글이 두 개가 될 수 있습니다)');
  };

  try {
    return await run();
  } catch (e) {
    // 실패하면 어디서 멈췄는지를 data/logs 에 남기고, 화면에는 멈춘 단계 · 진행 기록 · 오류 원문을 보여 준다
    const known = e instanceof PostError, total = Date.now() - t0, last = steps[steps.length - 1];
    // 로그인 정보만 넣으면 풀리는 문제는 무엇을 해야 하는지만 짧게 알린다 (진행 기록은 붙이지 않는다)
    if (known && e.code === 'login_required') throw Object.assign(new Error(mask(e.message)), { code: e.code });
    const at = tab && !timedOut ? await tab.url() : '';
    const message = timedOut ? `긱어스에 올리는 일이 ${POST_TIMEOUT / 1000}초 안에 끝나지 않아 멈췄습니다. 긱어스에서 글이 올라갔는지 먼저 확인해 주세요.`
      : known ? e.message : e.status ? e.message : '긱어스 글쓰기 중 오류: ' + (e.message || String(e));
    const trail = steps.map((s, i) => `  ${i + 1}. ${s.text} (${secs(s.at)}에 시작)`).join('\n') || '  (첫 단계도 시작하지 못했습니다)';
    const detail = [at ? `화면 주소: ${at}` : '', known && e.extra.state ? `화면 상태: ${JSON.stringify(e.extra.state)}` : '', known && e.extra.page ? `화면에 나온 글: ${e.extra.page}` : '',
      !known && !timedOut && e.stack ? `호출 위치:\n${String(e.stack).split('\n').slice(0, 8).join('\n')}` : ''].filter(Boolean).join('\n');
    let logNote = '';
    try {
      const dir = path.join(DATA, 'logs'), d = new Date(), p2 = n => String(n).padStart(2, '0');
      const file = path.join(dir, `geekus-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.log`);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, mask([`시각: ${d.toLocaleString('ko-KR')}`, `글 제목: ${post.title}`, `오류: ${message}`, `걸린 시간: ${secs(total)}`, '', '[진행 기록]', trail, '', '[상세]', detail || '(없음)'].join('\n')), 'utf8');
      logNote = `\n■ 전체 로그 파일: ${file}`;
    } catch { /* 로그를 남기지 못해도 오류 안내는 그대로 한다 */ }
    // 로그인 실패는 화면에는 짧게만 알리고, 자세한 내용은 로그 파일에만 남긴다
    if (known && e.code === 'login_failed') throw Object.assign(new Error(mask(e.message)), { code: e.code });
    const text = mask([message, `■ 멈춘 단계: ${last ? `${steps.length}. ${last.text}` : '시작 전'} (전체 ${secs(total)} 걸림)`, `■ 진행 기록:\n${trail}`, detail ? `■ 상세:\n${detail}` : ''].filter(Boolean).join('\n')) + logNote;
    console.error(`[긱어스 올리기 실패]\n${text}\n`);
    throw Object.assign(new Error(text), { code: known ? e.code : timedOut ? 'timeout' : 'script_error', status: e.status });
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
    geekusBusy = false;
  }
}

/* ---------- 파일 저장 ---------- */
const contentFile = path.join(DATA, 'content.json');   // 분석 기록
const settingsFile = path.join(DATA, 'settings.json'); // API 키 · 모델 · 기수 · 이름 · 긱어스 계정
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

// 모든 기록은 이 data 폴더의 파일이 원본이다 (브라우저에는 저장하지 않는다).
// 파일을 덮어쓰기 전에는 이전 내용을 data/history 에 남겨, 화면 쪽에 어떤 문제가 있어도 되돌릴 수 있게 한다.
const HISTORY = path.join(DATA, 'history');
const HISTORY_KEEP = 100;            // 파일 하나당 남기는 이전 저장본 수
const HISTORY_GAP = 5 * 60 * 1000;   // 평소에는 5분에 한 번만 남긴다 (내용이 줄어드는 저장은 항상 남긴다)
const historyDir = file => path.join(HISTORY, path.relative(DATA, file).replace(/\.json$/i, '').split(path.sep).join('__'));
// 내용이 얼마나 들어 있는지: 비어 있지 않은 글자 수 (id · 좌표 · 저장 시각 같은 값은 세지 않는다)
function weight(v, key) {
  if (typeof v === 'string') return key === 'id' ? 0 : v.trim().length;
  if (typeof v === 'number') return key === 'amount' && v > 0 ? String(v).length : 0;
  if (Array.isArray(v)) return v.reduce((s, x) => s + weight(x), 0);
  if (v && typeof v === 'object') return Object.entries(v).reduce((s, [k, x]) => s + (k === '_ts' ? 0 : weight(x, k)), 0);
  return 0;
}
async function historyNames(dir) {
  try { return (await fsp.readdir(dir)).filter(n => /^\d+\.json$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)); }
  catch { return []; }
}
async function addHistory(dir, text) {
  await fsp.mkdir(dir, { recursive: true });
  const names = await historyNames(dir);
  let id = Date.now();
  if (names.length && id <= parseInt(names[names.length - 1], 10)) id = parseInt(names[names.length - 1], 10) + 1;
  await fsp.writeFile(path.join(dir, id + '.json'), text);
  for (const n of names.slice(0, Math.max(0, names.length + 1 - HISTORY_KEEP))) await fsp.rm(path.join(dir, n), { force: true });
  return id;
}
async function keepHistory(file, next) { // file을 next로 덮어쓰기 직전에 부른다
  let oldText; try { oldText = await fsp.readFile(file, 'utf8'); } catch { return; }
  let old = null; try { old = JSON.parse(oldText); } catch {}
  if (old != null && weight(old) === 0) return; // 빈 내용은 남길 필요가 없다
  const dir = historyDir(file), names = await historyNames(dir);
  const last = names.length ? parseInt(names[names.length - 1], 10) : 0;
  const shrinks = old == null || weight(next) < weight(old) * 0.8;
  if (shrinks || Date.now() - last >= HISTORY_GAP) await addHistory(dir, oldText);
}

let writeQueue = Promise.resolve();
function queued(fn) { // 파일 읽고 쓰기를 한 번에 하나씩 (확인과 저장 사이에 다른 저장이 끼어들지 않게)
  const job = writeQueue.then(fn);
  writeQueue = job.catch(() => {});
  return job;
}
async function writeNow(file, obj) { // 임시 파일에 쓴 뒤 바꿔치기해서 쓰다 만 파일이 남지 않게 한다
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (file.startsWith(DATA + path.sep) && !file.startsWith(HISTORY + path.sep)) await keepHistory(file, obj).catch(() => {});
  await fsp.writeFile(file + '.tmp', JSON.stringify(obj, null, 2));
  await fsp.rename(file + '.tmp', file);
}
function writeJson(file, obj) { return queued(() => writeNow(file, obj)); }
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpError(413, '내용이 너무 큽니다')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'JSON 형식이 아닙니다')); } });
    req.on('error', reject);
  });
}

/* ---------- HTTP ---------- */
const PAGES = { '/': 'index.html', '/index.html': 'index.html' };
const goodPages = new Map(); // 화면 파일별로 마지막으로 온전했던 내용
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function handle(req, res) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'forbidden' });
  const u = new URL(req.url, 'http://localhost'), p = u.pathname;

  const pageFile = PAGES[p];
  if (req.method === 'GET' && pageFile) {
    // 화면 파일이 고쳐지는 도중(쓰다 만 상태)에 열리면 빈 화면이 뜰 수 있으므로, 끝까지 쓰인 파일만 내보내고 아니면 마지막으로 온전했던 것을 내보낸다
    let html = await fsp.readFile(path.join(ROOT, pageFile), 'utf8');
    if (/<\/html>\s*$/.test(html)) goodPages.set(pageFile, html);
    else if (goodPages.has(pageFile)) html = goodPages.get(pageFile);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // 다른 웹사이트가 이 서버를 몰래 호출하지 못하게 막는다
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'forbidden' });
  if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON만 받습니다' });

  if (p === '/api/health' && req.method === 'GET') {
    // preparing: 처음 실행 준비(도구 받기)가 아직 끝나지 않았으면 지금 하고 있는 일
    // geekus: 긱어스에 올릴 때 쓸 브라우저(엣지 · 크롬)가 이 PC에 있는지
    const geekus = !!(await findBrowser());
    if (preparing) return send(res, 200, { ok: true, app: APP, version: VERSION, preparing, ytdlp: false, ffmpeg: false, geekus, dataDir: DATA });
    const t = await getTools();
    return send(res, 200, { ok: true, app: APP, version: VERSION, preparing: '', ytdlp: !!t.ytdlp, ytdlpVersion: t.version, ffmpeg: !!t.ffmpeg, geekus, dataDir: DATA });
  }
  if (p === '/api/youtube' && req.method === 'GET') {
    const url = youtubeUrl(u.searchParams.get('url') || '');
    if (!url) return send(res, 400, { error: '유튜브 링크가 아닙니다' });
    return send(res, 200, await getVideo(url));
  }
  if (p === '/api/content') { // 분석 기록
    if (req.method === 'GET') return send(res, 200, await readJson(contentFile));
    if (req.method === 'POST') { // 화면이 읽어 온 뒤에 파일이 바뀌었으면 덮어쓰지 않고 지금 파일 내용을 돌려준다 (화면이 합쳐서 다시 보낸다)
      const body = await readBody(req);
      const r = await queued(async () => {
        const prev = await readJson(contentFile);
        const { _base, ...data } = body && typeof body === 'object' ? body : {};
        if (prev._ts && _base !== prev._ts) return { conflict: 'changed', current: prev };
        if (!Array.isArray(data.items)) return { conflict: 'invalid', current: prev };
        data._ts = Math.max(Date.now(), (prev._ts || 0) + 1);
        await writeNow(contentFile, data);
        return { ok: true, _ts: data._ts };
      });
      if (r.conflict) return send(res, 409, { error: '저장하지 않았습니다', reason: r.conflict, current: r.current });
      return send(res, 200, r);
    }
  }
  if (p === '/api/settings') { // API 키 · 모델 · 기수 · 이름 · 긱어스 계정 (data/settings.json)
    if (req.method === 'GET') return send(res, 200, await readJson(settingsFile));
    if (req.method === 'POST') { await writeJson(settingsFile, await readBody(req)); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/geekus/post' && req.method === 'POST') {
    // 할 수 있는 일을 "컨텐츠저널링 글 하나 게시"로만 한정한다: 올릴 곳과 카테고리는 서버가 정하고, 화면은 제목과 본문만 보낸다
    const body = await readBody(req);
    const title = String(body.title || '').replace(/\s+/g, ' ').trim(), html = String(body.html || '');
    if (!title || title.length > 200) return send(res, 400, { error: '글 제목이 비었거나 너무 깁니다' });
    if (!html.trim() || html.length > 300000) return send(res, 400, { error: '글 본문이 비었거나 너무 깁니다' });
    // 글 맨 위에 임베드할 유튜브 영상 (없으면 임베드 없이 올린다). 유튜브 주소만 받는다.
    const video = body.video ? youtubeUrl(body.video) : '';
    if (body.video && !video) return send(res, 400, { error: '임베드할 영상 주소가 유튜브 링크가 아닙니다' });
    if (!(await findBrowser())) return send(res, 501, { error: '엣지나 크롬 브라우저를 찾지 못해 긱어스에 올릴 수 없습니다' });
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const emit = o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
    // 게시 버튼을 누른 뒤에 끊기면 글 주소를 놓치므로, 화면이 닫혀도 중간에 멈추지 않고 끝까지 간다
    try {
      const r = await geekusPost({ title, html, video, email: String(body.email || ''), password: String(body.password || ''), dryRun: body.dryRun === true },
        { onStep: text => emit({ type: 'log', text }) });
      emit({ type: 'done', ...r });
    } catch (e) { emit({ type: 'error', error: e.message || String(e), code: e.code }); }
    return res.end();
  }
  return send(res, 404, { error: 'not found' });
}
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) }); else res.end(); });
});

/* ---------- 시작 ---------- */
function openBrowser(origin) {
  if (WIN) execFile('cmd', ['/c', 'start', '', origin], { windowsHide: true }, () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [origin], () => {});
}
const listen = port => new Promise((resolve, reject) => {
  const onError = e => { server.off('listening', onListening); reject(e); };
  const onListening = () => { server.off('error', onError); resolve(); };
  server.once('error', onError); server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
});
// 그 포트에서 돌고 있는 것이 이 도구인지 (이미 켜 둔 창이 있는지) 확인한다
async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok && (await r.json()).app === APP;
  } catch { return false; }
}
async function start({ open = false } = {}) {
  let origin = '';
  for (let port = PORT; port < PORT + PORT_TRIES && !origin; port++) {
    try { await listen(port); origin = `http://localhost:${port}`; }
    catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await isOurs(port)) { // 이미 켜져 있으면 그 화면만 다시 연다
        console.log(`\n  이미 실행 중입니다 → http://localhost:${port}\n`);
        if (open) openBrowser(`http://localhost:${port}`);
        return null;
      }
    }
  }
  if (!origin) throw new Error(`${PORT}~${PORT + PORT_TRIES - 1}번 포트가 모두 사용 중이라 시작하지 못했습니다`);
  console.log(`\n  컨텐츠 저널링 도구 ${VERSION}\n  저장 위치: ${DATA}\n`);
  preparing = '준비 중';
  try { await prepareTools(); } finally { preparing = ''; }
  const t = await getTools();
  if (!t.ytdlp) console.log('  ⚠ 유튜브 도구(yt-dlp)가 없어 영상을 분석할 수 없습니다.');
  else if (!t.ffmpeg) console.log('  화면 캡처 도구(ffmpeg)가 없어 도입부 화면 캡처는 건너뜁니다.');
  if (!(await findBrowser())) console.log('  ⚠ 엣지나 크롬 브라우저를 찾지 못해 긱어스에 올리기는 쓸 수 없습니다.');
  console.log(`\n  준비됐습니다  →  ${origin}\n  브라우저에 화면이 열립니다. 열리지 않으면 위 주소를 브라우저 주소창에 넣어 주세요.\n\n  끄려면 이 창을 닫으세요.\n`);
  if (open) openBrowser(origin);
  // yt-dlp 버전 확인은 몇 초 걸리므로 뒤에서 미리 해 둔다 (첫 영상 분석이 그만큼 빨라진다)
  if (t.ytdlp) ytdlpDetails(t.ytdlp).catch(() => {});
  return origin;
}

if (require.main === module) {
  // CJ_NO_OPEN=1 이면 브라우저를 열지 않는다 (자동 시험용)
  start({ open: process.argv.includes('--open') && !process.env.CJ_NO_OPEN }).catch(e => {
    console.error('\n  시작하지 못했습니다: ' + (e.message || e) + '\n');
    process.exit(1);
  });
}

module.exports = { server, start, deps, youtubeUrl, pickCaption, parseCaption, formatCues, extractFrames, getVideo, download, prepareTools, DOWNLOADS, findBrowser, launchBrowser, geekusPost };
