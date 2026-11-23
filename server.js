'use strict';
/*
 * 우리 반 가상 미술관 - 서버
 * - 학생: 반 + 번호 + 숫자 4자리 비밀번호 (선생님이 만들어서 인쇄해 나눠 줌)
 * - 교사: 반 + 교사 비밀번호 (기본값 1234) → 비밀번호 만들기·인쇄, 전시 열기, 작품 내리기, 감상평 지우기
 * - 저장: 글자 정보는 Firestore, 그림 파일은 Firebase Storage (서비스 계정 키 없이 접속)
 *         (FIREBASE_CONFIG가 없으면 data 폴더에 임시 저장)
 * - 명화: 시카고 미술관 퍼블릭 도메인 작품 + 학생이 직접 찾아 올린 명화
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const compression = require('compression');

const app = express();
app.use(compression()); // 화면 파일·3D 라이브러리를 압축해서 전송
app.use(express.json({ limit: '3mb' }));
const PORT = process.env.PORT || 3000;

// ================= 반 설정 =================
// 기본값: 6학년 1반~5반. 바꾸려면 Render 환경변수 CLASS_LIST에 "6-1,6-2,6-3" 처럼 적으면 됩니다.
const CLASS_IDS = (process.env.CLASS_LIST || '6-1,6-2,6-3,6-4,6-5')
  .split(',').map(s => s.trim()).filter(s => /^\d+-\d+$/.test(s));
const CLASSES = CLASS_IDS.map(id => { const [g, c] = id.split('-'); return { id, name: `${g}학년 ${c}반` }; });
const MAX_STUDENTS = Math.min(40, Math.max(1, Number(process.env.MAX_STUDENTS) || 30));
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('[안내] SESSION_SECRET 환경변수가 없어서 서버가 다시 켜질 때마다 모두 다시 로그인해야 합니다.');
const DEFAULT_TEACHER_PW = '1234';
function teacherPw(cid) {
  return process.env['TEACHER_PASSWORD_' + cid.replace(/-/g, '_')] || process.env.TEACHER_PASSWORD || DEFAULT_TEACHER_PW;
}

// ================= 저장소 =================
/*
 * 서비스 계정 키 없이 Firebase에 접속합니다.
 * (학교·교육용 구글 계정은 조직 정책 때문에 서비스 계정 키를 만들 수 없어서)
 * 서버는 Firebase Authentication에 만든 '서버 전용 계정'으로 로그인하고,
 * Firestore·Storage 보안 규칙은 이 계정만 읽고 쓸 수 있게 막아 둡니다. (README 참고)
 * 필요한 환경변수: FIREBASE_CONFIG (웹 앱 설정), FIREBASE_SERVER_PASSWORD (서버 전용 계정 비밀번호)
 */
const FB_EMAIL = process.env.FIREBASE_SERVER_EMAIL || 'gallery-server@artgallery.app';
let fb = null; // { F: firestore 함수들, db, ST: storage 함수들, storage, bucket }

