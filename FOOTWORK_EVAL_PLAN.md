# Footwork Evaluation Extension Plan

**Status**: 2026-08-27 재파악 · 최소 통합 작업 진행 중
**Branch**: `iter4`
**Related dirs**: `iter4/eval/`, `iter4/server/templates/eval_dashboard.html`

---

## ⚠️ 2026-08-27 상황 재파악

계획을 처음 세울 때는 무빙 evaluation이 아예 없다고 봤지만, 최근 커밋
`426aa19 "코드 업데이트"` 를 확인해 보니 **무빙 채점 인프라는 이미 상당히
완성**되어 있었다:

| 이미 있는 것 | 위치 |
|---|---|
| 무빙 전용 벤치마크 영상 (150s) | `iter4/eval/video/benchmark_movement.mp4` |
| 구간(segment) 라벨 | `iter4/eval/video/benchmark_movement_labels.json` |
| 구간 IoU + onset/offset latency + negative-window FP 채점기 | `iter4/eval/score_movement.py` |
| Full-action state_timeline 출력기 | `iter4/eval/evaluate_full_actions.py` |
| 무빙 채점 결과 | `iter4/eval/output/movement_score.json` (v1/v2) |
| 무빙 튜닝 두 버전 | `configs/v{1,2}_movement_improved.json` |
| 무빙-only 촬영 도구 | `record_webcam_movement.py`, `record_webcam_movement_back.py` |
| 무빙 비교 애니메이션 | `output/movement_comparison.mp4` 등 |

즉, **C 단계에 해당하는 IoU 기반 정량 채점은 이미 별도 트랙으로 완결**되어
있다. 남아 있는 진짜 gap 은 다음 하나:

> **원래 벤치마크(`benchmark.mp4`, 90s 펀치 프로토콜)의 대시보드
> (`/eval`) 는 여전히 펀치만 표시한다.** 이 영상에도 57~70s "풋워크"
> 구간이 있는데, 무빙 검출 결과가 timeline / phase-analysis 에 뜨지
> 않는다.

이 gap을 메우는 게 지금의 목표 (사용자 요청: "eval 화면에 추가").

---

## 배경 (초기 진술 유지)

원래 벤치마크 evaluation 은 펀치 (JAB / CROSS / HOOK / UPPERCUT) 만
채점한다. 90 초 프로토콜 벤치마크 영상 (`iter4/eval/video/benchmark.mp4`)
에는 **57~70s "풋워크" 구간** 이 통째로 들어 있지만,
`benchmark_labels.json` 이 punches 배열만 갖고 있어 이 구간은 "펀치가
나면 안 되는 구간" 으로만 쓰이고 무빙 자체의 검출 품질은 대시보드에
표시되지 않는다.

발표 관점: "펀치만 인식" 을 "전신 복싱 동작 인식 (펀치 + 풋워크 + 가드)"
으로 격상시키면 리뷰어의 첫 질문 ("왜 손만?") 을 미리 차단할 수 있다.

---

## 이미 존재하는 자원 (재확인)

1. **무빙 검출 로직 완성본** — `iter4/eval/evaluate_full_actions.py`
   - `FullActionEvaluator` 가 프레임 단위로 `move / rot / guard /
     move_intensity` 를 뱉음
   - `state_timeline` 을 report.json 으로 저장하는 경로가 이미 있음
   - `runtime punch_core.js` TUNE 과 동기화 · `VoteWindow` 스무딩 완료

2. **랜드마크 캐시** — `iter4/eval/video/benchmark_landmarks.jsonl`
   (2650 프레임) — MediaPipe 재실행 없이 무빙만 뽑는 pass 는 CPU 30초

3. **대시보드 시간축 인프라** — `eval_dashboard.html`
   - `/api/eval-punches` + `/api/eval-versions` 이 이미 있음
   - phase-analysis / timeline / markers 모두 punches 기준 → 무빙 배열
     추가하면 재활용 가능

4. **movement scoring 인프라** — `score_movement.py` (별도 트랙)
   - benchmark.mp4 에도 movement 라벨을 붙이면 그대로 재사용 가능하지만,
     이번 A+B 스코프는 **라벨 없이도 유용한 것만** 추가

---

## 작업 범위 (A+B, 이번 세션)

### A. 최소 통합 — 원래 벤치마크에도 무빙 검출 결과 함께 산출

