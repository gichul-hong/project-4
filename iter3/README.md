# 🥊 Iteration 2: 4-Player AR Shadow Boxing & Battle Arena

> **프로젝트명**: 다자간 실시간 AR 섀도우 복싱 & 배틀 아레나
> **환경**: Conda `pjt-4` (Python 3.12 + FastAPI + PyTorch + CUDA)
> **최종 갱신**: 2026-08-25

---

## 📌 1. 시스템 아키텍처 (System Architecture)

```
                       ┌────────────────────────────────────────────────────────┐
                       │       [HOST] Central 3D Boxing & Battle Arena          │
                       │          (FastAPI + WebSocket + Three.js r128)         │
                       │  • 4인 실시간 3D 파이터 캐릭터 격투 & 히트박스 충돌 판정│
                       │  • 펀치 타격 시 화면 흔들림(Camera Shake) + 파티클     │
                       │  • 펀치 속도(km/h) & 3D 벡터 실시간 계산 HUD           │
                       │  • K.O. 연출 & 4인 HP 대시보드                         │
                       │  • 곡면 backdrop(CylinderGeometry) 실사 배경 합성      │
                       └───────────────────────────▲────────────────────────────┘
                                                   │
                ┌──────────────────────────────────┼──────────────────────────────────┐
                │  WebSocket (position · action · velocity, throttled ~40 msg/sec)     │
                ▼                                  ▼                                  ▼
 ┌─────────────────────────────┐    ┌─────────────────────────────┐    ┌─────────────────────────────┐
 │  [Fighter 1 - Red Boxer]    │    │  [Fighter 2 - Cyan Boxer]   │    │  [Fighter 3 - Gold Mage]    │
 │ (웹캠 앞 플레이어 1)        │    │ (웹캠 앞 플레이어 2)        │    │ (웹캠 앞 플레이어 3)        │
 │ • MediaPipe Hands (21×2)    │    │ • MediaPipe Hands (21×2)    │    │ • MediaPipe Hands (21×2)    │
 │ • 3D 속도(V3D) · Z-depth    │    │ • 3D 속도(V3D) · Z-depth    │    │ • 3D 속도(V3D) · Z-depth    │
 │ • JAB/HOOK/UPPERCUT/CROSS   │    │ • JAB/HOOK/UPPERCUT/CROSS   │    │ • 장풍(ENERGY_WAVE) 필살기  │
 │ • 네온 글로우 AR 오버레이   │    │ • 네온 글로우 AR 오버레이   │    │ • 네온 글로우 AR 오버레이   │
 └─────────────────────────────┘    └─────────────────────────────┘    └─────────────────────────────┘
```

---

## 🥊 2. 복싱 & 전투 모션 정의

| 모션 (Action) | 신체 동작 (Kinematics) | 3D 아레나 반응 & 데미지 |
| :--- | :--- | :--- |
| **LEFT_JAB / RIGHT_CROSS** | 한 손을 전방으로 빠르게 뻗음 (V3D > 12 km/h, Z변화 낮음~중간) | 직선 타격 (데미지 12~16) |
| **LEFT_HOOK / RIGHT_CROSS** | 팔을 크게 뻗음 (Z변화 큼, `depthVel > 3.0`) | 회전/스트레이트 강타 (데미지 18) |
| **RIGHT_UPPERCUT** | 아래→위 궤적 (Z변화 중간, `depthVel > 1.5`) | 어퍼컷 (데미지 25) |
| **DUAL_GUARD** | 양손을 얼굴 앞으로 모음 (엄지·검지·중지 모두 폄) | 방어 모드 (받는 데미지 80% 감소) |
| **ENERGY_WAVE** | 양손 폭발 제스처 | 원거리 광역 (데미지 40, 사거리 30 units) |
| **IDLE** | 기본 스탠스 | 대기 상태 |

**분류 파이프라인**: `MediaPipe Hands (21×2 landmarks)` → `3D 속도 벡터화 (dx²+dy²+(dz*50)²)` → `임계값·깊이 변화 기반 3단계 분기` → 서버 판정.
학습된 BiLSTM(`motion_learning/boxing_lstm.pth`, 6-class)은 준비 상태이며 브라우저 런타임 연동은 TODO.

---

## 🎯 3. Computer Vision 기법 적용 현황

레퍼런스 `ref/ds-vision-board-final-updated.html`의 8개 분야 중 4개 분야에 실질적으로 대응. 상세는 [`CV_TECHNIQUES.md`](./CV_TECHNIQUES.md) 참조.