// Firebase 콘솔의 firebaseConfig 내용을 그대로 붙여넣어도 읽을 수 있게 (const firebaseConfig = { apiKey: "..." ... })
function parseConfig(s) {
  const o = {};
  String(s || '').replace(/["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g, (m, k, v) => { o[k] = v; return m; });
  return o;
}
function fbError(e) {
  const c = (e && e.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return `서버 전용 계정(${FB_EMAIL})의 이메일이나 비밀번호가 맞지 않아요. Authentication에 이 계정이 있는지, FIREBASE_SERVER_PASSWORD가 맞는지 확인해 주세요.`;
  if (/operation-not-allowed/.test(c)) return 'Authentication에서 "이메일/비밀번호" 로그인을 사용 설정해 주세요.';
  if (/permission-denied|unauthorized/.test(c)) return '보안 규칙이 막고 있어요. README의 규칙을 그대로 붙여넣고 [게시]를 눌렀는지 확인해 주세요.';
  if (/api-key|invalid-api-key/.test(c)) return 'FIREBASE_CONFIG의 apiKey가 올바르지 않아요.';
  if (/not-found|NOT_FOUND/.test(c + (e && e.message))) return 'Firestore 데이터베이스가 아직 없어요. Firestore Database → 데이터베이스 만들기를 눌러 주세요.';
  return (c ? c + ' ' : '') + (e && e.message ? e.message : e);
}
async function initFirebase() {
  const cfg = parseConfig(process.env.FIREBASE_CONFIG);
  if (!cfg.apiKey || !cfg.projectId) {
    console.warn('[저장소] FIREBASE_CONFIG가 없어서 임시 저장소(data 폴더)를 씁니다. Render 무료 서버에서는 서버가 다시 켜지면 지워집니다.');
    return;
  }
  if (!process.env.FIREBASE_SERVER_PASSWORD) { console.warn('[저장소] FIREBASE_SERVER_PASSWORD가 없어서 임시 저장소를 씁니다.'); return; }
  const { initializeApp } = require('firebase/app');
  const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
  const F = require('firebase/firestore');
  const fbApp = initializeApp(cfg);
  // 잠깐의 네트워크 문제로 임시 저장소로 넘어가지 않도록 몇 번 다시 시도
  for (let attempt = 1; ; attempt++) {
    try {
      await signInWithEmailAndPassword(getAuth(fbApp), FB_EMAIL, process.env.FIREBASE_SERVER_PASSWORD);
      const db = F.getFirestore(fbApp);
      await F.getDoc(F.doc(db, 'meta', 'ping')); // 읽기 권한 확인
      fb = { F, db };
      console.log('[저장소] Firebase Firestore 사용:', cfg.projectId);
      break;
    } catch (e) {
      const network = /network|unavailable|deadline/i.test((e && e.code) || '');
      if (network && attempt < 4) { console.warn(`[저장소] Firebase 연결 재시도 (${attempt}/3)…`); await new Promise(r => setTimeout(r, 5000)); continue; }
      console.error('[저장소] Firebase 연결 실패 → 임시 저장소를 씁니다. 이유:', fbError(e));
      fb = null;
      return;
    }
  }
  if (!cfg.storageBucket) { console.warn('[그림 저장소] FIREBASE_CONFIG에 storageBucket이 없어서 그림을 임시 폴더에 저장합니다.'); return; }
  try {
    const ST = require('firebase/storage');
    const storage = ST.getStorage();
    await ST.uploadString(ST.ref(storage, 'meta/ping.txt'), 'ok'); // 쓰기 권한 확인
    Object.assign(fb, { ST, storage, bucket: cfg.storageBucket });
    console.log('[그림 저장소] Firebase Storage 사용:', cfg.storageBucket);
  } catch (e) {
    console.warn('[그림 저장소] Storage에 연결하지 못해 그림을 임시 폴더에 저장합니다. 이유:', fbError(e));
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const cache = new Map();      // 읽은 문서는 서버 메모리에 보관 → Firestore 읽기 횟수 최소화
const inflight = new Map();
const writeChain = new Map(); // 같은 문서 쓰기는 순서대로
const pending = new Map();    // 몰아서 쓰기 예약

async function getDoc(col, id) {
  const k = col + '/' + id;
  if (cache.has(k)) return cache.get(k);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      let v = null;
      if (fb) {
        const s = await fb.F.getDoc(fb.F.doc(fb.db, col, id));
        v = s.exists() ? s.data() : null;
      } else {
        const f = path.join(DATA_DIR, col, encodeURIComponent(id) + '.json');
        if (fs.existsSync(f)) v = JSON.parse(fs.readFileSync(f, 'utf8'));
      }
      if (!cache.has(k)) cache.set(k, v);
      return cache.get(k);
    } finally { inflight.delete(k); }
  })();
  inflight.set(k, p);
  return p;
}
function setDoc(col, id, v) {
  const k = col + '/' + id;
  cache.set(k, v);
  if (pending.has(k)) { clearTimeout(pending.get(k)); pending.delete(k); }
  const snapshot = JSON.stringify(v);
  const prev = writeChain.get(k) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (fb) await fb.F.setDoc(fb.F.doc(fb.db, col, id), JSON.parse(snapshot));
    else {
      const d = path.join(DATA_DIR, col);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, encodeURIComponent(id) + '.json'), snapshot);
    }
  });
  writeChain.set(k, next);
  return next;
}
// 반 요약 문서는 여러 학생이 동시에 저장해도 몇 초에 한 번만 기록
function setDocLater(col, id, delay = 4000) {
  const k = col + '/' + id;
  if (pending.has(k)) return;
  pending.set(k, setTimeout(() => {
    pending.delete(k);
    setDoc(col, id, cache.get(k)).catch(e => console.error('[저장 실패]', k, e.message));
  }, delay));
}
async function flushPending() {
  const jobs = [];
  for (const k of [...pending.keys()]) {
    const i = k.indexOf('/');
    jobs.push(setDoc(k.slice(0, i), k.slice(i + 1), cache.get(k)));
  }
  await Promise.allSettled(jobs);
  await Promise.allSettled([...writeChain.values()]);
}
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, async () => { await flushPending(); process.exit(0); }));

