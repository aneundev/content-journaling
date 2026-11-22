'use strict';
// 컨텐츠 저널링 도구 로컬 서버
//  - index.html(화면) 제공
//  - 분석 기록과 설정을 data/ 폴더에 JSON 파일로 저장
//  - 유튜브 링크에서 영상 정보 · 자막 · 썸네일 · 도입부 화면을 받아옴 (yt-dlp, ffmpeg)
//    두 도구는 PC에 없으면 처음 실행할 때 bin/ 폴더에 자동으로 받는다
//  - (선택) Aside CLI가 설치돼 있으면 내 브라우저로 긱어스에 글을 올림
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

/* ---------- Aside CLI (선택) ---------- */
// Aside 브라우저와 그 CLI가 설치된 PC에서만 쓰는 기능이다. 없으면 화면에 긱어스에 올리기 버튼이 나오지 않는다.
const MARK_START = '<<<CJ_RESULT>>>', MARK_END = '<<<CJ_END>>>';
const REPL_TIMEOUT = 150 * 1000; // aside repl 자체 제한(120초)보다 조금 길게

let asideCli = null;
async function findAside() {
  if (asideCli) return asideCli;
  const cands = [process.env.ASIDE_CLI, 'aside'];
  if (process.env.LOCALAPPDATA) { // Windows 설치 스크립트의 기본 위치 (실행 파일은 current 폴더 안에 있다)
    const dir = path.join(process.env.LOCALAPPDATA, 'Aside', 'CLI');
    cands.push(path.join(dir, 'current', 'aside.exe'));
    try {
      const exes = (await fsp.readdir(dir)).filter(n => /^aside.*\.exe$/i.test(n));
      const pick = exes.find(n => n.toLowerCase() === 'aside.exe') || exes[0];
      if (pick) cands.push(path.join(dir, pick));
    } catch {}
  }
  for (const c of cands.filter(Boolean)) {
    try { await deps.run(c, ['--version'], { timeout: 20000 }); asideCli = c; break; }
    catch (e) { if (e.code !== 'ENOENT') { asideCli = c; break; } } // 실행은 됐는데 옵션만 다른 경우도 설치된 것으로 본다
  }
  return asideCli;
}

