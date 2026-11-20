#!/usr/bin/env node
/**
 * 실제 예약 달력과 일정표를 대조한다.
 *
 * 숲나들e 통합 검색의 달력은 휴양림마다 "지금 예약할 수 있는 날짜 목록"을 받아 온다(로그인 불필요).
 * 그 목록의 마지막 날을, forests.json의 규칙으로 계산한 "지금 열려 있어야 하는 마지막 날"과 비교한다.
 * 안내문은 그대로인데 실제 운영만 바뀐 경우를 잡기 위한 것이다.
 *
 *   node calendar.mjs          대조하고 calendar-report.md를 쓴 뒤 calendar.json을 갱신
 *   node calendar.mjs --dry    calendar.json을 건드리지 않고 대조만
 *
 * calendar.json에는 휴양림별 마지막 예약 가능일과, 그 날짜가 늘어난 것을 본 기록이 쌓인다.
 * 날짜가 늘어난 날이 곧 예약이 열린 날이므로, 규칙의 오픈일이 맞는지도 이 기록으로 확인한다.
 *
 * 종료 코드: 0 = 정상, 2 = 읽기 실패가 많아 결과를 믿기 어려움. 의존 패키지 없음 (Node 20 이상).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.foresttrip.go.kr';
const STATE = join(DIR, 'calendar.json');
const REPORT = join(DIR, 'calendar-report.md');
const DRY = process.argv.includes('--dry');
const CONCURRENCY = 4;
const MAX_FAIL_RATIO = 0.1;
const DAY = 86400000;
const KST = 9 * 3600000;
/** 오픈 직후에는 달력에 아직 반영되지 않았을 수 있어, 이 시간 안의 오픈은 반영 전·후 둘 다 맞는 것으로 본다. */
const GRACE = 90 * 60000;
const MAX_LOG = 12;
const WD = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const WDN = '일월화수목금토';