// ----- 그림 파일 -----
const IMG_PATH = /^img\/(\d+-\d+)\/(\d+)\/\d+-[0-9a-f]{8}\.jpg$/;
async function saveImage(p, buf) {
  if (fb && fb.storage) {
    const r = fb.ST.ref(fb.storage, p);
    await fb.ST.uploadBytes(r, new Uint8Array(buf), { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000' });
    return await fb.ST.getDownloadURL(r);
  }
  const f = path.join(UP_DIR, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  return '/uploads/' + p;
}
async function readImage(p) {
  if (fb && fb.storage) return Buffer.from(await fb.ST.getBytes(fb.ST.ref(fb.storage, p)));
  const f = path.join(UP_DIR, p);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
function deleteImage(p) {
  if (fb && fb.storage) fb.ST.deleteObject(fb.ST.ref(fb.storage, p)).catch(() => {});
  else fs.promises.unlink(path.join(UP_DIR, p)).catch(() => {});
}
function validUrl(p, url) {
  if (typeof url !== 'string') return false;
  if (fb && fb.storage) return url.startsWith(`https://firebasestorage.googleapis.com/v0/b/${fb.bucket}/o/${encodeURIComponent(p)}?alt=media`);
  return url === '/uploads/' + p;
}
function ownPath(u, p) {
  const m = IMG_PATH.exec(String(p || ''));
  return !!m && m[1] === u.c && Number(m[2]) === u.n;
}

// ================= 로그인 토큰 =================
function sign(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  const h = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  return b + '.' + h;
}
function verify(t) {
  if (!t || typeof t !== 'string') return null;
  const [b, h] = t.split('.');
  if (!b || !h) return null;
  const h2 = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (h.length !== h2.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(h2))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.t;
  const p = verify(t);
  if (!p) return res.status(401).json({ error: '다시 로그인해 주세요.' });
  req.user = p;
  next();
}
const TOKEN_HOURS = 12;

// ================= 도우미 =================
const isClass = id => CLASS_IDS.includes(id);
const gid = (cid, n) => `${cid}_${n}`;
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const clampInt = (v, a, b) => Math.min(b, Math.max(a, Math.round(Number(v) || 0)));
const IMG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JPEG_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const LAYOUT_KEYS = ['corridor', 'ell', 'oct', 'partition'];
const FRAME_COUNT = 10;
function err(res, e) { console.error(e); res.status(500).json({ error: '서버에 문제가 생겼어요. 잠시 뒤 다시 해 주세요.' }); }
const sameStr = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function getClass(cid) {
  let c = await getDoc('classes', cid);
  if (!c) { c = { open: false, size: 0, students: {}, pins: {} }; cache.set('classes/' + cid, c); }
  c.students = c.students || {}; c.pins = c.pins || {}; c.size = c.size || 0;
  return c;
}
// 학생 비밀번호: 무작위 숫자 4자리 (반 안에서 겹치지 않게, 쉬운 숫자 제외)
const EASY = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '9876', '1004', '2580']);
function genPin(c) {
  const used = new Set(Object.values(c.pins).filter(v => typeof v === 'string'));
  for (;;) {
    const p = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!EASY.has(p) && !used.has(p)) return p;
  }
}
function defaultGallery() {
  return { layout: 'ell', wall: 0, floor: 0, galleryName: '', intro: '', frames: Array(FRAME_COUNT).fill(null), painting: null, updatedAt: 0 };
}
async function updateSummary(cid, n, g) {
  const c = await getClass(cid);
  const s = c.students[n] || (c.students[n] = { name: n + '번' });
  s.galleryName = g.galleryName;
  s.layout = g.layout;
  s.hasPainting = !!g.painting;
  s.count = g.frames.filter(Boolean).length;
  s.updatedAt = Date.now();
  setDocLater('classes', cid);
}
async function canView(u, cid, n) {
  if (u.c !== cid) return false;
  if (u.r === 't') return true;
  if (u.n === n) return true;
  return !!(await getClass(cid)).open;
}
const imgPaths = g => [...(g.frames || []).filter(f => f && f.src === 'up').map(f => f.path), g.painting && g.painting.path].filter(Boolean);

// 비밀번호 여러 번 틀리면 1분 잠금
const fails = new Map();
const locked = k => { const f = fails.get(k); return f && f.until > Date.now(); };
function fail(k) {
  const f = fails.get(k) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  fails.set(k, f);
}

// ================= 기본 정보 =================
app.get('/api/config', (req, res) => {
  res.json({ classes: CLASSES, maxStudents: MAX_STUDENTS, storage: fb ? 'firestore' : 'local', images: fb && fb.storage ? 'firebase' : 'local' });
});

// ================= 로그인 =================
app.post('/api/login', async (req, res) => {
  try {
    const { classId, num, pin, name } = req.body || {};
    const n = Number(num);
    if (!isClass(classId) || !Number.isInteger(n) || n < 1 || n > MAX_STUDENTS) return res.status(400).json({ error: '반과 번호를 확인해 주세요.' });
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: '비밀번호는 숫자 4자리예요.' });
    const key = classId + '#' + n;
    if (locked(key)) return res.status(429).json({ error: '비밀번호를 여러 번 틀렸어요. 1분 뒤에 다시 해 보세요.' });
    const c = await getClass(classId);
    const real = c.pins[n];
    if (typeof real !== 'string') return res.status(401).json({ error: '아직 비밀번호가 없어요. 선생님께 비밀번호를 받아 주세요.' });
    if (!sameStr(pin, real)) { fail(key); return res.status(401).json({ error: '비밀번호가 맞지 않아요. 선생님께 받은 종이를 다시 확인해 주세요.' }); }
    fails.delete(key);
    const st = c.students[n] || {};
    if (!st.name) {
      const nm = str(name, 10);
      if (!nm) return res.json({ needName: true });
      c.students[n] = Object.assign({}, st, { name: nm });
      await setDoc('classes', classId, c);
    }
    res.json({
      token: sign({ r: 's', c: classId, n, exp: Date.now() + TOKEN_HOURS * 3600e3 }),
      me: { role: 'student', classId, num: n, name: c.students[n].name }
    });
  } catch (e) { err(res, e); }
});

