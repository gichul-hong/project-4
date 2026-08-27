# iter5 CV 개선 실행 계획 (iter5_plan)

> **작성일**: 2026-08-27
> **대상**: `iter5/` 디렉터리 (iter4 에서 복사된 코드베이스)
> **목적**: Computer Vision 과목 특성에 맞춰 **판정 정확도(F1)를 높일 수 있는** 개선을
>   순차적으로 구현하고, 각각을 새 버전으로 평가·아카이빙하여 발표 근거로 삼는다.

---

## 0. 출발점 (baseline, iter5 registry 기준)

| 버전 | F1 | Precision | Recall | 구조 |
|---|---:|---:|---:|---|
| v1_baseline | 0.3666 | 0.3548 | 0.3793 | rule trigger + rule 분류 |
| v5_tcn_optimized | 0.3793 | 0.3793 | 0.3793 | rule trigger + TCN 분류 |
| v5c_tcn_hybrid_gate | 0.5763 | 0.5667 | 0.5862 | TCN + 물리게이트(AND) |
| **v6c_tcn_hybrid_gate** | **0.7143** | 0.7692 | 0.6667 | 개선된 TCN+물리게이트 (현 최고) |

**현재 병목**: v6c 의 **Recall = 0.6667** (FN = 1/3). Precision 은 이미 0.77 로 양호.
즉 **놓친 펀치를 줄이는 것**이 F1 을 더 올리는 직접 경로다.

---

## 1. 개선 후보와 채택 기준

CV 과목 특성(기하학 · 시공간 신호처리 · 학습/일반화 · 평가설계) 관점에서
후보를 아래처럼 정리했다. 채택 원칙은 **(a) F1 직접 상승 가능성**과
**(b) 발표에서 "CV 기법"으로 명확히 어필 가능한지** 두 가지.

| # | 개선 | CV 기법 | F1 영향 | 비용 | 채택 |
|---|---|---|---|---|---|
| 1 | 손목 궤적 스무딩(칼만/SG) 후 속도 추정 | 시공간 신호처리 | Recall ↑ 직접 | 낮음 | ✅ Phase 1 |
| 2 | 어깨선 회전 정규화 + 2D/3D foreshortening 정량 ablation | 투영 기하학 | robustness | 중간 | ✅ Phase 2 |
| 3 | visibility-weighted gating (가려짐 처리) | 신뢰도 기반 센서융합 | FP ↓ | 낮음 | ✅ Phase 3 |
| 4 | 실측 노이즈 모델을 합성 데이터에 반영 (sim2real) | 데이터 생성/통계 | TCN 일반화 | 중간 | ⏸ Phase 4 |
| 5 | 지표 확장 (혼동행렬 시각화, latency CDF p50/p95) | 평가설계 | 발표 설득력 | 낮음 | ✅ Phase 1 에 병행 |

---

## 2. Phase 별 실행 계획

### Phase 1 — 속도 신호 안정화 (시공간 미분 개선) ⭐

**문제**: `evaluate_video.py:314 arm_kinematics()` 가 손목 위치의 **단순 유한차분**
(`Δ손목 / Δt`)으로 속도를 구한다. MediaPipe world landmark 의 프레임 간 진동(jitter)이
미분에서 증폭되어 (a) 비펀치 구간의 속도 스파이크 → FP, (b) 피크가 두 프레임에
찢어짐 → FN 이 된다.

**작업**:
1. `evaluate_video.py` 에 궤적 스무딩 계층을 추가.
   - 1차: **Savitzky-Golay 필터** (window 5, poly 2) — 지연 최소, 온라인 호환.
   - 2차: **1차원 칼만 필터** (등속 모델) — noise covariance 를 landmark
     visibility 로부터 추정해 연동.
2. 스무딩 **전/후** 속도 신호를 나란히 기록해 ablation 가능하게.
3. 새 버전 `v7_velocity_smooth` 로 평가 → registry 추가.
4. 결과 비교: F1 / Recall / FP 변화량.

**기대**: Recall 0.667 → 0.75+ 상승. "유한차분의 잡음 증폭을 신호처리로 완화"
라는 CV 교과서급 스토리.

**검증**: `run_suite.py` (합성 68/68 F1=1.000 유지) + `run_pipeline.py --version v7_...`.

---

### Phase 2 — 시점 불변 정규화 + 2D/3D ablation (기하학)

**문제**: 현재 어깨폭 정규화는 "스케일" 불변만 해결. 카메라 roll/참가자 회전에는
취약하고, 2D vs 3D 의 정량적 우위가 eval 버전으로는 남아 있지 않다.

