# 🥊 Iteration 2: 4-Player AR Shadow Boxing & Battle Arena
> **프로젝트명**: 다자간 실시간 AR 섀도우 복싱 & 배틀 아레나 (시계열 GPU 모션 딥러닝 접목)  
> **환경**: Conda `pjt-4` (Python 3.12 + PyTorch + CUDA)  
> **기간**: Iteration 2 (GPU 모델 학습 & 4인 실시간 대전 파이프라인 완성)

---

## 📌 1. 시스템 아키텍처 (System Architecture)

```
                       ┌────────────────────────────────────────────────────────┐
                       │       [HOST] Central 3D Boxing & Battle Arena          │
                       │          (FastAPI + WebSockets + Three.js 3D)          │
                       │  • 4인 실시간 3D 파이터 캐릭터 격투 & 히트박스 충돌 판정│
                       │  • 펀치 타격 시 화면 흔들림(Camera Shake) + 파티클    │
                       │  • 펀치 속도(km/h) & 파워(N) 실시간 계산 HUD          │
                       │  • K.O. 슬로우 모션 피니시 연출 & 4인 HP 대시보드     │
                       └───────────────────────────▲────────────────────────────┘
                                                   │
                ┌──────────────────────────────────┼──────────────────────────────────┐
                │ WebSocket (Punch Trajectory & Force & Motion Class, Latency < 5ms)   │
                ▼                                  ▼                                  ▼
 ┌─────────────────────────────┐    ┌─────────────────────────────┐    ┌─────────────────────────────┐
 │  [Fighter 1 - Red Boxer]    │    │  [Fighter 2 - Cyan Boxer]   │    │  [Fighter 3 - Gold Mage]    │
 │ (웹캠 앞 플레이어 1)         │    │ (웹캠 앞 플레이어 2)         │    │ (웹캠 앞 플레이어 3)         │
 │ • MediaPipe 양손 실시간 추적│    │ • MediaPipe 양손 실시간 추적│    │ • MediaPipe 양손 실시간 추적│
 │ • PyTorch 시계열 LSTM 추론   │    │ • PyTorch 시계열 LSTM 추론   │    │ • PyTorch 시계열 LSTM 추론   │
 │ • 잽, 훅, 어퍼컷, 가드 판정 │    │ • 잽, 훅, 어퍼컷, 가드 판정 │    │ • 장풍(Energy Wave) 필살기  │
 └─────────────────────────────┘    └─────────────────────────────┘    └─────────────────────────────┘
```

---

## 🥊 2. 복싱 & 전투 모션 6종 정의

| 모션 (Action) | 신체 동작 (Kinematics) | 3D 아레나 반응 & 데미지 |
| :--- | :--- | :--- |
| **JAB / STRAIGHT** | 한 손을 전방으로 빠르게 뻗음 (속도 > 25km/h) | **직선 레이저 펀치 발사 (데미지 12)** |
| **LEFT HOOK** | 왼손을 옆에서 원을 그리며 휘두름 | **좌측 회전 타격 (데미지 18 + 가드 붕괴)** |
| **RIGHT UPPERCUT** | 오른손을 아래에서 위로 솟구치며 타격 | **상단 어퍼컷 타격 (데미지 25 + 넉백)** |
| **TWO-HAND GUARD** | 양 주먹을 얼굴 앞으로 올려 모음 | **방어 모드 (받는 데미지 80% 감소 + 실드 이펙트)** |
| **ENERGY WAVE** | 양손을 가슴에 모았다가 앞으로 강하게 방출 | **[필살기] 거대 에너지파 광역 폭발 (데미지 40)** |
| **IDLE / STEP** | 복싱 기본 스탠스 & 리듬 바운스 | 대기 상태 |

---

## 🚀 4. 실행 방법 (How to Run)

### 1) 서버 실행
```bash
conda activate pjt-4
python iter2/run_arena_server.py
```
*(또는 `iter2\run_arena_server.bat` 더블클릭)*

### 2) 접속 주소
* **Host 관제 대형 3D 링**: `https://localhost:8000/arena`
* **Fighter 1 (Red)**: `https://147.47.201.63:8000/client?id=client_1`
* **Fighter 2 (Cyan)**: `https://147.47.201.63:8000/client?id=client_2`
* **Fighter 3 (Gold)**: `https://147.47.201.63:8000/client?id=client_3`
* **Fighter 4 (Green)**: `https://147.47.201.63:8000/client?id=client_4`

---

## 🕹️ 5. 상세 조작 가이드 (Control Guide)

* **👊 왼손 잽**: 왼손을 앞으로 찌름 (데미지 12)
* **👊 오른손 스트레이트**: 오른손을 앞으로 찌름 (데미지 16)
* **🌀 훅 / ⬆️ 어퍼컷**: 팔을 회전하거나 아래에서 위로 올려침 (데미지 18 ~ 25)
* **🛡️ 더블 가드**: 양손을 얼굴 앞으로 모음 (받는 피해 80% 방어)
* **🏃 풋워크 이동**: 몸을 좌우로 기울이거나 키보드 `[W / A / S / D]`로 링 위 이동 및 360도 회전
