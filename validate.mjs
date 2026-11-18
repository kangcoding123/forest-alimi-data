#!/usr/bin/env node
/**
 * forests.json이 앱이 읽을 수 있는 형식인지 검사한다. 자동 수정이 반영되기 전의 관문이다.
 *
 *   node validate.mjs               형식만 검사
 *   node validate.mjs <이전 파일>    형식 검사 + 내용이 바뀌었으면 updated가 커졌는지, 휴양림이 사라지지 않았는지 검사
 *
 * 앱의 src/data/load.ts(parseData)와 같은 규칙이어야 한다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const errors = [];
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const optInt = (v, min, max) => v === undefined || isInt(v, min, max);
const AUDIENCE = /^(disabled|senior|multichild|voucher|resident:\S.*)$/;
const RULE_KEYS = new Set([
  'kind', 'weekday', 'day', 'hour', 'minute', 'endDay', 'endHour', 'endMinute', 'label', 'target', 'method', 'note', 'audience',
]);
const FOREST_KEYS = new Set(['name', 'type', 'sido', 'sigungu', 'operator', 'hmpgId', 'use', 'rules', 'note', 'verified']);

function checkRule(r, where) {
  const bad = (msg) => errors.push(`${where}: ${msg}`);
  if (!isObj(r)) return bad('규칙이 객체가 아님');
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) bad(`알 수 없는 항목 '${k}'`);
  if (!isInt(r.hour, 0, 23) || !isInt(r.minute, 0, 59)) bad('hour/minute 범위 오류');
  if (!isStr(r.label) || !isStr(r.target)) bad('label/target 누락');
  if (r.method !== 'first-come' && r.method !== 'lottery') bad(`method '${r.method}'`);
  if (r.note !== undefined && typeof r.note !== 'string') bad('note가 문자열이 아님');
  if (r.audience !== undefined && !(Array.isArray(r.audience) && r.audience.length > 0 && r.audience.every((a) => isStr(a) && AUDIENCE.test(a)))) {
    bad('audience 형식 오류');
  }
  if (r.kind === 'weekly') {
    if (!isInt(r.weekday, 0, 6)) bad('weekday 범위 오류');
  } else if (r.kind === 'monthly') {
    if (!isInt(r.day, 1, 31)) bad('day 범위 오류');
    if (!optInt(r.endDay, 1, 31) || !optInt(r.endHour, 0, 23) || !optInt(r.endMinute, 0, 59)) bad('마감 일시 범위 오류');
    if (r.endDay === undefined && (r.endHour !== undefined || r.endMinute !== undefined)) bad('endDay 없이 마감 시각만 있음');
  } else bad(`kind '${r.kind}'`);
}

function check(data) {
  if (!isObj(data) || data.version !== 1) return errors.push('version이 1이 아님');
  if (!isStr(data.updated) || !/^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(data.updated)) errors.push(`updated 형식 오류: ${data.updated}`);
  const shared = isObj(data.shared) ? data.shared : {};
  for (const [key, set] of Object.entries(shared)) {
    if (!isObj(set) || !Array.isArray(set.rules) || set.rules.length === 0) errors.push(`shared.${key}: rules 누락`);
    else set.rules.forEach((r, i) => checkRule(r, `shared.${key}[${i}]`));
  }
  if (!Array.isArray(data.forests) || data.forests.length === 0) return errors.push('forests가 비어 있음');
  const seen = new Set();
  for (const f of data.forests) {
    const where = isObj(f) && isStr(f.name) ? f.name : '(이름 없는 휴양림)';
    if (!isObj(f) || !isStr(f.name) || !isStr(f.sido)) { errors.push(`${where}: name/sido 누락`); continue; }
    for (const k of Object.keys(f)) if (!FOREST_KEYS.has(k)) errors.push(`${where}: 알 수 없는 항목 '${k}'`);
    if (!['national', 'public', 'private'].includes(f.type)) errors.push(`${where}: type '${f.type}'`);
    if (f.use !== undefined && !shared[f.use]) errors.push(`${where}: shared.${f.use} 없음`);
    if (f.rules !== undefined && !Array.isArray(f.rules)) errors.push(`${where}: rules가 배열이 아님`);
    (Array.isArray(f.rules) ? f.rules : []).forEach((r, i) => checkRule(r, `${where}[${i}]`));
    if (!f.use && !(Array.isArray(f.rules) && f.rules.length > 0)) errors.push(`${where}: 규칙이 하나도 없음`);
    const id = `${f.type}-${f.name}`;
    if (seen.has(id)) errors.push(`${where}: 중복`);
    seen.add(id);
  }
  return seen;
}

let data;
try {
  data = JSON.parse(readFileSync(join(DIR, 'forests.json'), 'utf8'));
} catch (e) {
  console.error(`forests.json을 읽을 수 없음: ${e.message}`);
  process.exit(1);
}
const ids = check(data);

const basePath = process.argv[2];
if (basePath && errors.length === 0) {
  const baseText = readFileSync(basePath, 'utf8');
  const base = JSON.parse(baseText);
  if (JSON.stringify(base) !== JSON.stringify(data)) {
    if (!(data.updated > base.updated)) errors.push(`내용이 바뀌었는데 updated가 커지지 않음 (${base.updated} → ${data.updated})`);
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (data.updated.slice(0, 10) > today) errors.push(`updated가 미래 날짜임: ${data.updated}`);
    const gone = base.forests.map((f) => `${f.type}-${f.name}`).filter((id) => !ids.has(id));
    if (gone.length > 0) errors.push(`휴양림이 사라짐: ${gone.join(', ')} (삭제·개명은 자동 반영하지 않는다)`);
    const changed = data.forests.filter((f) => {
      const old = base.forests.find((b) => b.type === f.type && b.name === f.name);
      return !old || JSON.stringify(old) !== JSON.stringify(f);
    });
    if (changed.length > 10) errors.push(`한 번에 ${changed.length}곳이 바뀜 (10곳 넘는 변경은 자동 반영하지 않는다)`);
    console.log(`바뀐 휴양림 ${changed.length}곳: ${changed.map((f) => f.name).join(', ') || '(shared 규칙만 변경)'}`);
  } else console.log('forests.json 내용 변경 없음');
}

if (errors.length > 0) {
  console.error(`검사 실패 ${errors.length}건\n` + errors.map((e) => `- ${e}`).join('\n'));
  process.exit(1);
}
console.log(`검사 통과: 휴양림 ${data.forests.length}곳`);