const stripAnsi = s => s.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');
// 진행 표시가 같은 줄을 덮어쓰는 경우(\r) 마지막 상태만 남긴다
const cleanLine = l => stripAnsi(l).split('\r').filter(Boolean).pop()?.trim() || '';
const cleanOutput = s => s.split('\n').map(l => stripAnsi(l).split('\r').filter(Boolean).pop() || '').join('\n');
// 표시가 줄 전체를 차지할 때만 인정한다 (CLI가 지시문을 그대로 되풀이해 출력해도 걸리지 않게)
function extractMarked(text) {
  const lines = text.split('\n'); let s = -1, e = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t === MARK_START) { s = i; e = -1; } else if (t === MARK_END && s >= 0 && e < 0) e = i;
  });
  return s < 0 ? null : lines.slice(s + 1, e > s ? e : undefined).join('\n').trim();
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill();
}
// aside를 실행해 끝날 때까지 기다린다. 시간 초과 · 중단 때는 자식 프로세스까지 끝낸다.
function runAside(cli, args, { input, onData, signal, timeout = REPL_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = deps.spawn(cli, args, { windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    let out = '', all = '', done = false;
    const kill = () => killTree(child);
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const timer = setTimeout(() => { kill(); finish(reject, httpError(504, `Aside가 ${timeout / 60000}분 안에 끝나지 않았습니다`)); }, timeout);
    const onAbort = () => { kill(); finish(reject, httpError(499, '중단했습니다')); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; all += d; if (onData) onData(d); });
    child.stderr.on('data', d => { all += d; if (onData) onData(d); });
    child.on('error', e => finish(reject, e.code === 'ENOENT' ? httpError(501, 'Aside CLI를 실행하지 못했습니다') : e));
    child.on('close', code => finish(resolve, { code, out, all }));
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

/* ---------- Aside CLI: 긱어스에 글 올리기 ---------- */
// 할 수 있는 일을 한 가지로 고정한다: AG 마스터마인드의 "컨텐츠저널링" 카테고리에 글 하나를 게시하고 그 글 주소를 돌려준다
const GEEKUS = { write: 'https://geekus.kr/ag-mastermind/post/write', home: 'https://geekus.kr/ag-mastermind', category: '컨텐츠저널링' };
const GEEKUS_POST_RE = /^https:\/\/geekus\.kr\/ag-mastermind\/post\/\d+$/;
const STEP_MARK = '<<<CJ_STEP>>>';
// aside repl에서 돌리는 고정 스크립트. __DATA__ 자리에만 글 내용(JSON)이 들어간다.
// 순서: 글쓰기 화면 열기 → (로그인이 풀려 있으면 로그인) → 카테고리 · 제목 · 본문 넣기 → 제대로 들어갔는지 확인 → 게시 → 글 주소 얻기
const GEEKUS_POST_SCRIPT = String.raw`await (async () => {
  const D = __DATA__;
  let step = '', tab = null; // 지금 하고 있는 단계와 작업 중인 탭 (오류가 나면 단계와 그때의 화면 주소를 함께 알린다)
  const here = () => { try { return tab ? tab.url() : ''; } catch (_) { return ''; } };
  const T0 = Date.now(); // Aside는 출력을 끝날 때 한꺼번에 넘기므로, 단계가 시작된 시각은 여기서 직접 잰다
  const say = t => { step = t; console.log('${STEP_MARK}' + (Date.now() - T0) + '|' + t); };
  const done = o => { console.log('${MARK_START}'); console.log(JSON.stringify(o)); console.log('${MARK_END}'); };
  const fail = (code, error, extra) => done(Object.assign({ ok: false, code: code, error: error, step: step, at: here() }, extra || {}));
  const clean = u => String(u).split(/[?#]/)[0].replace(/\/$/, '');
  const postUrl = u => { const m = clean(u).match(/^https:\/\/geekus\.kr\/ag-mastermind\/post\/\d+$/); return m ? m[0] : ''; };
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
  const run = async () => {

  say('글쓰기 화면 여는 중');
  tab = await openTab(D.write);
  if (clean(tab.url()) !== D.write) { // 로그인이 풀려 있으면 소개 화면으로 돌려보낸다
    if (!D.email || !D.password) return fail('login_required', '긱어스 로그인이 풀려 있습니다. ⚙ 설정에 긱어스 이메일과 비밀번호를 넣거나, Aside에서 geekus.kr에 로그인한 뒤 다시 시도하세요.');
    say('긱어스에 로그인하는 중');
    const LOGIN = 'https://geekus.kr/login';
    const has = sel => tab.evaluate(s => !!document.querySelector(s), sel);
    await tab.goto(LOGIN);
    for (let i = 0; i < 30 && !(await has('input[name="password"]')); i++) await sleep(300);
    // 지난 계정을 기억해 비밀번호만 묻는 화면에서는 계정 칸이 type="hidden"으로 남아 있다. 숨은 칸은 입력할 수 없으므로 보이는 칸만 센다.
    const ID = 'input[name="identifier"]:not([type="hidden"])', PW = 'input[name="password"]:not([type="hidden"])';
    const remembered = await tab.evaluate(() => { const el = document.querySelector('input[name="identifier"][type="hidden"]'); return el ? el.value : ''; });
    const sameAccount = !(await has(ID)) && remembered.trim().toLowerCase() === String(D.email).trim().toLowerCase(); // 기억된 계정이 설정의 계정과 같으면 비밀번호만 넣는다
    if (!sameAccount && !(await has(ID))) { // 다른 계정이 기억돼 있으면 계정 입력 화면으로 바꾼다
      await snapshot(tab, { interactive: true });
      await tab.getByRole('button', { name: '변경', exact: true }).click();
      for (let i = 0; i < 20 && !(await has(ID)); i++) await sleep(300);
    }
    if ((!sameAccount && !(await has(ID))) || !(await has(PW))) return fail('login_failed', '긱어스 로그인 화면에서 입력 칸을 찾지 못했습니다. Aside에서 geekus.kr에 직접 로그인한 뒤 다시 시도하세요.');
    say(sameAccount ? '기억된 계정으로 비밀번호 넣는 중' : '이메일 · 비밀번호 넣는 중');
    if (!sameAccount) await tab.locator(ID).fill(D.email);
    await tab.locator(PW).fill(D.password);
    await snapshot(tab, { interactive: true });
    say('로그인 버튼 누르고 결과 기다리는 중');
    await tab.locator('button[type="submit"]').click();
    for (let i = 0; i < 30 && clean(tab.url()) === LOGIN; i++) await sleep(500); // 로그인되면 다른 화면으로 넘어간다
    if (clean(tab.url()) === LOGIN) return fail('login_failed', '긱어스 로그인에 실패했습니다. ⚙ 설정의 긱어스 이메일과 비밀번호를 확인하세요.');
    say('로그인 완료, 글쓰기 화면으로 돌아가는 중');
    await tab.goto(D.write);
    if (clean(tab.url()) !== D.write) return fail('login_failed', '긱어스 로그인에 실패했습니다. ⚙ 설정의 긱어스 이메일과 비밀번호를 확인하세요.');
  }

  say('글쓰기 화면 준비 기다리는 중');
  let formReady = false;
  for (let i = 0; i < 40; i++) { // 글쓰기 화면이 다 준비될 때까지 (편집기가 붙으면 폼도 준비된 것)
    const ready = await tab.evaluate(() => { const el = document.querySelector('main .ProseMirror'); return !!(el && el.editor && document.querySelector('main [role="combobox"]') && document.querySelector('main textarea.editor-title-input')); });
    if (ready) { formReady = true; break; }
    await sleep(300);
  }
  if (!formReady) return fail('not_ready', '글쓰기 화면이 12초 안에 준비되지 않았습니다. (편집기 · 카테고리 · 제목 칸 중 찾지 못한 것이 있습니다)');
  say('카테고리 고르는 중');
  let cats = [];
  for (let i = 0; i < 3 && !cats.length; i++) { // 카테고리 목록 열기: 열리지 않았으면 다시 누른다
    const open = await tab.evaluate(() => document.querySelector('main [role="combobox"]')?.getAttribute('aria-expanded') === 'true');
    if (!open) await tab.locator('main [role="combobox"]').click();
    for (let j = 0; j < 10 && !cats.length; j++) {
      await sleep(200);
      cats = await tab.evaluate(() => [...document.querySelectorAll('[role="option"]')].map(o => (o.innerText || '').trim()));
    }
  }
  await snapshot(tab, { interactive: true });
  if (!cats.includes(D.category)) {
    await tab.keyboard.press('Escape');
    return fail('no_category', '"' + D.category + '" 카테고리를 찾지 못했습니다. (있는 카테고리: ' + cats.join(', ') + ')');
  }
  await tab.getByRole('option', { name: D.category, exact: true }).click();
  say('제목 넣는 중');
  await tab.locator('main textarea.editor-title-input').fill(D.title);
  say('본문 편집기 비우는 중');
  const hasEditor = await tab.evaluate(() => {
    const el = document.querySelector('main .ProseMirror'), ed = el && el.editor;
    if (ed) ed.chain().focus().clearContent(true).run();
    return !!ed;
  });
  if (!hasEditor) return fail('editor', '본문 편집기를 찾지 못해 게시하지 않았습니다.');
  // 본문 맨 위: 편집기의 "영상" 버튼으로 유튜브 영상을 임베드한다 (동영상 추가 창에 링크를 넣고 "추가")
  let embedded = false;
  if (D.video) {
    say('유튜브 영상 임베드하는 중');
    const LINK = 'input[placeholder="YouTube, Loom, Vimeo 링크"]';
    const has = sel => tab.evaluate(s => !!document.querySelector(s), sel);
    await snapshot(tab, { interactive: true });
    await tab.locator('main form button[aria-label="영상"]').click();
    for (let i = 0; i < 25 && !(await has(LINK)); i++) await sleep(200);
    if (await has(LINK)) {
      await tab.locator(LINK).fill(D.video);
      await snapshot(tab, { interactive: true });
      await tab.getByRole('button', { name: '추가', exact: true }).click();
      for (let i = 0; i < 30 && !embedded; i++) {
        await sleep(200);
        embedded = await tab.evaluate(() => (document.querySelector('main .ProseMirror').editor.getJSON().content || []).some(n => n.type === 'videoAttachment'));
      }
    }
    if (!embedded) { // 영상 없이 올리지 않는다: 열려 있는 창을 닫고 멈춘다
      await tab.keyboard.press('Escape');
      return fail('embed_failed', '유튜브 영상을 글에 임베드하지 못해 게시하지 않았습니다. (긱어스 편집기의 영상 추가 창이 바뀌었을 수 있습니다)');
    }
  }
  // 그 아래에 분석 내용을 이어 붙인다
  say('본문 넣는 중');
  const body = await tab.evaluate(h => {
    const ed = document.querySelector('main .ProseMirror').editor;
    ed.chain().focus('end').insertContent(h).run();
    return { ok: ed.getText().trim().length > 0, chars: ed.getText().length, blocks: (ed.getJSON().content || []).map(n => n.type) };
  }, D.html);
  if (!body.ok) return fail('editor', '본문 편집기에 내용을 넣지 못해 게시하지 않았습니다.');
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
  if (state.category !== D.category || state.title !== D.title || !state.canPost) {
    const why = [];
    if (state.category !== D.category) why.push('카테고리가 "' + state.category + '"로 되어 있음');
    if (state.title !== D.title) why.push('제목이 다르게 들어감 ("' + String(state.title).slice(0, 40) + '")');
    if (!state.canPost) why.push('게시 버튼이 없거나 눌리지 않는 상태');
    return fail('not_ready', '글쓰기 화면에 내용이 제대로 들어가지 않아 게시하지 않았습니다: ' + why.join(', '), { state: state });
  }
  if (D.dryRun) return done({ ok: true, dryRun: true, state: state, chars: body.chars, embedded: embedded, blocks: body.blocks }); // 시험용: 게시 직전에 멈춘다

  say('게시하는 중');
  await snapshot(tab, { interactive: true });
  await tab.getByRole('button', { name: '게시', exact: true }).click(); // 게시 버튼은 여기서 한 번만 누른다
  let url = '', confirmed = false;
  for (let i = 0; i < 60 && !url; i++) {
    await sleep(500);
    url = postUrl(tab.url());
    if (url || clean(tab.url()) !== D.write) break; // 글 화면 또는 글 목록으로 넘어갔다
    if (!confirmed && i >= 3) { // 확인 창이 뜨는 경우 한 번만 눌러 준다
      confirmed = await tab.evaluate(() => {
        const d = document.querySelector('[role="alertdialog"],[role="dialog"]');
        const b = d && [...d.querySelectorAll('button')].find(x => ['게시', '게시하기', '확인', '등록'].includes((x.innerText || '').trim()));
        if (b) b.click();
        return !!b;
      });
    }
  }
  if (!url) { // 글 화면으로 바로 넘어가지 않은 경우: 글 목록에서 방금 올린 제목의 글을 눌러 주소를 얻는다
    say('올린 글 주소 확인 중');
    tab.on('dialog', d => d.accept().catch(() => {}));
    if (clean(tab.url()) !== D.home) await tab.goto(D.home);
    for (let i = 0; i < 10 && !url; i++) {
      await sleep(700);
      const hit = await tab.evaluate(t => {
        const h = [...document.querySelectorAll('main h3')].find(x => (x.innerText || '').replace(/\s+/g, ' ').trim() === t);
        if (!h) return '';
        const a = h.querySelector('a') || h.closest('a');
        if (a && a.getAttribute('href')) return a.href;
        h.click();
        return 'clicked';
      }, oneLine(D.title));
      if (hit === 'clicked') { for (let j = 0; j < 12 && !url; j++) { await sleep(500); url = postUrl(tab.url()); } }
      else if (hit) url = postUrl(hit);
    }
  }
  if (url) return done({ ok: true, url: url });
  return fail('url_not_found', '게시 버튼을 눌렀지만 글 목록에서 올린 글을 찾지 못했습니다. 긱어스에서 글이 올라갔는지 먼저 확인해 주세요. (다시 올리면 글이 두 개가 될 수 있습니다)');
  };
  try { await run(); } catch (e) { // 예상하지 못한 오류: 어느 단계 · 어느 화면에서 났는지와 오류 원문을 그대로 돌려준다
    fail('script_error', String((e && e.message) || e), { name: String((e && e.name) || ''), stack: String((e && e.stack) || '').split('\n').slice(0, 8).join('\n') });
  }
})();
`;

async function geekusPost(cli, post, { onStep } = {}) {
  const data = { ...GEEKUS, title: post.title, html: post.html, video: post.video || '', email: post.email || '', password: post.password || '', dryRun: !!post.dryRun };
  // JSON은 그대로 자바스크립트 값으로 쓸 수 있다 (줄 구분 문자만 따로 처리). 스크립트는 표준 입력으로만 넘기므로 비밀번호가 명령줄이나 파일에 남지 않는다.
  const json = JSON.stringify(data).replace(/[\u2028\u2029]/g, c => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16));
  let pending = '';
  const t0 = Date.now(), steps = []; // 지나온 단계와 걸린 시간 (오류가 나면 어디까지 갔는지 보여 준다)
  const secs = ms => (ms / 1000).toFixed(1) + '초';
  const feed = chunk => {
    pending += chunk;
    const parts = pending.split('\n'); pending = parts.pop();
    for (const l of parts) {
      const t = cleanLine(l);
      if (!t.startsWith(STEP_MARK)) continue;
      const m = t.slice(STEP_MARK.length).match(/^(\d+)\|(.*)$/); // "스크립트 시작 뒤 지난 시간(ms)|단계 이름"
      steps.push({ at: m ? Number(m[1]) : Date.now() - t0, text: m ? m[2] : t.slice(STEP_MARK.length) });
      if (onStep) onStep(`${steps.length}단계 · ${steps[steps.length - 1].text}`);
    }
  };
  // 비밀번호 · 이메일은 오류 메시지와 로그 파일에 남기지 않는다
  const mask = s => [post.password, post.email].filter(x => x && x.length >= 3).reduce((a, x) => a.split(x).join('***'), String(s));
  let run, runError = null;
  try { run = await runAside(cli, ['repl', '--file', '-'], { input: GEEKUS_POST_SCRIPT.replace('__DATA__', () => json), onData: feed, timeout: REPL_TIMEOUT }); }
  catch (e) { runError = e; run = { code: null, out: '', all: '' }; }
  const { code, out, all } = run, total = Date.now() - t0;
  const trail = steps.map((s, i) => `  ${i + 1}. ${s.text} (${secs(s.at)}에 시작)`).join('\n') || '  (첫 단계도 시작하지 못했습니다)';
  // 실패하면 Aside가 내놓은 출력 전체를 data/logs 에 남기고, 화면에는 멈춘 단계 · 진행 기록 · 오류 원문을 보여 준다
  const explain = async (message, detail) => {
    const last = steps[steps.length - 1];
    let logNote = '';
    try {
      const dir = path.join(DATA, 'logs'), d = new Date(), p2 = n => String(n).padStart(2, '0');
      const file = path.join(dir, `geekus-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.log`);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, mask([`시각: ${d.toLocaleString('ko-KR')}`, `글 제목: ${post.title}`, `오류: ${message}`, `aside 종료 코드: ${code}`, `걸린 시간: ${secs(total)}`, '', '[진행 기록]', trail, '', '[상세]', detail || '(없음)', '', '[Aside 출력 전체]', cleanOutput(all).replace(new RegExp(STEP_MARK, 'g'), '▶ ')].join('\n')), 'utf8');
      logNote = `\n■ 전체 로그 파일: ${file}`;
    } catch { /* 로그를 남기지 못해도 오류 안내는 그대로 한다 */ }
    const text = mask([message, `■ 멈춘 단계: ${last ? `${steps.length}. ${last.text}` : '시작 전'} (전체 ${secs(total)} 걸림)`, `■ 진행 기록:\n${trail}`, detail ? `■ 상세:\n${detail}` : ''].filter(Boolean).join('\n')) + logNote;
    console.error(`[긱어스 올리기 실패]\n${text}\n`);
    return text;
  };
  if (runError) throw Object.assign(new Error(await explain('긱어스 글쓰기 중 오류: ' + (runError.message || String(runError)), '')), { status: runError.status });
  const marked = extractMarked(cleanOutput(out));
  if (marked == null) { // 스크립트가 결과를 내놓기 전에 Aside 쪽에서 끝난 경우: 오류 줄부터 끝까지(호출 위치 포함)를 그대로 보여 준다
    const lines = cleanOutput(all).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(STEP_MARK));
    const i = lines.findIndex(l => /^(Uncaught\s+)?\w*(Error|Exception)\b/.test(l));
    const errLine = i >= 0 ? lines[i].replace(/^(Uncaught\s+)?\w*Error:\s*/, '') : '';
    const detail = (i >= 0 ? lines.slice(i, i + 10) : lines.slice(-10)).join('\n').slice(0, 1500);
    throw new Error(await explain('긱어스 글쓰기 중 오류: ' + (errLine || `Aside가 오류 내용을 알려 주지 않고 끝났습니다 (종료 코드 ${code})`).slice(0, 300), `Aside 출력 (${i >= 0 ? '오류 줄부터' : '마지막 10줄'}):\n${detail}`));
  }
  let r;
  try { r = JSON.parse(marked); } catch { throw new Error(await explain('Aside가 돌려준 결과를 읽지 못했습니다', marked.slice(0, 500))); }
  if (!r.ok) {
    const detail = [r.at ? `화면 주소: ${r.at}` : '', r.name ? `오류 종류: ${r.name}` : '', r.stack ? `호출 위치:\n${r.stack}` : '', r.state ? `화면 상태: ${JSON.stringify(r.state)}` : ''].filter(Boolean).join('\n');
    throw Object.assign(new Error(await explain((r.code === 'script_error' ? '긱어스 글쓰기 중 오류: ' : '') + (r.error || '긱어스에 올리지 못했습니다'), detail)), { code: r.code });
  }
  if (r.dryRun) return { dryRun: true, state: r.state, chars: r.chars, embedded: r.embedded, blocks: r.blocks };
  if (!GEEKUS_POST_RE.test(r.url)) throw new Error('게시 후 받은 글 주소가 올바르지 않습니다');
  return { url: r.url };
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
    if (preparing) return send(res, 200, { ok: true, app: APP, version: VERSION, preparing, ytdlp: false, ffmpeg: false, aside: false, dataDir: DATA });
    const t = await getTools();
    return send(res, 200, { ok: true, app: APP, version: VERSION, preparing: '', ytdlp: !!t.ytdlp, ytdlpVersion: t.version, ffmpeg: !!t.ffmpeg, aside: !!(await findAside()), dataDir: DATA });
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
    const cli = await findAside();
    if (!cli) return send(res, 501, { error: 'Aside CLI가 설치되어 있지 않습니다 (Aside 설정 → Developers → Install)' });
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const emit = o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
    // 게시 버튼을 누른 뒤에 끊기면 글 주소를 놓치므로, 화면이 닫혀도 중간에 멈추지 않고 끝까지 간다
    try {
      const r = await geekusPost(cli, { title, html, video, email: String(body.email || ''), password: String(body.password || ''), dryRun: body.dryRun === true },
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
  if (await findAside()) console.log('  Aside CLI 사용 (긱어스에 올리기)');
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

module.exports = { server, start, deps, youtubeUrl, pickCaption, parseCaption, formatCues, extractFrames, getVideo, extractMarked, cleanOutput, download, prepareTools, DOWNLOADS };
