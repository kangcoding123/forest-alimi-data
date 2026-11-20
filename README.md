# 숲알리미 일정표

자연휴양림 예약 오픈 일정 알리미 앱(숲알리미)이 받아 쓰는 일정표와, 숲나들e의 변경을 확인하는 프로그램입니다.

| 파일 | 내용 |
|---|---|
| `forests.json` | 앱이 받아 가는 일정표. 사람이 확인한 값만 넣는다. |
| `check.mjs` | 숲나들e 예약 안내 페이지의 일정 문구를 뽑아 지난번과 비교한다. |
| `snapshot.json` | 지난번에 읽은 일정 문구. `check.mjs`가 갱신한다. |
| `calendar.mjs` | 숲나들e 검색 달력의 실제 예약 가능 기간을 받아 일정표의 예측과 대조한다. |
| `calendar.json` | 휴양림별 마지막 예약 가능일과, 그 날짜가 늘어난 것을 본 기록. `calendar.mjs`가 갱신한다. |
| `validate.mjs` | `forests.json`이 앱이 읽을 수 있는 형식인지 검사한다. |
| `AGENT.md` | 변경이 발견됐을 때 자동 수정이 따르는 절차. |

## 확인 프로그램

```bash
node check.mjs        # 비교 후 report.md 작성, snapshot.json 갱신
node check.mjs --dry  # 비교만
```

GitHub Actions가 매일 08:00(한국 시간)에 실행한다. 바뀐 곳이 있으면 `schedule-change` 라벨의 이슈가, 읽기에 실패하면 `check-failed` 라벨의 이슈가 만들어진다.

이슈는 저장소 주인에게 메일로 간다. 제목 앞머리만 봐도 무엇인지 알 수 있게 한다.

| 제목 앞머리 | 뜻 | 할 일 |
|---|---|---|
| `[발견]` | 안내문이 바뀐 것을 찾음. 아직 일정표는 그대로 | 없음 (결과 메일을 기다린다) |
| `[완료]` | 자동 수정이 처리를 마침 (일정표를 고쳤거나, 고칠 필요가 없었음) | 없음 |
| `[보류]` | 자동으로 고치기 애매해 그대로 둠 | 내용 확인 |
| `[확인 필요]` | 달력과 일정이 다르거나, 숲나들e를 읽지 못함 | 내용 확인 |


## 예약 달력 대조

```bash
node calendar.mjs        # 대조 후 calendar-report.md 작성, calendar.json 갱신
node calendar.mjs --dry  # 대조만
```

숲나들e 통합 검색의 달력은 휴양림마다 "지금 예약할 수 있는 날짜 목록"을 로그인 없이 받아 온다. 그 목록의 마지막 날을, `forests.json`의 규칙으로 계산한 "지금 열려 있어야 하는 마지막 날"과 비교한다. 안내문은 그대로인데 실제 운영만 바뀐 경우를 잡는다.

- 예측과 달력이 어긋나면 `calendar-mismatch` 라벨의 이슈가 만들어진다. 같은 어긋남은 한 번만 알린다.
- 마지막 날이 늘어난 것을 보면, 지난 확인 이후에 열리는 규칙이 있었는지 확인하고 `calendar.json`에 기록한다. 규칙에 없는 시점에 늘어났으면 이슈로 알린다.
- 예측은 `target` 문구에서 계산한다. `n주차 X요일 숙박분까지`, `n주차 1주일`, `n주 뒤 X요일부터 1주일`, `다음 달`·`다다음 달` 표현만 계산할 수 있으므로, 일반 오픈 규칙의 `target`은 이 표현을 쓴다.
- 하루 한 번 확인이라 오픈일은 날짜 단위로만 확인된다. 여는 시각(09시인지 10시인지)은 확인되지 않는다.

## 일정표를 고칠 때

1. 이슈에 적힌 휴양림의 공식 안내 페이지를 다시 읽고 `forests.json`의 해당 휴양림 줄을 고친다.
2. 맨 위 `updated`를 오늘 날짜로 올린다. 같은 날 다시 고치면 `2026-11-18T02`처럼 두 자리 번호를 붙여 더 큰 값이 되게 한다. 앱은 이 값이 커졌을 때만 새 일정표를 쓴다.
3. `node validate.mjs`로 형식을 검사한다.

자동 수정은 `AGENT.md`의 절차를 따르며 `claude/` 가지에만 올린다. GitHub Actions(`apply.yml`)가 검사를 통과한 것만 main에 합치고 결과를 이슈에 남긴다.

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