app.post('/api/teacher/login', (req, res) => {
  const { classId, password } = req.body || {};
  if (!isClass(classId)) return res.status(400).json({ error: '반을 골라 주세요.' });
  const key = 'T#' + classId;
  if (locked(key)) return res.status(429).json({ error: '여러 번 틀렸어요. 1분 뒤에 다시 해 보세요.' });
  if (!sameStr(password || '', teacherPw(classId))) { fail(key); return res.status(401).json({ error: '교사 비밀번호가 맞지 않아요.' }); }
  fails.delete(key);
  res.json({
    token: sign({ r: 't', c: classId, exp: Date.now() + TOKEN_HOURS * 3600e3 }),
    me: { role: 'teacher', classId, name: '선생님' }
  });
});

// ================= 반 목록 (문서 1개만 읽음) =================
app.get('/api/class/:cid', auth, async (req, res) => {
  try {
    const { cid } = req.params;
    if (req.user.c !== cid) return res.status(403).json({ error: '우리 반 전시관만 볼 수 있어요.' });
    const c = await getClass(cid);
    const row = (n, s) => ({ num: n, name: s.name || '', galleryName: s.galleryName || '', layout: s.layout || '', hasPainting: !!s.hasPainting, count: s.count || 0, saved: !!s.updatedAt });
    if (req.user.r === 't') {
      const top = Math.max(c.size, ...Object.keys(c.students).map(Number), ...Object.keys(c.pins).map(Number), 0);
      const students = [];
      for (let n = 1; n <= top; n++) students.push(Object.assign(row(n, c.students[n] || {}), { pin: typeof c.pins[n] === 'string' ? c.pins[n] : '' }));
      return res.json({ open: !!c.open, size: c.size, students });
    }
    const students = c.open ? Object.entries(c.students).map(([n, s]) => row(+n, s)).filter(s => s.saved).sort((a, b) => a.num - b.num) : [];
    res.json({ open: !!c.open, students });
  } catch (e) { err(res, e); }
});

// ================= 전시관 =================
app.get('/api/gallery/:cid/:num', auth, async (req, res) => {
  try {
    const { cid } = req.params; const n = Number(req.params.num);
    if (!(await canView(req.user, cid, n))) return res.status(403).json({ error: '선생님이 전시를 열면 친구 전시관을 볼 수 있어요.' });
    const g = await getDoc('galleries', gid(cid, n));
    const c = await getClass(cid);
    res.json({ gallery: g, name: (c.students[n] && c.students[n].name) || n + '번' });
  } catch (e) { err(res, e); }
});

