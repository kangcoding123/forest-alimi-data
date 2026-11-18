#!/usr/bin/env node
/**
 * 숲나들e 예약 안내 페이지에서 일정 문구를 뽑아 지난번(snapshot.json)과 비교한다.
 *
 *   node check.mjs            비교하고 report.md를 쓴 뒤 snapshot.json을 갱신
 *   node check.mjs --dry      snapshot.json을 건드리지 않고 비교만
 *
 * 종료 코드: 0 = 정상(변경 유무는 report.md와 GITHUB_OUTPUT의 changed로 알림), 2 = 확인 실패가 많아 결과를 믿기 어려움
 * 의존 패키지 없음 (Node 20 이상).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.foresttrip.go.kr';
const SNAPSHOT = join(DIR, 'snapshot.json');
const REPORT = join(DIR, 'report.md');
const DRY = process.argv.includes('--dry');
const CONCURRENCY = 4;
/** 이 비율 넘게 실패하면 사이트 구조가 바뀌었거나 접속이 막힌 것으로 본다. */
const MAX_FAIL_RATIO = 0.1;

async function get(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; schedule-check)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML → 공백을 정리한 한 줄 텍스트 */
function text(html) {
  return decode(
    html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' '),
  )
    .replace(/[​﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SCHEDULE = /(매월|매달|매주|익월|다음\s*달|전월|[월화수목금토일]요일|\d\s*주|개시|오픈|열림|발표|신청\s*기간|접수|응모|추첨)/;
const NOISE = /대기|취소할|위약|환불|신분증|지참|양도|소멸|입실|퇴실|휴무|휴관|할인/;

/**
 * 안내문에서 예약 일정과 관련된 구절만 남긴다.
 * 전화번호나 이용 수칙이 고쳐진 것까지 '변경'으로 잡히지 않도록 하기 위해서다.
 */
function schedulePhrases(body) {
  const tidy = body.replace(/(\d)\s+(일|시|주|박|회|월|개|명|실|분)/g, '$1$2').replace(/\s*([:~])\s*/g, '$1');
  return tidy
    .split(/\s[-○*※▶●■□ㅇ·]\s|(?<=[다요음])\s?\.\s|\s\d\.\s/)
    .map((f) => f.trim())
    .filter((f) => SCHEDULE.test(f) && /\d/.test(f) && !NOISE.test(f.slice(0, 60)));
}

/** 휴양림 한 곳의 예약정책 하위 페이지들(선착순, 추첨, 지역주민 우선 등)을 읽는다. */
async function forestPages(name, hmpgId) {
  const menu = JSON.parse(await get(`${BASE}/com/sub/selectMenuList.do?hmpgId=${encodeURIComponent(hmpgId)}`)).menuList;
  if (!Array.isArray(menu)) throw new Error('메뉴 목록 형식이 다름');
  const pages = {};
  for (const m of menu) {
    if (!/^004001\d{3}$/.test(m.menuId ?? '') || m.useYn === 'N' || !m.menuUrl) continue;
    const page = text(await get(BASE + m.menuUrl));
    const start = page.lastIndexOf(m.menuNm);
    const end = page.indexOf('유관기관 사이트');
    if (start < 0) throw new Error(`'${m.menuNm}' 본문을 찾지 못함`);
    const body = page.slice(start + m.menuNm.length, end < 0 ? undefined : end);
    pages[`${name} [${hmpgId}] · ${m.menuNm}`] = schedulePhrases(body);
  }
  if (Object.keys(pages).length === 0) throw new Error('예약정책 페이지가 없음');
  return pages;
}

/** 숲나들e 전체 휴양림의 예약정책 요약 표 (국립 포함) */
async function policyTable() {
  const html = await get(`${BASE}/pot/cc/bb/selectFripRsrvtPolcyView.do?hmpgId=FRIP&menuId=002001`);
  const i = html.indexOf('id="dayListTable"');
  if (i < 0) throw new Error('정책 표를 찾지 못함');
  const table = html.slice(i, html.indexOf('</table>', i));
  const rows = {};
  for (const tr of table.slice(table.indexOf('<tbody')).match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map(text);
    if (cells.length < 9) continue;
    rows[`정책 표 · ${cells[0]} ${cells[1]}`] = [cells.slice(2).join(' | ')];
  }
  if (Object.keys(rows).length < 100) throw new Error(`정책 표 행이 ${Object.keys(rows).length}개뿐임`);
  return rows;
}

/** 공지사항 중 예약·추첨 관련 글 제목. 성수기 추첨 일정이 여기에 올라온다. */
async function notices() {
  const out = {};
  for (const word of ['추첨', '예약']) {
    const html = await get(
      `${BASE}/pot/cc/nm/selectNticBbrssListView.do?bbrssMsterId=BBRSSMSTER_00000001&hmpgId=FRIP&menuId=004001&srwrd=${encodeURIComponent(word)}`,
    );
    const re = /fn_goDtlView\('(\d+)'\);[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    let count = 0;
    while ((m = re.exec(html))) {
      count++;
      const title = text(m[2]);
      // 매달 올라오는 당첨 발표 알림은 일정 변경이 아니므로 뺀다.
      if (/당첨\s*발표/.test(title)) continue;
      out[`공지 #${m[1]}`] = [title];
    }
    if (count === 0) throw new Error(`공지 목록('${word}')을 읽지 못함`);
  }
  return out;
}

/** 국립 휴양림 공통 규칙이 적힌 안내 (추첨 이용안내) */
async function nationalGuide() {
  const page = text(await get(`${BASE}/rep/drlts/drltsUseGdnc.do?hmpgId=FRIP&menuId=001003004`));
  // 상단 메뉴 문구를 빼고 본문만 본다.
  const start = page.lastIndexOf('추첨 이용안내');
  const end = page.indexOf('유관기관 사이트');
  const phrases = schedulePhrases(page.slice(Math.max(start, 0), end < 0 ? undefined : end));
  if (phrases.length === 0) throw new Error('추첨 이용안내에서 일정 문구를 찾지 못함');
  return { '국립 공통 · 추첨 이용안내': phrases };
}

async function pool(items, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

const data = JSON.parse(readFileSync(join(DIR, 'forests.json'), 'utf8'));
const targets = data.forests.filter((f) => f.hmpgId).map((f) => ({ name: f.name, hmpgId: f.hmpgId }));

const current = {};
const failures = [];
const jobs = [
  { label: '정책 표', run: policyTable },
  { label: '공지사항', run: notices },
  { label: '추첨 이용안내', run: nationalGuide },
  ...targets.map((t) => ({ label: `${t.name} [${t.hmpgId}]`, run: () => forestPages(t.name, t.hmpgId) })),
];

await pool(jobs, async (job) => {
  try {
    Object.assign(current, await job.run());
  } catch (e) {
    failures.push(`${job.label}: ${e.message}`);
  }
});

const previous = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')).pages : null;
const failedLabels = failures.map((f) => f.split(':')[0]);
const isFailed = (key) => failedLabels.some((label) => key.startsWith(label) || (label === '공지사항' && key.startsWith('공지')));

const changes = [];
if (previous) {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = previous[key];
    const after = current[key];
    if (after === undefined) {
      // 읽기에 실패한 페이지는 '사라짐'으로 보지 않고 이전 값을 유지한다.
      if (isFailed(key)) current[key] = before;
      // 공지는 목록에서 밀려나는 것이 정상이므로 변경으로 치지 않는다.
      else if (!key.startsWith('공지 #')) changes.push({ key, before, after: null });
      else current[key] = before;
    } else if (before === undefined) {
      changes.push({ key, before: null, after });
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ key, before, after });
    }
  }
}

const today = new Date().toISOString().slice(0, 10);
const unreliable = failures.length > jobs.length * MAX_FAIL_RATIO;
const list = (phrases) => (phrases ? phrases.map((p) => `  - ${p}`).join('\n') || '  - (일정 문구 없음)' : '  - (없음)');

const lines = [`# 숲나들e 예약 일정 확인 — ${today}`, ''];
if (!previous) {
  lines.push(`첫 실행입니다. 페이지 ${Object.keys(current).length}개의 일정 문구를 기준으로 저장했습니다.`);
} else if (changes.length === 0) {
  lines.push('바뀐 곳이 없습니다.');
} else {
  lines.push(`바뀐 곳 ${changes.length}건`, '');
  for (const c of changes.sort((a, b) => a.key.localeCompare(b.key, 'ko'))) {
    lines.push(`## ${c.key}`, '', '이전:', list(c.before), '', '이후:', list(c.after), '');
  }
}
if (failures.length > 0) {
  lines.push('', `## 확인 실패 ${failures.length}건`, '', ...failures.sort().map((f) => `- ${f}`));
  if (unreliable) lines.push('', '실패가 많아 이번 결과는 믿기 어렵습니다. 사이트 구조가 바뀌었거나 접속이 막혔을 수 있습니다.');
}
const report = lines.join('\n') + '\n';
writeFileSync(REPORT, report);
console.log(report);

if (!DRY && !unreliable) {
  const sorted = Object.fromEntries(Object.keys(current).sort((a, b) => a.localeCompare(b, 'ko')).map((k) => [k, current[k]]));
  writeFileSync(SNAPSHOT, JSON.stringify({ checkedAt: today, pages: sorted }, null, 1) + '\n');
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${changes.length > 0}\nfailed=${failures.length > 0}\nunreliable=${unreliable}\n`,
  );
}
process.exit(unreliable ? 2 : 0);