- [x] evaluate_full_actions 는 이미 `full_pipeline_report.json` 을 뱉고
      있으므로 굳이 evaluate_video 안에 통합하지 않는다. 대신
      `run_pipeline.py` 에 **Stage 2.5** 를 추가해:
      1. 랜드마크 캐시로 `FullActionEvaluator` 를 돌린다
      2. `iter4/eval/runs/<version>/movement_timeline.jsonl` 로 저장
         (프레임당 { t_ms, move, rot, guard, move_intensity })
      3. `metrics.json` 에 `movement` 섹션 추가 (아래 B 지표 포함)
- [x] `eval_dashboard.html` 에 무빙 timeline pane 추가:
      - HUD 에 `MOVE:` 칸 추가 (현재 프레임 상태)
      - Stats 패널에 `무빙 분포` 카드 (FORWARD/BACK/LEFT/RIGHT 비율)
      - marker strip 에 무빙 구간을 다른 색으로 오버레이
- [x] `/api/eval-moves?version=<v>` API 추가 (runs/\<v\>/movement_timeline.jsonl 서빙)

### B. 라벨 없는 정성 지표

`benchmark_labels.json` 을 건드리지 않고 90초 프로토콜의 phase 정의만
사용해서 계산:

- [x] `movement.phase_analysis`:
      - phase 5 (57~70s "풋워크") 의 `move != NONE` 프레임 비율
        → **footwork_recall_proxy**
      - phase 1 (0~6s) & phase 7 (85~90s) 정지 구간의
        `move != NONE` 프레임 비율 → **static_fp_proxy**
      - 각 phase 별 dominant move (다수결)
- [x] `movement.summary`:
      - move_distribution (전체 프레임 대비 각 move 비율)
      - guard_coverage_pct
      - move_segments (연속 구간 리스트 with dwell time, top-10 만 저장)
- [x] `runs_registry.json` 스키마 확장:
      `footwork_recall_proxy`, `static_fp_proxy`, `guard_coverage_pct`
- [x] `v6_with_footwork` 를 registry 에 새 버전으로 추가하지는 않는다.
      기존 5개 버전을 재실행해 `movement` 섹션을 채우는 방식으로 처리.

> **관찰 (2026-08-27)**: v1~v5 재실행 결과 다섯 버전 모두
> `footwork_recall_proxy=75.4%, static_fp_proxy=11.2%,
> guard_coverage=74.9%` 로 동일하게 나온다. 이는 버그가 아니라 **의도된
> 결과**다. 현재 config 튠(v1~v5)은 모두 punch trigger 파라미터만
> 만지고 있고(`PUNCH_SPEED`, `PUNCH_EXTEND`, `TCN_MIN_CONF` 등),
> `FullActionEvaluator` 가 쓰는 무빙 튠(`ROLL_ON`, `PITCH_ON`,
> `SHIFT_ON`, `SCALE_TAU_*` 등)은 코드에 하드코딩된 채로 남아 있다.
> 무빙 지표가 config 별로 달라지려면 별도 movement config 트랙
> (`configs/v1_movement_baseline.json` / `v2_movement_improved.json`)
> 이 필요하고, 이건 `benchmark_movement.mp4` 트랙에서 이미 별도로
> 관리되고 있다.

### C. 정량 F1 (이번 스코프 밖 — 이미 별도 트랙으로 존재)

`benchmark.mp4` 자체에 무빙 라벨을 붙이는 작업. `score_movement.py` 는
그대로 쓸 수 있다. 현재는 `benchmark_movement.mp4` (별개 영상)에 대해서만
채점되고 있다. 필요해지면 라벨 30분 + scoring 통합 1시간 예상.

---

## 발표에서의 프레이밍

- 정확도가 낮은 지표는 절대 크게 박지 말 것 (펀치 F1 0.38 함정과 같음).
- 스토리 순서:
  1. "펀치만 보는 시스템이 아니라 전신 인식 파이프라인이다" — 원래
     벤치마크 대시보드에서 timeline (펀치 + 무빙 + 가드) 스크린샷
  2. "라벨 없이도 프로토콜의 구간 정합성으로 정성 검증할 수 있다"
     — footwork_recall_proxy / static_fp_proxy 표
  3. "무빙 축은 이미 별도 벤치마크(`benchmark_movement.mp4`)로
     정량 채점되어 있다" — v1 vs v2 config 개선 사례를 confusion
     matrix diff 로 발표
  4. "펀치 벤치마크에도 라벨만 추가하면 동일한 IoU scoring 파이프라인이
     그대로 확장된다" — future work