// 그림 파일 올리기 (명화 직접 올리기, 내 그림) → Firebase Storage
const upLog = new Map();
app.post('/api/upload', auth, async (req, res) => {
  try {
    const u = req.user;
    if (u.r !== 's') return res.status(403).json({ error: '학생만 올릴 수 있어요.' });
    const data = (req.body || {}).data;
    if (typeof data !== 'string' || !JPEG_URL.test(data)) return res.status(400).json({ error: '그림 파일 형식이 올바르지 않아요.' });
    if (data.length > 1000000) return res.status(413).json({ error: '그림 파일이 너무 커요.' });
    const k = u.c + '#' + u.n, now = Date.now();
    const log = (upLog.get(k) || []).filter(t => t > now - 3600e3);
    if (log.length >= 60) return res.status(429).json({ error: '그림을 너무 많이 올렸어요. 잠시 뒤 다시 해 주세요.' });
    log.push(now); upLog.set(k, log);
    const p = `img/${u.c}/${u.n}/${now}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    const url = await saveImage(p, Buffer.from(data.split(',')[1], 'base64'));
    res.json({ path: p, url });
  } catch (e) { err(res, e); }
});

function cleanFrame(f, u) {
  if (!f || typeof f !== 'object') return null;
  const info = { title: str(f.title, 60), artist: str(f.artist, 40), date: str(f.date, 30), desc: str(f.desc, 80) };
  if (f.src === 'up') {
    if (!ownPath(u, f.path) || !validUrl(f.path, f.url)) return null;
    return Object.assign({ src: 'up', path: f.path, url: f.url }, info);
  }
  if (!IMG_ID.test(f.imageId || '')) return null;
  return Object.assign({ src: 'aic', id: Number(f.id) || 0, imageId: f.imageId }, info);
}

// 저장은 요청 1번으로: 전시관 문서 1개 + 반 요약(몇 초에 한 번)
app.put('/api/save', auth, async (req, res) => {
  try {
    const u = req.user;
    if (u.r !== 's') return res.status(403).json({ error: '학생만 자기 전시관을 꾸밀 수 있어요.' });
    const b = req.body || {};
    const id = gid(u.c, u.n);
    const old = (await getDoc('galleries', id)) || defaultGallery();
    let painting = old.painting || null;
    const p = b.painting;
    if (p && typeof p === 'object') {
      if (p.path) {
        if (!ownPath(u, p.path) || !validUrl(p.path, p.url)) return res.status(400).json({ error: '그림 정보가 올바르지 않아요.' });
        painting = { path: p.path, url: p.url, title: str(p.title, 30), desc: str(p.desc, 150), v: Date.now() };
      } else if (painting) {
        painting = Object.assign({}, painting, { title: str(p.title, 30), desc: str(p.desc, 150) });
      }
    }
    const frames = Array.isArray(b.frames) ? b.frames : [];
    const g = {
      layout: LAYOUT_KEYS.includes(b.layout) ? b.layout : 'ell',
      wall: clampInt(b.wall, 0, 4), floor: clampInt(b.floor, 0, 2),
      galleryName: str(b.galleryName, 20), intro: str(b.intro, 80),
      frames: Array.from({ length: FRAME_COUNT }, (_, i) => cleanFrame(frames[i], u)),
      painting, updatedAt: Date.now()
    };
    await setDoc('galleries', id, g);
    await updateSummary(u.c, u.n, g);
    // 더 이상 쓰지 않는 그림 파일은 지움 (저장 공간 아끼기)
    const keep = new Set(imgPaths(g));
    imgPaths(old).filter(x => !keep.has(x)).forEach(deleteImage);
    res.json({ ok: true, gallery: g });
  } catch (e) { err(res, e); }
});

// 학교망 등에서 Storage 그림을 바로 못 불러올 때만 쓰는 우회 경로
const upCache = new Map();
app.get('/api/upimg', auth, async (req, res) => {
  try {
    const p = String(req.query.p || '');
    const m = IMG_PATH.exec(p);
    if (!m) return res.status(400).end();
    if (!(await canView(req.user, m[1], Number(m[2])))) return res.status(403).end();
    let buf = upCache.get(p);
    if (!buf) {
      buf = await readImage(p).catch(() => null);
      if (!buf) return res.status(404).end();
      upCache.set(p, buf);
      if (upCache.size > 80) upCache.delete(upCache.keys().next().value);
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(buf);
  } catch (e) { res.status(502).end(); }
});

// ================= 감상평 (내 그림에만) =================
const lastComment = new Map();
app.get('/api/comments/:cid/:num', auth, async (req, res) => {
  try {
    const { cid } = req.params; const n = Number(req.params.num);
    if (!(await canView(req.user, cid, n))) return res.status(403).json({ error: '볼 수 없어요.' });
    const d = (await getDoc('comments', gid(cid, n))) || { list: [] };
    const c = await getClass(cid);
    res.json({ list: d.list, canWrite: req.user.r === 't' || !!c.open });
  } catch (e) { err(res, e); }
});
app.post('/api/comments/:cid/:num', auth, async (req, res) => {
  try {
    const u = req.user; const { cid } = req.params; const n = Number(req.params.num);
    if (!(await canView(u, cid, n))) return res.status(403).json({ error: '볼 수 없어요.' });
    const c = await getClass(cid);
    if (u.r !== 't' && !c.open) return res.status(403).json({ error: '전시가 열리면 감상평을 남길 수 있어요.' });
    const text = str((req.body || {}).text, 80);
    if (text.length < 2) return res.status(400).json({ error: '감상평을 두 글자 이상 적어 주세요.' });
    const who = u.r === 't' ? 'T' : u.n;
    const lk = cid + '#' + who;
    if ((lastComment.get(lk) || 0) > Date.now() - 10000) return res.status(429).json({ error: '10초 뒤에 다시 남길 수 있어요.' });
    lastComment.set(lk, Date.now());
    const id = gid(cid, n);
    const d = (await getDoc('comments', id)) || { list: [] };
    d.list.push({ by: who, name: u.r === 't' ? '선생님' : ((c.students[u.n] && c.students[u.n].name) || u.n + '번'), text, at: Date.now() });
    if (d.list.length > 100) d.list = d.list.slice(-100);
    await setDoc('comments', id, d);
    res.json({ list: d.list });
  } catch (e) { err(res, e); }
});
app.delete('/api/comments/:cid/:num/:at', auth, async (req, res) => {
  try {
    const u = req.user; const { cid } = req.params; const n = Number(req.params.num); const at = Number(req.params.at);
    if (u.c !== cid) return res.status(403).json({ error: '지울 수 없어요.' });
    const id = gid(cid, n);
    const d = (await getDoc('comments', id)) || { list: [] };
    const i = d.list.findIndex(x => x.at === at);
    if (i < 0) return res.json({ list: d.list });
    const mine = u.r === 's' && d.list[i].by === u.n;
    if (u.r !== 't' && !mine) return res.status(403).json({ error: '내가 쓴 감상평만 지울 수 있어요.' });
    d.list.splice(i, 1);
    await setDoc('comments', id, d);
    res.json({ list: d.list });
  } catch (e) { err(res, e); }
});

// ================= 교사 기능 =================
function teacherOnly(req, res, next) { if (req.user.r !== 't') return res.status(403).json({ error: '선생님만 할 수 있어요.' }); next(); }
app.post('/api/teacher/open', auth, teacherOnly, async (req, res) => {
  try {
    const c = await getClass(req.user.c);
    c.open = !!(req.body || {}).open;
    await setDoc('classes', req.user.c, c);
    res.json({ open: c.open });
  } catch (e) { err(res, e); }
});
// 학생 수만큼 비밀번호 만들기 (이미 있는 학생은 그대로)
app.post('/api/teacher/pins', auth, teacherOnly, async (req, res) => {
  try {
    const size = clampInt((req.body || {}).size, 1, MAX_STUDENTS);
    const c = await getClass(req.user.c);
    c.size = size;
    for (let n = 1; n <= size; n++) if (typeof c.pins[n] !== 'string') c.pins[n] = genPin(c);
    await setDoc('classes', req.user.c, c);
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});
// 한 학생 비밀번호 새로 만들기
app.post('/api/teacher/resetpin', auth, teacherOnly, async (req, res) => {
  try {
    const n = clampInt((req.body || {}).num, 1, MAX_STUDENTS);
    const c = await getClass(req.user.c);
    c.pins[n] = genPin(c);
    await setDoc('classes', req.user.c, c);
    res.json({ pin: c.pins[n] });
  } catch (e) { err(res, e); }
});
app.post('/api/teacher/name', auth, teacherOnly, async (req, res) => {
  try {
    const n = clampInt((req.body || {}).num, 1, MAX_STUDENTS);
    const c = await getClass(req.user.c);
    c.students[n] = Object.assign({}, c.students[n] || {}, { name: str((req.body || {}).name, 10) });
    await setDoc('classes', req.user.c, c);
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});
// 부적절한 작품 내리기 (slot: 0~9 명화 자리, 's' 내 그림)
app.post('/api/teacher/hide', auth, teacherOnly, async (req, res) => {
  try {
    const { num, slot } = req.body || {};
    const n = clampInt(num, 1, MAX_STUDENTS), id = gid(req.user.c, n);
    const g = await getDoc('galleries', id);
    if (!g) return res.status(404).json({ error: '전시관이 없어요.' });
    let gone = null;
    if (slot === 's') { gone = g.painting && g.painting.path; g.painting = null; }
    else { const i = clampInt(slot, 0, FRAME_COUNT - 1); const f = g.frames[i]; gone = f && f.src === 'up' ? f.path : null; g.frames[i] = null; }
    g.updatedAt = Date.now();
    await setDoc('galleries', id, g);
    await updateSummary(req.user.c, n, g);
    if (gone) deleteImage(gone);
    res.json({ ok: true, gallery: g });
  } catch (e) { err(res, e); }
});

// ================= 명화 (시카고 미술관 퍼블릭 도메인) =================
const AIC_HEADERS = { 'AIC-User-Agent': 'class-virtual-gallery (elementary school art class)' };
// [검색어, 작가 확인용 단어, 한국어 제목, 한국어 작가명]
const CURATED = [
  ['The Bedroom Vincent van Gogh', 'gogh', '침실', '빈센트 반 고흐'],
  ['Self-Portrait 1887 Vincent van Gogh', 'gogh', '자화상', '빈센트 반 고흐'],
  ["The Poet's Garden van Gogh", 'gogh', '시인의 정원', '빈센트 반 고흐'],
  ['Fishing in Spring, the Pont de Clichy', 'gogh', '봄날의 낚시, 클리시 다리', '빈센트 반 고흐'],
  ['A Sunday on La Grande Jatte 1884', 'seurat', '그랑드자트 섬의 일요일 오후', '조르주 쇠라'],
  ['Final Study for Bathers at Asnieres', 'seurat', '아니에르의 물놀이(최종 습작)', '조르주 쇠라'],
  ['Water Lilies Claude Monet', 'monet', '수련', '클로드 모네'],
  ['Water Lily Pond Claude Monet', 'monet', '수련 연못', '클로드 모네'],
  ['Stacks of Wheat (End of Summer)', 'monet', '건초 더미(늦여름)', '클로드 모네'],
  ['Arrival of the Normandy Train, Gare Saint-Lazare', 'monet', '생라자르 역의 노르망디 기차', '클로드 모네'],
  ['The Beach at Sainte-Adresse', 'monet', '생타드레스 해변', '클로드 모네'],
  ['Cliff Walk at Pourville', 'monet', '푸르빌 절벽 산책', '클로드 모네'],
  ['Paris Street; Rainy Day', 'caillebotte', '파리의 거리, 비 오는 날', '귀스타브 카유보트'],
  ['Under the Wave off Kanagawa', 'hokusai', '가나가와 해변의 높은 파도 아래', '가쓰시카 호쿠사이'],
  ['Fine Wind, Clear Morning Hokusai', 'hokusai', '개풍쾌청(붉은 후지산)', '가쓰시카 호쿠사이'],
  ['Two Sisters (On the Terrace)', 'renoir', '두 자매(테라스에서)', '피에르오귀스트 르누아르'],
  ['Acrobats at the Cirque Fernando', 'renoir', '페르난도 서커스의 곡예사들', '피에르오귀스트 르누아르'],
  ["The Child's Bath Mary Cassatt", 'cassatt', '아이의 목욕', '메리 커샛'],
  ['At the Moulin Rouge Toulouse-Lautrec', 'toulouse', '물랭 루주에서', '앙리 드 툴루즈로트레크'],
  ['The Basket of Apples Cezanne', 'cezanne', '사과 바구니', '폴 세잔'],
  ["The Bay of Marseille, Seen from L'Estaque", 'cezanne', '레스타크에서 본 마르세유 만', '폴 세잔'],
  ['Madame Cezanne in a Yellow Chair', 'cezanne', '노란 의자에 앉은 세잔 부인', '폴 세잔'],
  ['Why Are You Angry? Gauguin', 'gauguin', '왜 화가 났니?', '폴 고갱'],
  ['The Millinery Shop Degas', 'degas', '모자 가게', '에드가 드가'],
  ['Ballet at the Paris Opera Degas', 'degas', '파리 오페라의 발레', '에드가 드가'],
  ['The Assumption of the Virgin El Greco', 'greco', '성모 승천', '엘 그레코'],
  ['Old Man with a Gold Chain', 'rembrandt', '금목걸이를 한 노인', '렘브란트'],
  ['Haymaking at Eragny Pissarro', 'pissarro', '에라니의 건초 만들기', '카미유 피사로'],
  ['Interrupted Reading Corot', 'corot', '중단된 독서', '장바티스트 카미유 코로'],
  ['Improvisation No. 30 (Cannons)', 'kandinsky', '즉흥 30(대포)', '바실리 칸딘스키'],
  ['Painting with Green Center Kandinsky', 'kandinsky', '초록 중심이 있는 그림', '바실리 칸딘스키'],
  ['The Herring Net Winslow Homer', 'homer', '청어 그물', '윈슬로 호머'],
  ['Fishing Boats with Hucksters Bargaining for Fish', 'turner', '생선을 흥정하는 어선들', '윌리엄 터너'],
  ['Nocturne: Blue and Gold Southampton Water', 'whistler', '녹턴: 청색과 금색', '제임스 휘슬러']
];
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function aicSearch(q, limit) {
  const url = 'https://api.artic.edu/api/v1/artworks/search?q=' + encodeURIComponent(q) + '&limit=' + limit +
    '&fields=id,title,artist_title,date_display,image_id,is_public_domain';
  const r = await fetch(url, { headers: AIC_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('AIC ' + r.status);
  const j = await r.json();
  return (j.data || []).filter(a => a.is_public_domain && a.image_id && IMG_ID.test(a.image_id));
}

let catalog = { items: [], status: 'idle' };
async function loadCatalog() {
  if (catalog.status === 'loading') return;
  catalog.status = 'loading';
  try {
    const saved = await getDoc('meta', 'catalog');
    if (saved && saved.items && saved.items.length >= 10 && Date.now() - saved.at < 30 * 86400e3) {
      catalog = { items: saved.items, status: 'ready' };
      return;
    }
    const items = [];
    for (const [q, match, ko, koArtist] of CURATED) {
      try {
        const hits = await aicSearch(q, 10);
        const a = hits.find(h => norm(h.artist_title).includes(match));
        if (a && !items.some(x => x.id === a.id)) {
          items.push({ id: a.id, imageId: a.image_id, title: a.title, artist: a.artist_title, date: a.date_display || '', ko, koArtist });
        }
      } catch (e) { console.warn('[명화] 찾기 실패:', q, e.message); }
      await new Promise(r => setTimeout(r, 120));
    }
    catalog = { items, status: items.length ? 'ready' : 'error' };
    if (items.length >= 10) await setDoc('meta', 'catalog', { items, at: Date.now() });
    console.log(`[명화] 추천 목록 ${items.length}점 준비 완료`);
  } catch (e) {
    console.error('[명화] 목록 준비 실패', e.message);
    catalog.status = 'error';
  }
}
app.get('/api/art/catalog', auth, (req, res) => {
  if (catalog.status !== 'ready' && catalog.status !== 'loading') loadCatalog();
  res.json(catalog);
});

const searchCache = new Map();
app.get('/api/art/search', auth, async (req, res) => {
  try {
    const q = str(req.query.q, 60);
    if (q.length < 2) return res.json({ items: [] });
    const k = q.toLowerCase();
    if (searchCache.has(k)) return res.json({ items: searchCache.get(k) });
    const items = (await aicSearch(q, 40)).slice(0, 24).map(a => ({
      id: a.id, imageId: a.image_id, title: a.title, artist: a.artist_title || '작가 미상', date: a.date_display || ''
    }));
    searchCache.set(k, items);
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    res.json({ items });
  } catch (e) {
    console.warn('[명화 검색] 실패', e.message);
    res.status(502).json({ error: '명화 검색이 잠시 안 돼요. 추천 명화에서 고르거나 직접 올려 주세요.' });
  }
});

// 미술관 그림을 학교망에서 바로 못 받을 때만 서버가 대신 받아 줌 (같은 그림은 한 번만 받아서 나눠 줌)
const imgCache = new Map(), imgInflight = new Map();
const IMG_SIZES = { s: '200,', m: '843,' };
app.get('/api/img/:id/:size', async (req, res) => {
  try {
    const { id, size } = req.params;
    if (!IMG_ID.test(id) || !IMG_SIZES[size]) return res.status(400).end();
    const k = id + size;
    let buf = imgCache.get(k);
    if (!buf) {
      let job = imgInflight.get(k);
      if (!job) {
        job = (async () => {
          const r = await fetch(`https://www.artic.edu/iiif/2/${id}/full/${IMG_SIZES[size]}/0/default.jpg`, { headers: AIC_HEADERS, signal: AbortSignal.timeout(15000) });
          if (!r.ok) return null;
          const b = Buffer.from(await r.arrayBuffer());
          imgCache.set(k, b);
          if (imgCache.size > 250) imgCache.delete(imgCache.keys().next().value);
          return b;
        })().finally(() => imgInflight.delete(k));
        imgInflight.set(k, job);
      }
      buf = await job;
      if (!buf) return res.status(404).end();
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' });
    res.send(buf);
  } catch (e) { res.status(502).end(); }
});

// ================= 화면 파일 =================
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'three', 'build'), { maxAge: '7d' }));
app.use('/uploads', express.static(UP_DIR, { maxAge: '365d', immutable: true })); // Storage가 없을 때만 쓰임
app.use(express.static(path.join(__dirname, 'public')));

// Firebase 연결을 먼저 마친 뒤 서버를 엶 (연결 전 요청이 임시 저장소에 저장되지 않게)
initFirebase().finally(() => {
  app.listen(PORT, () => {
    console.log(`가상 미술관 서버 실행 중: http://localhost:${PORT}  (반: ${CLASS_IDS.join(', ')})`);
    loadCatalog();
  });
});
