# 숲알리미 일정표

자연휴양림 예약 오픈 일정 알리미 앱(숲알리미)이 받아 쓰는 일정표와, 숲나들e의 변경을 확인하는 프로그램입니다.

| 파일 | 내용 |
|---|---|
| `forests.json` | 앱이 받아 가는 일정표. 사람이 확인한 값만 넣는다. |
| `check.mjs` | 숲나들e 예약 안내 페이지의 일정 문구를 뽑아 지난번과 비교한다. |
| `snapshot.json` | 지난번에 읽은 일정 문구. `check.mjs`가 갱신한다. |

## 확인 프로그램

```bash
node check.mjs        # 비교 후 report.md 작성, snapshot.json 갱신
node check.mjs --dry  # 비교만
```

GitHub Actions가 매일 08:00(한국 시간)에 실행한다. 바뀐 곳이 있으면 `schedule-change` 라벨의 이슈가, 읽기에 실패하면 `check-failed` 라벨의 이슈가 만들어진다.

## 일정표를 고칠 때

1. 이슈에 적힌 휴양림의 공식 안내 페이지를 다시 읽고 `forests.json`의 해당 휴양림 줄을 고친다.
2. 맨 위 `updated`를 오늘 날짜로 올린다. 같은 날 다시 고치면 `2026-11-18T2`처럼 뒤에 붙여 더 큰 값이 되게 한다. 앱은 이 값이 커졌을 때만 새 일정표를 쓴다.
3. 날짜·시각만 바뀐 단순한 변경만 바로 반영한다. 추첨제 신설처럼 규칙의 구조가 바뀌거나 문장이 애매하면 반영하지 않고 이슈에 질문을 남긴다.

### 규칙 형식

```jsonc
// 매주: weekday 0=일 … 6=토
{"kind":"weekly","weekday":3,"hour":9,"minute":0,"label":"선착순 예약 오픈","method":"first-come","target":"6주차 화요일 숙박분까지"}
// 매월: endDay/endHour/endMinute는 신청 마감(추첨 등). day가 그 달에 없으면 말일.
{"kind":"monthly","day":4,"hour":9,"minute":0,"endDay":9,"endHour":18,"endMinute":0,"label":"주말 추첨 신청 시작","method":"lottery","target":"다음 달 주말 숙박분"}
// 우선예약: audience에 해당하는 사용자에게만 보인다.
// "resident:경기 가평군"(주민), "disabled", "senior", "multichild", "voucher"
```

시각은 모두 한국 시간이다. `"use":"national"`인 휴양림은 `shared.national`의 규칙을 함께 쓴다.