const now = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const kst = (ms) => {
  const t = new Date(ms + KST);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
};
const instant = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - KST;
const ymd = (ms) => { const p = kst(ms); return `${p.y}${pad(p.m)}${pad(p.d)}`; };
const fromYmd = (s) => instant(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
const nice = (s) => `${+s.slice(4, 6)}월 ${+s.slice(6, 8)}일`;
const niceTime = (ms) => { const p = kst(ms); return `${p.m}월 ${p.d}일 ${pad(p.h)}:${pad(p.mi)}`; };
const when = (r) => (r.kind === 'weekly' ? `매주 ${WDN[r.weekday]}요일` : `매월 ${r.day}일`) + ` ${pad(r.hour)}:${pad(r.minute)}`;

async function getJson(path) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; schedule-check)', 'X-Ajax-call': 'true' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** asOf 이전(포함)의 가장 최근 오픈 시점 */
function lastOccurrence(rule, asOf) {
  const p = kst(asOf);
  if (rule.kind === 'weekly') {
    let t = instant(p.y, p.m, p.d, rule.hour, rule.minute);
    while (kst(t).wd !== rule.weekday || t > asOf) t -= DAY;
    return t;
  }
  let { y, m } = p;
  for (let i = 0; i < 3; i++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const t = instant(y, m, Math.min(rule.day, last), rule.hour, rule.minute);
    if (t <= asOf) return t;
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return null;
}

/** 규칙의 문구로, asOf 시점에 열려 있어야 하는 마지막 숙박일(yyyymmdd)을 계산한다. 정할 수 없으면 null. */
function predictLast(rule, asOf) {
  const at = lastOccurrence(rule, asOf);
  if (at == null) return null;
  if (rule.kind === 'weekly') {
    let m = /(\d)주 뒤 [일월화수목금토]요일부터 1주일/.exec(rule.target);
    if (m) return ymd(at + (7 * +m[1] + 6) * DAY);
    m = /(\d)주차 1주일/.exec(rule.target);
    if (m) return ymd(at + (7 * +m[1] - 1) * DAY);
    m = /(\d)주차 ([일월화수목금토])요일 숙박분까지/.exec(rule.target);
    if (m) return ymd(at + (7 * (+m[1] - 1) + ((WD[m[2]] - rule.weekday + 7) % 7)) * DAY);
    return null;
  }
  const k = /다다음 달/.test(rule.target) ? 2 : /다음 달/.test(rule.target) ? 1 : null;
  if (k == null) return null;
  const p = kst(at);
  const i = p.y * 12 + (p.m - 1) + k;
  const y = Math.floor(i / 12);
  const mo = (i % 12) + 1;
  return `${y}${pad(mo)}${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
}

/**
 * 그 휴양림의 '일반 예약 범위'를 여는 규칙들.
 * 우선예약 잔여 객실 오픈은 일부 객실만 열므로 뺀다. 다만 월 추첨제 휴양림은 추첨 뒤 잔여분 오픈이 곧 일반 오픈이다.
 */
function mainRules(forest, shared) {
  // 한 번만 열리는 일정(once)은 '지금 열려 있어야 하는 범위'를 정하는 정기 규칙이 아니므로 뺀다.
  const all = [...(forest.use ? shared[forest.use].rules : []), ...(forest.rules ?? [])].filter((r) => !r.audience && r.kind !== 'once');
  const general = all.filter((r) => r.method === 'first-come');
  const lotteryForest = all.some((r) => r.method === 'lottery' && r.kind === 'monthly') && !general.some((r) => r.kind === 'weekly');
  return general.filter((r) => lotteryForest || !/잔여/.test(r.label));
}

/** 예측과 실제가 같은지. 실제가 더 길어도 그 사이가 전부 휴무일이면 같은 것으로 본다. */
function sameRange(pred, actual, holidays) {
  if (pred === actual) return true;
  if (actual < pred) return false;
  for (let t = fromYmd(pred) + DAY; ymd(t) <= actual; t += DAY) if (!holidays.has(ymd(t))) return false;
  return true;
}

const data = JSON.parse(readFileSync(join(DIR, 'forests.json'), 'utf8'));
const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
const prevAt = prev?.checkedAtMs ?? null;

// 국립은 고유번호가 따로 있어 기관 목록에서 이름으로 찾는다.
const norm = (s) => s.replace(/^\(.*?\)/, '').replace(/자연휴양림|\s|\(.*?\)/g, '');
const insttByName = new Map();
const failures = [];
try {
  for (const sido of await getJson('/rep/or/selectSiDoList.do')) {
    for (const x of (await getJson(`/rep/or/selectInsttListForSearch.do?srchSido=${sido.detailCode}`)).insttList) {
      insttByName.set(norm(x.insttNm), x.insttId);
    }
  }
} catch (e) {
  failures.push(`기관 목록: ${e.message}`);
}

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < data.forests.length) {
      const f = data.forests[next++];
      const key = `${f.type}-${f.name}`;
      try {
        const insttId = f.hmpgId ?? insttByName.get(norm(f.name));
        if (!insttId) throw new Error('기관 번호를 찾지 못함');
        const info = await getJson(`/rep/or/selectFcFsRcfrsFcltInfo.do?insttId=${encodeURIComponent(insttId)}`);
        if (!Array.isArray(info.useDtList)) throw new Error('응답 형식이 다름');
        const dates = info.useDtList.map((x) => x.schdlDt).filter(Boolean).sort();
        results.push({
          key,
          name: f.name,
          rules: mainRules(f, data.shared),
          max: dates.at(-1) ?? null,
          cycle: info.RsrvtRgstnAvailVO?.rsrvtCycleTpeCd ?? null,
          holidays: new Set((info.hldtList ?? []).map((h) => h.dt)),
        });
      } catch (e) {
        failures.push(`${f.name}: ${e.message}`);
      }
    }
  }),
);

const unreliable = failures.length > data.forests.length * MAX_FAIL_RATIO;
const state = { checkedAtMs: now, checkedAt: niceTime(now), forests: {} };
const problems = []; // { key, name, kind, text, sig }
const unknown = [];
const openings = [];
let matched = 0;

for (const r of results.sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
  const before = prev?.forests?.[r.key];
  const entry = { max: r.max, cycle: r.cycle, openings: before?.openings ?? [] };
  state.forests[r.key] = entry;
  if (!r.max) {
    problems.push({ key: r.key, name: r.name, kind: 'empty', text: '달력에 예약 가능한 날짜가 하나도 없습니다.' });
    continue;
  }
  const main = r.rules[0];

  // 1) 예약 범위가 늘어난 것을 봤다면 그 사이에 열리는 규칙이 있었는지 확인한다.
  if (before?.max && r.max !== before.max && prevAt) {
    const expected = r.rules.find((rule) => {
      const t = lastOccurrence(rule, now);
      return t != null && t > prevAt - GRACE;
    });
    if (r.max > before.max) {
      entry.openings = [...entry.openings, `${niceTime(prevAt)}~${niceTime(now)}: ${before.max}→${r.max}${expected ? ` (${when(expected)})` : ' (해당 규칙 없음)'}`].slice(-MAX_LOG);
      if (expected) openings.push({ name: r.name, group: `${nice(before.max)} → ${nice(r.max)} (${when(expected)} 규칙과 일치)` });
      else problems.push({ key: r.key, name: r.name, kind: 'unexpected', once: true, text: `${niceTime(prevAt)}에서 ${niceTime(now)} 사이에 예약 가능한 마지막 날이 ${nice(before.max)} → ${nice(r.max)}로 늘었는데, 일정표에는 이 사이에 열리는 일정이 없습니다.` });
    } else {
      problems.push({ key: r.key, name: r.name, kind: 'shrunk', once: true, text: `예약 가능한 마지막 날이 ${nice(before.max)} → ${nice(r.max)}로 줄었습니다.` });
    }
  }

  // 2) 시스템이 알려 주는 주기(주 단위/월 단위)와 규칙의 종류
  const kinds = new Set(r.rules.map((rule) => rule.kind));
  if ((r.cycle === 'WEEK' && !kinds.has('weekly')) || (r.cycle === 'MON' && !kinds.has('monthly'))) {
    problems.push({ key: r.key, name: r.name, kind: 'cycle', text: `달력의 예약 주기는 ${r.cycle === 'WEEK' ? '주 단위' : '월 단위'}인데 일정표의 일반 오픈 규칙은 ${[...kinds].map((k) => (k === 'weekly' ? '주 단위' : '월 단위')).join('·') || '없음'}입니다.` });
  }

  // 3) 지금 열려 있어야 하는 마지막 날과 실제 달력
  const preds = (asOf) => {
    const list = r.rules.map((rule) => predictLast(rule, asOf)).filter(Boolean);
    return list.length ? list.sort().at(-1) : null;
  };
  const predNow = preds(now);
  const predEarly = preds(now - GRACE);
  if (!predNow) {
    unknown.push(`${r.name}: 달력은 ${nice(r.max)}까지 (일정표 문구 "${main?.target ?? '규칙 없음'}"로는 날짜를 계산할 수 없음)`);
    continue;
  }
  if (sameRange(predNow, r.max, r.holidays) || (predEarly && sameRange(predEarly, r.max, r.holidays))) {
    matched++;
    continue;
  }
  const rule = main ? `${when(main)} "${main.target}"` : '';
  problems.push({
    key: r.key,
    name: r.name,
    kind: r.max < predNow ? 'short' : 'long',
    group: `일정표로는 ${nice(predNow)}까지 열려 있어야 하는데 달력은 ${nice(r.max)}까지입니다. (규칙: ${rule})`,
  });
}

// 이미 알린 어긋남은 다시 알리지 않는다. 한 번 일어나고 끝나는 일(예상 밖 오픈)은 매번 새 일이다.
const flaggedBefore = prev?.flagged ?? {};
const flagged = {};
const today = ymd(now);
for (const p of problems) {
  if (p.once) { p.isNew = true; continue; }
  const sig = `${p.key}:${p.kind}`;
  flagged[sig] = flaggedBefore[sig] ?? today;
  p.isNew = !flaggedBefore[sig];
  p.since = flagged[sig];
}
state.flagged = flagged;
const resolved = Object.keys(flaggedBefore).filter((sig) => !flagged[sig]).map((sig) => sig.split(':')[0].replace(/^(national|public|private)-/, ''));

/** 같은 내용은 '유명산 외 47곳'으로 묶는다. */
function grouped(items) {
  const map = new Map();
  for (const it of items) {
    const text = it.group ?? it.text;
    map.set(text, [...(map.get(text) ?? []), it.name]);
  }
  return [...map].map(([text, names]) => `- ${names.length > 3 ? `${names[0]} 외 ${names.length - 1}곳` : names.join(', ')}: ${text}`);
}

const fresh = problems.filter((p) => p.isNew);
const ongoing = problems.filter((p) => !p.isNew);
const lines = [`# 예약 달력 대조 — ${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`, ''];
lines.push('일정표의 규칙으로 계산한 "지금 예약할 수 있어야 하는 마지막 날"을 숲나들e 검색 달력과 비교했습니다.', '');
lines.push(`- 확인 시각: ${niceTime(now)} (한국 시간)`);
lines.push(`- 예약 범위가 일치하는 곳 ${matched}곳, 확인이 필요한 곳 ${new Set(problems.map((p) => p.key)).size}곳, 계산할 수 없는 곳 ${unknown.length}곳, 읽기 실패 ${failures.length}곳`);
if (!prev) lines.push('- 첫 실행이라 오늘 달력을 기준으로 저장했습니다. 예약이 열리는 날의 확인은 다음 실행부터 쌓입니다.');
if (fresh.length) lines.push('', `## 새로 어긋난 곳 (${fresh.length})`, '', ...grouped(fresh));
if (ongoing.length) lines.push('', `## 계속 어긋나 있는 곳 (${ongoing.length})`, '', ...grouped(ongoing.map((p) => ({ ...p, group: `${p.group ?? p.text} — ${nice(p.since)}부터` }))));
if (resolved.length) lines.push('', `## 다시 맞게 된 곳 (${resolved.length})`, '', `- ${[...new Set(resolved)].join(', ')}`);
if (openings.length) lines.push('', `## 이번에 확인한 오픈 (${openings.length})`, '', '지난 확인 이후 예약 범위가 늘어났고, 일정표의 오픈 일정과 맞았습니다.', '', ...grouped(openings));
if (unknown.length) lines.push('', `## 계산할 수 없는 곳 (${unknown.length})`, '', ...unknown.map((u) => `- ${u}`));
if (failures.length) {
  lines.push('', `## 읽기 실패 (${failures.length})`, '', ...failures.sort().map((f) => `- ${f}`));
  if (unreliable) lines.push('', '실패가 많아 이번 결과는 믿기 어렵습니다. 숲나들e의 응답 형식이 바뀌었거나 접속이 막혔을 수 있습니다.');
}
const report = lines.join('\n') + '\n';
writeFileSync(REPORT, report);
console.log(report);

if (!DRY && !unreliable) {
  // 읽기에 실패한 휴양림은 지난 기록을 그대로 둔다.
  for (const [key, value] of Object.entries(prev?.forests ?? {})) if (!state.forests[key]) state.forests[key] = value;
  state.forests = Object.fromEntries(Object.keys(state.forests).sort((a, b) => a.localeCompare(b, 'ko')).map((k) => [k, state.forests[k]]));
  const body = ['{', ` "checkedAtMs": ${state.checkedAtMs},`, ` "checkedAt": ${JSON.stringify(state.checkedAt)},`, ` "flagged": ${JSON.stringify(state.flagged)},`, ' "forests": {'];
  body.push(Object.entries(state.forests).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'));
  body.push(' }', '}');
  writeFileSync(STATE, body.join('\n') + '\n');
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `calendar_changed=${fresh.length > 0}\ncalendar_failed=${failures.length > 0}\ncalendar_unreliable=${unreliable}\n`);
}
process.exit(unreliable ? 2 : 0);