**작업**:
1. 어깨선(11→12)을 매 프레임 수평으로 회전시키는 **roll 정규화** 전처리 추가.
   → 카메라 기울임에 불변한 roll/pitch/shift 특징.
2. `v7_2d_only` (2D 정규화 좌표만 사용, world 미사용) vs `v7_3d_world` 를
   나란히 평가 → foreshortening 이 F1 에 주는 영향을 **수치로** 증명.
3. `CV_TECHNIQUES.md` 에 기하 정규화 섹션 갱신.

**기대**: "3D world landmark 를 쓰는 이유" 를 F1 수치로 어필. 발표 임팩트 최상.

---

### Phase 3 — 가시성 기반 가려짐 처리 (센서 융합)

**문제**: `evaluate_video.py` 가 `VIS_MIN=0.5 / ARM_VIS_MIN=0.3` 의 **단순 이진
threshold** 로만 visibility 를 쓴다. 훅 펀치에서 손이 얼굴 뒤로 지나갈 때 가려짐 →
복구 전이 구간의 속도 스파이크가 FP 로 잡힐 수 있다.

**작업**:
1. `arm_kinematics` 에 **visibility-weighted 칼만 게인** 도입.
   - visibility 낮은 관절 = 측정을 덜 믿고 예측을 더 믿음.
2. 가려짐 → 복구 전이 구간에서만 trigger 를 억제하는 임계 구간 플래그 추가.
3. `v7_vis_gated` 평가.

**기대**: 훅/어퍼컷의 FP 감소. "가려짐에도 견고한 추적" 어필.

---

### Phase 4 — sim2real 노이즈 모델 반영 (학습 데이터) ⏸ 후순위

**문제**: `synth_dataset.py` 의 `NOISE_M=0.003` 등방 가우시안은 실제 MediaPipe
jitter(양자화·관절 상관 진동·가시성 의존)와 다르다.

**작업**:
1. `benchmark_landmarks.jsonl` 에서 관절별 실제 편차 분포를 추정.
2. 합성 생성기에 실제 노이즈 모델을 반영 (옵션 플래그).
3. 합성 vs 실측 landmark 분포를 DTW/KL 로 정량 비교 보고.

**기대**: 합성으로 학습한 TCN 의 실측 일반화 개선. sim2real 스토리.

---

### 병행 — 평가 지표 확장

- `scoring.py` 에 **latency CDF (p50/p95)** 추가 (현재 mean 하나뿐).
- `run_pipeline.py` 의 `generate_markdown_report` 에 혼동행렬 + latency 분위수 표 추가.
- registry 에 `timing_p50_ms / timing_p95_ms` 컬럼 추가.

---

## 3. 실행 순서와 산출물

```text
Phase 1 (속도 스무딩)  →  v7_velocity_smooth
Phase 2 (기하 정규화)  →  v7_2d_only / v7_3d_world
Phase 3 (가시성 게이팅) →  v7_vis_gated
Phase 4 (sim2real)     →  (데이터 재생성 + 재학습, 후순위)
병행   (지표 확장)     →  scoring/registry 스키마 확장
```

각 Phase 완료 후:
1. `run_suite.py` 로 합성 회귀 확인 (68/68 F1=1.000 유지)
2. `run_pipeline.py --version v7_... --overwrite` 로 평가
3. registry 에서 이전 버전 대비 F1/P/R/recall 변화 기록
4. 해당 결과를 `EVALUATION_REPORT.md` / `CV_TECHNIQUES.md` 에 반영

---

## 4. 안전 원칙 (기존 아카이브 불변)

- v0~v6c 기존 버전은 **절대 덮어쓰지 않는다**.
- 새 작업은 전부 `v7_*` 버전 태그로만 아카이빙.
- movement_pass / scoring 로직을 건드릴 때는 `run_suite.py` 를 먼저 돌려 회귀 확인.
- 실험 config 는 `iter5/eval/configs/v7_*.json` 으로 새로 만든다.

---

## 5. 발표 스토리 (완료 시)

1. **Phase 1**: "유한차분의 잡음 증폭을 칼만/SG 필터로 완화 → Recall +X%p"
2. **Phase 2**: "투영 기하학: 2D foreshortening 을 3D world landmark 로 해결 (F1 수치 증명)"
3. **Phase 3**: "가시성 신뢰도 기반 센서 융합으로 가려짐에 견고"
4. **병행**: "CV 논문 수준 평가: latency CDF p50/p95, 혼동행렬, IoU"

---

## 6. 상태 추적

- [ ] Phase 1: 속도 신호 스무딩 + 지표 확장
- [ ] Phase 2: 어깨선 회전 정규화 + 2D/3D ablation
- [ ] Phase 3: visibility-weighted gating
- [ ] Phase 4: sim2real 노이즈 모델 (후순위)