| 분야 | 상태 | 프로젝트 대응 |
| :--- | :---: | :--- |
| 04 사람 자세·3D 모션 | ✅ / ⚠️ | MediaPipe Hands 실시간 + BiLSTM 학습 완료(런타임 미연동) |
| 05 깊이·카메라·3D | ✅ | MediaPipe `landmark.z`로 3D 펀치 분류 |
| 08 이미지 복원·화질 개선 | ✅ (경량) | CSS 필터 + Canvas `shadowBlur` 엣지 강조 |
| 03 픽셀 분할 | ❌ | 계획됨 (TODO #6 SelfieSegmentation) |

**End-to-End ML 파이프라인 (계획)**: 합성 데이터 → PyTorch BiLSTM 학습(정확도 100%) → ONNX 변환 → `onnxruntime-web` 브라우저 추론. `TODO.md` #1 참조.

---

## 🚀 4. 실행 방법 (How to Run)

### 1) 서버 실행
```powershell
conda activate pjt-4
python iter2\run_arena_server.py
```
또는 `iter2\run_arena_server.bat` 더블클릭.

### 2) 접속 주소
로컬 개발 기준. 원격 배포 시에는 IP/포트를 실제 값으로 교체.

| 뷰 | URL | 슬롯 |
| :--- | :--- | :--- |
| **Host 관제 3D 링** | `https://localhost:8000/arena` | `host_arena` (1인 전용) |
| Fighter 1 (Red)  | `https://<host>:8000/client?id=client_1` | `client_1` |
| Fighter 2 (Cyan) | `https://<host>:8000/client?id=client_2` | `client_2` |
| Fighter 3 (Gold) | `https://<host>:8000/client?id=client_3` | `client_3` |
| Fighter 4 (Green)| `https://<host>:8000/client?id=client_4` | `client_4` |

> **⚠️ 슬롯 중복 접속 방지**: 각 슬롯(`host_arena` · `client_1~4`)은 **동시 1인**만 허용. 이미 사용 중인 슬롯으로 접속하면 WebSocket이 `code 4409 (slot_in_use)`로 거절되고 브라우저에 안내 오버레이가 뜹니다. Fighter 슬롯 거절 시에는 오버레이에서 다른 남은 슬롯 링크가 자동 제공됩니다.

### 3) (선택) 링 배경 사진 배치
`iter2/server/static/ring_bg.jpg` 파일을 넣으면 arena/fighter 두 뷰 모두 곡면 backdrop 텍스처로 자동 반영됩니다. 파일이 없으면 어두운 단색 배경으로 폴백. 어떤 비율의 사진이든 가능하지만, 가로가 세로보다 훨씬 긴 이미지가 자연스럽습니다.

---

## 🕹️ 5. 상세 조작 가이드 (Control Guide)

### Fighter (웹캠 클라이언트)
- **👊 왼손 잽 / 오른손 스트레이트**: 손을 앞으로 빠르게 찌름
- **🌀 훅 / ⬆️ 어퍼컷**: 팔을 크게 앞으로 뻗어 Z 깊이 변화 크게 (`depthVel > 3.0`이면 HOOK/CROSS, `> 1.5`면 JAB/UPPERCUT)
- **🛡️ 더블 가드**: 양손 엄지·검지·중지를 함께 폄 → 받는 피해 80% 감소
- **🏃 풋워크 이동**:
  - 몸을 좌우/앞뒤로 기울이면 lean 계산으로 아바타 이동
  - 키보드 `↑ ↓ ← →` (**화살표 키만** — WASD는 지원하지 않음)
  - 좌우 방향키: 아바타 yaw 회전
  - 상하 방향키: 아바타 전/후진

### Host (arena 관제뷰)
- 마우스 드래그: 카메라 orbit
- 마우스 휠: 줌
- 자동으로 파이터 위치를 추적하고 K.O. 시 카메라 shake 발동

---

## 📁 6. 저장소 구조 (요약)

```
iter2/
├── server/
│   ├── app.py                    # FastAPI + WebSocket 서버 · 4인 파이터 상태 관리
│   ├── templates/
│   │   ├── arena.html            # Host 관제 3D 링 (Three.js)
│   │   └── fighter_client.html   # Fighter 웹캠 클라이언트 (MediaPipe + 1인칭 Three.js)
│   └── static/
│       ├── humanoid.js           # 관절형 휴머노이드 팩토리 (전역 window.createHumanoid)
│       └── ring_bg.jpg           # (선택) 링 배경 파노라마/일반 사진
├── motion_learning/
│   ├── motion_lstm.py            # BiLSTM 모델 정의 (input=63, hidden=128×2, classes=6)
│   ├── synthetic_boxing_data.py  # 합성 랜드마크 시퀀스 생성기
│   ├── train_gpu_motion.py       # GPU 학습 스크립트
│   ├── boxing_lstm.pth           # 학습 완료 가중치
│   └── eval_results.json         # 룰 33.3% → LSTM 100% 평가 결과
├── run_arena_server.py           # 서버 부트스트랩
├── run_arena_server.bat          # Windows 원클릭 실행
├── README.md                     # 이 파일
├── TODO.md                       # CV/AI 개선 로드맵 (우선순위 표 + 상세)
├── DEVLOG.md                     # 변경 이력 (최신이 위)
└── CV_TECHNIQUES.md              # CV 기법 매핑 · 발표용 정리
```

---

## 🔗 7. 관련 문서

- [`TODO.md`](./TODO.md) — CV/AI 기능 개선 로드맵 (7개 항목, 우선순위 순)
- [`DEVLOG.md`](./DEVLOG.md) — 일자별 변경 이력
- [`CV_TECHNIQUES.md`](./CV_TECHNIQUES.md) — 레퍼런스 8개 분야 대비 매핑 · 발표용 자료
- `ref/ds-vision-board-final-updated.html` — 삼성 DS 비전 프로젝트 보드(레퍼런스)
