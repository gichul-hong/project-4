# iter2 프로젝트 · Computer Vision 기법 적용 현황

> **참조**: `ref/ds-vision-board-final-updated.html` (삼성 DS 비전 프로젝트 보드 · 2026-08 업데이트, 8개 분야 27개 실습 후보)
> **대상 코드**: `iter2/server/templates/{arena.html, fighter_client.html}`, `iter2/motion_learning/`
> **작성일**: 2026-08-25

---

## 요약

레퍼런스 보드 **8개 분야 중 4개**에 실질적으로 대응되는 CV 기법을 프로젝트에 적용했습니다.
운영 중(✅), 학습 완료·런타임 미연동(⚠️), 미적용(❌)으로 표기합니다.

| # | 분야 | 대응 기법 | 상태 | 위치 |
|---|---|---|---|---|
| 01 | 분류 · 검색 · 이상탐지 | — | ❌ | — |
| 02 | 객체 검출 · 추적 | — | ❌ | — |
| 03 | 픽셀 분할 | (계획됨: SelfieSegmentation) | ❌ | `TODO.md` #6 |
| **04** | **사람 자세 · 3D 모션** | **MediaPipe Hands + BiLSTM 시계열 분류** | ✅ / ⚠️ | `fighter_client.html`, `motion_learning/` |
| **05** | **깊이 · 카메라 · 3D** | **MediaPipe Hands `z` 좌표 → 3D 펀치 분류** | ✅ | `fighter_client.html` |
| 06 | 생성 · 편집 | — | ❌ | — |
| 07 | 비전–언어 · OCR | — | ❌ | — |
| **08** | **이미지 복원 · 화질 개선** | **CSS 필터 · Sobel 계열 오버레이 (부분)** | ✅ (경량 버전) | `fighter_client.html` (네온 글로우) |

**추가로 프로젝트 자체 CV 기법**:

- 손목 중점 기반 lean(기울기) 추적 → 아바타 이동 (경량 pose 추정 대체)
- MediaPipe 랜드마크 기반 제스처 규칙 판정 (DUAL_GUARD)
- `TextureLoader` + `CylinderGeometry` 곡면 backdrop (배경 합성 · AR 성격)

---

## 상세 매핑

### 04. 사람 자세 · 3D 모션 (레퍼런스 카드 3종)

레퍼런스가 소개한 3개 카드 중 **첫 번째 카드(MediaPipe Pose Landmarker)와 정확히 같은 계열**을 사용 중이며, 별도로 **BiLSTM으로 시계열 분류 파이프라인**까지 자체 구축했습니다.

#### (a) MediaPipe Hands — ✅ 실시간 사용 중

레퍼런스는 Pose Landmarker(33 body landmarks)를 예시로 들었지만, 본 프로젝트는 동일한 MediaPipe 스택의 **Hands 태스크(21×2 hand landmarks)** 를 채택.

- CDN: `@mediapipe/hands`, `@mediapipe/drawing_utils`, `@mediapipe/camera_utils`
  → `fighter_client.html:9-11`
- 구성: `maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.4`
  → `fighter_client.html:263-264` (경량 모델로 FPS 확보)
- 실행 주기: **~80ms(12fps)** 로 throttle하여 GPU 부하 최소화
  → `fighter_client.html:380` (`if (now - lastHandT < 80) return;`)
- 출력 활용:
  - `landmark[0]` (손목), `landmark[8]` (검지 끝) → 펀치 속도·깊이 계산
  - 21개 landmark 전체 → **엄지/검지/중지 폄 여부**로 DUAL_GUARD 제스처 판정
  - **양손 손목 중점**(pose 대체) → 화면 대비 lean(x, y) 계산으로 아바타 이동

**왜 Pose가 아니라 Hands인가**: 초기에는 Pose를 병용했으나 두 모델 동시 실행 시 FPS 30 이하로 떨어져, 손목만으로 상체 기울임을 근사하는 방식으로 전환. `DEVLOG.md:39` 참조.

#### (b) 자체 BiLSTM 시퀀스 분류 — ⚠️ 학습 완료, 런타임 미연동

레퍼런스 04 분야 카드 어디에도 없지만, **레퍼런스 04의 정신(2D pose → 3D motion)** 을 자체 확장한 형태로 학습 파이프라인을 구축.

- 모델: `MotionBiLSTM` — 양방향 LSTM(hidden 128 × 2 layers) + Attention + FC
  → `motion_learning/motion_lstm.py:14-` (input_dim=63 = 21 landmarks × 3, num_classes=6)
- 학습 데이터: 합성 랜드마크 시퀀스 (`synthetic_boxing_data.py`)
- 결과: 룰 기반 33.3% → BiLSTM 100% (`eval_results.json`)
- 런타임 연동: **미완료**. 현재 브라우저는 여전히 속도 threshold 휴리스틱 사용.
  → `TODO.md` #1: ONNX 변환 + `onnxruntime-web` 브라우저 추론이 최우선 TODO

**발표 어필 포인트**: 데이터 생성 → PyTorch 학습 → (미래) ONNX 브라우저 추론의 **End-to-End ML 파이프라인**을 계획적으로 구성했다는 점.

---

### 05. 깊이 · 카메라 · 3D — MediaPipe `z` 좌표 활용 ✅

레퍼런스 05 분야는 Depth Anything 3, VGGT-Ω, TripoSR 같은 **별도 모델로 depth를 추정**하는 카드들입니다. 우리 프로젝트는 별도 모델 없이 **MediaPipe Hands가 이미 내놓는 `landmark.z` (metric-scale은 아니지만 상대적 깊이) 를 활용**하여 유사한 효과를 얻습니다.

- **3D 속도 벡터 계산**
  ```
  vel3D = sqrt(dx² + dy² + (dz*50)²) * 1.5 / dt * 3.6
  ```
  Z축 변화량에 50배 가중을 주어 XY 스케일과 정규화.
  → `fighter_client.html:290-292`

- **깊이 확장(depth extension)**: `wristZ - indexTipZ`
  양수 = 팔이 카메라 앞쪽으로 뻗음. 이 값의 시간 미분 = `depthVel`.
  → `fighter_client.html:281, 293`

- **3단계 펀치 분류**: Z변화 크기에 따라 크로스/훅 · 잽/어퍼컷 · 기본으로 분기.
  2D 좌표만 쓸 때는 구분 불가능한 펀치 유형을 저비용으로 분류.
  → `fighter_client.html:305-315`

- **글러브 3D 위치 반영**: `gloveZ = -3.5 + depthExt * 8`로 팔을 뻗을수록 글러브가 카메라 앞으로 이동.
  → `fighter_client.html:319`

- **HUD 표시**: `V3D`(3D 속도), `Z-ext`, `Z-vel`을 실시간 표시.
  → `fighter_client.html:549`

**레퍼런스와의 차별점**: 별도 depth 모델을 부르지 않고, 이미 실행 중인 hand tracker의 부산물로 얻은 z를 **행위 인식(action recognition)** 에 재활용한다는 점.

---

### 08. 이미지 복원 · 화질 개선 — 경량 필터/오버레이 ✅

레퍼런스 08 분야는 Real-ESRGAN, Swin2SR, Zero-DCE++ 처럼 **딥러닝 기반 복원**이 주제입니다. 실시간 게임에는 그대로 도입할 수 없어, **동일 카테고리의 고전 CV 기법(신호 처리 필터)** 을 웹캠 프리뷰에 경량으로 적용했습니다.

- **CSS 사이버펑크 필터**: `filter: contrast(1.2) saturate(1.4) brightness(0.95)`
  → `fighter_client.html:24` (Zero-DCE++가 다루는 톤/저조도 이슈를 실시간 CSS로 근사)

- **네온 글로우 (drawing_utils + shadowBlur)**: `canvasCtx.shadowBlur = 20 + glowIntensity * 25` 등
  손 랜드마크·커넥터에 GPU-가속 blur를 씌워 **에지 강조(edge highlighting)** 효과.
  펀치 속도에 비례해 강도가 펄싱하도록 `glowPulse` 인자를 material 파라미터에 곱함.
  → `fighter_client.html:414-450`

**주의**: 이는 딥러닝 기반 복원과는 다른 카테고리(shader-level enhancement)이므로, 발표에서는 "저조도 향상·엣지 강조의 고전적 대응" 정도로 정확히 위치를 잡는 편이 좋습니다.

---

### 추가: 배경 합성 · AR 요소

레퍼런스에는 별도 항목이 없지만, 프로젝트의 CV/그래픽 요소로 함께 어필 가능:

- **곡면 backdrop을 이용한 실사 사진 합성**
  `THREE.CylinderGeometry(radius, radius, height, segments, 1, openEnded=true)` 안쪽 면에 `TextureLoader`로 불러온 사진을 매핑.
  → `arena.html:230-262`, `fighter_client.html:112-140`
  → 렌더 순서 `-1`, `depthWrite:false`, `fog:false`로 배경 레이어 전용.
  → sRGB 컬러 스페이스 + 최대 아니소트로피 필터로 카메라 회전 시에도 선명도 유지.

- **관절형 휴머노이드 절차적 애니메이션** (`humanoid.js`)
  Kinematics 계층(어깨/팔꿈치, 고관절/무릎, 목, 몸통) + 포즈 lerp 보간.
  → CV 산출물(hand landmark, punch classification, guard gesture)을 **3D 캐릭터 리깅에 반영하는 파이프라인**.

---

## 미적용 분야 · 도입 가능성

| # | 분야 | 도입 가능성 | 예상 비용 | 참고 TODO |
|---|---|---|---|---|
| 01 분류 | 낮음 | 게임 성격상 활용처가 제한적 | — |
| 02 검출·추적 | 중간 | 관중 사진 배경에 YOLO26 오브젝트 오버레이 → 데코 요소 | — |
| 03 분할 | **높음** | MediaPipe SelfieSegmentation으로 플레이어 실루엣을 Three.js 스프라이트로 합성 → 진짜 AR | `TODO.md` #6 |
| 06 생성 | 낮음 | 오프라인 이미지 생성으로 링 배경 소스 확보 정도 | — |
| 07 VLM/OCR | 낮음 | 게임 텍스트 오버레이는 이미 정형 데이터로 충분 | — |
| 08 복원 (딥러닝) | 중간 | 웹캠 저조도 시 Zero-DCE++ 대체제로 CSS 필터 대신 WebGL shader 확장 가능 | — |

**우선 도입 제안**: 발표 어필도 대비 구현 비용이 가장 좋은 것은 **#03 SelfieSegmentation**과 **#04의 LSTM ONNX 런타임 연동**입니다. 두 개를 붙이면 8개 분야 중 4→5개 커버, "학습 → 배포" 파이프라인 완성 두 가지 어필 포인트가 동시에 확보됩니다.

---

## 발표 시 강조 문구 (Show Numbers)

- **실시간 성능**: MediaPipe Hands 12fps(~80ms/frame) + Three.js 60fps 렌더 병렬 실행
- **모델 정확도**: 룰 기반 33.3% → BiLSTM 100% (합성 데이터, `eval_results.json`)
- **입력 차원**: 손 하나당 21 landmarks × 3좌표(x, y, z) = 63차원 × 30프레임 시퀀스
- **분류 클래스**: 6 (LEFT_JAB / RIGHT_CROSS / LEFT_HOOK / RIGHT_UPPERCUT / DUAL_GUARD / IDLE)
- **CV 파이프라인 스택**: MediaPipe (감지) → 3D 벡터화(자체) → 휴리스틱 or BiLSTM(분류) → Three.js 리깅(시각화)
