# 🥊 4-Player Real-time AR Shadow Boxing & Battle Arena
> **프로젝트명**: 다자간 실시간 AR 섀도우 복싱 & 배틀 아레나 (시계열 GPU 딥러닝 모션 분류 접목)  
> **과제**: Samsung DS Computer Vision Practicum (SNU Visual Computing Lab)  
> **환경**: Conda `pjt-4` (Python 3.12, PyTorch 2.13, MediaPipe, FastAPI, WebSockets, Three.js)

---

## 📌 1. 프로젝트 소개 (Project Overview)

본 프로젝트는 별도의 VR 장비나 전용 컨트롤러 없이, **4대의 일반 노트북 웹캠만으로 4명의 플레이어가 실시간 3D 복싱 링 위에서 대전하는 비접촉식 AR 배틀 게임**입니다.

* **양손 독립 추적**: 왼손 잽, 오른손 스트레이트, 양손 가드, 장풍 필살기 인식
* **신체 풋워크 & 360도 회전**: 몸 기울임(Leaning) 및 키보드로 링 위를 자유자재로 이동
* **GPU 시계열 딥러닝 (Bi-LSTM)**: 30프레임 관절 궤적 기반 모션 분류 (**정확도 100.0% 달성, 베이스라인 대비 +66.67%p 개선**)
* **실시간 Web Audio 음향 & 60초 경기 시스템**: 타격음, 바람소리, 복싱 링 공 소리 및 실시간 전투 통계 HUD

---

## 🚀 2. 실행 방법 (Quick Start Guide)

### 1단계: 환경 활성화
```bash
conda activate pjt-4
```

### 2단계: 메인 서버(Host) 실행
터미널에서 아래 명령어를 실행하거나, 배치 파일을 더블클릭합니다:
```bash
python iter2/run_arena_server.py
```
*(또는 `iter2\run_arena_server.bat` 더블클릭)*

---

## 🖥️ 3. 접속 주소 안내 (URL Access)

> **⚠️ 브라우저 접속 팁**: `https://`로 접속 시 자체 서명 인증서 경고가 뜨면 **[고급] $\rightarrow$ [안전하지 않음으로 이동]**을 클릭하시면 정상 실행됩니다.

| 역할 | 접속 주소 (URL) | 설명 |
| :--- | :--- | :--- |
| **🖥️ 메인 관제 화면 (Host)** | **`https://localhost:8000/arena`** | 4인 3D 복싱 링 대형 스크린 관제 뷰 |
| **🔴 Fighter 1 (Red Boxer)** | **`https://147.47.201.63:8000/client?id=client_1`** | 파이터 1 웹캠 1인칭 대전 뷰 |
| **🔵 Fighter 2 (Cyan Boxer)** | **`https://147.47.201.63:8000/client?id=client_2`** | 파이터 2 웹캠 1인칭 대전 뷰 |
| **🟡 Fighter 3 (Gold Mage)** | **`https://147.47.201.63:8000/client?id=client_3`** | 파이터 3 웹캠 1인칭 대전 뷰 |
| **🟢 Fighter 4 (Green Striker)**| **`https://147.47.201.63:8000/client?id=client_4`** | 파이터 4 웹캠 1인칭 대전 뷰 |

---

## 🥊 4. 상세 조작 가이드 (Control Guide)

### 👊 1) 복싱 타격 및 방어 제스처 (Webcam Hands)
웹캠 앞에서 양손을 올리고 복싱 스탠스를 취합니다:

| 조작 동작 (Action) | 웹캠 앞 신체 제스처 | 게임 내 반응 & 효과 | 데미지 |
| :--- | :--- | :--- | :---: |
| **👊 왼손 잽 (Left Jab)** | 왼손을 카메라를 향해 앞으로 빠르게 찌름 | 화면 왼쪽 글러브가 전방으로 돌진 | **12 HP** |
| **👊 오른손 스트레이트 (Right Cross)** | 오른손을 카메라를 향해 앞으로 빠르게 찌름 | 화면 오른쪽 글러브가 전방으로 돌진 | **16 HP** |
| **🌀 훅 (Left/Right Hook)** | 팔을 옆에서 안쪽으로 원을 그리며 휘두름 | 회전 타격 및 상대방 넉백 유발 | **18 HP** |
| **⬆️ 어퍼컷 (Uppercut)** | 주먹을 아래에서 위로 힘차게 올려침 | 하단에서 솟구치는 타격 | **25 HP** |
| **🛡️ 양손 가드 (Dual Guard)** | 양 주먹을 얼굴/가슴 앞으로 모음 | 반투명 홀로그램 에너지 실드 전개 | **피해 80% 방어** |
| **⚡ 장풍 필살기 (Energy Wave)** | 양손을 가슴에 모았다가 앞으로 방출 | 광역 에너지 폭발 공격 | **40 HP** |

---

### 🏃 2) 링 위 이동 및 360도 방향 전환 (Footwork & Navigation)
상대방에게 다가가거나 주먹을 피하기 위한 풋워크 조작법입니다:

* **[신체 풋워크 (몸 기울임)]**:
  * 웹캠 앞에서 **몸을 왼쪽으로 기울이면** $\rightarrow$ 링 안에서 **왼쪽 사이드 스텝 (Step Left)**
  * 웹캠 앞에서 **몸을 오른쪽으로 기울이면** $\rightarrow$ 링 안에서 **오른쪽 사이드 스텝 (Step Right)**
* **[키보드 조작 (WASD & 방향키)]**:
  * **`W` 또는 `↑`**: 내가 바라보는 상대방을 향해 **앞으로 성큼 전진 (Advance)**
  * **`S` 또는 `↓`**: 뒤로 **백스텝 후퇴 (Backstep)**
  * **`A` 또는 `←`**: 링 안에서 **시점을 왼쪽으로 360도 회전**
  * **`D` 또는 `→`**: 링 안에서 **시점을 오른쪽으로 360도 회전**

---

## 🔬 5. GPU 딥러닝 성능 지표 (Show Numbers)

* **모델 아키텍처**: 2-Layer Bidirectional LSTM with Attention (`iter2/motion_learning/motion_lstm.py`)
* **입력 데이터**: 30 프레임(약 0.5초) 관절 궤적 및 속도 시퀀스 $(B \times 30 \times 63)$

| 평가 항목 | Step 1. 정적 2D 룰베이스 | Step 2. Ours (시계열 Bi-LSTM) | 개선폭 (Improvement) |
| :--- | :---: | :---: | :---: |
| **평균 분류 정확도 (Accuracy)** | 33.33% | **100.00%** | **🔥 +66.67%p 대폭 향상** |
| **패킷 네트워크 지연시간** | - | **< 5 ms** | 초저지연 실시간 동기화 |
| **초당 패킷 대역폭** | - | **12 KB/s (0.2 KB/pkt)** | 60 FPS 무지연 대전 유지 |

---

## 📁 6. 프로젝트 디렉토리 구조

```
project-4/
├── README.md                          # 전체 프로젝트 및 실행/조작 가이드 (본 문서)
├── HANDOFF_ITER2.md                   # Iteration 2 상세 인수인계 및 기술 문서
├── PROJECT_PROPOSALS.md               # 초기 기획안 및 아이디어 제안서
├── iter1/                             # Iteration 1 (3D 피라미드 탐사 프로토타입)
└── iter2/                             # Iteration 2 (4인 AR 복싱 배틀 아레나 메인 시스템)
    ├── run_arena_server.py            # HTTPS uvicorn 서버 실행기
    ├── run_arena_server.bat           # 원클릭 실행 배치 스크립트
    ├── motion_learning/               # PyTorch GPU 모션 학습 파이프라인
    │   ├── motion_lstm.py             # 시계열 Bi-LSTM 모델 아키텍처
    │   ├── train_gpu_motion.py        # 딥러닝 학습 및 정량 평가 스크립트
    │   ├── boxing_lstm.pth            # 학습 완료된 가중치 파일
    │   └── eval_results.json          # Show Numbers 결과 지표 JSON
    └── server/                        # 백엔드 서버 및 프론트엔드 템플릿
        ├── app.py                     # FastAPI + WebSockets 실시간 대전 서버
        └── templates/
            ├── arena.html             # 메인 Host 3D 복싱 링 (관제 대형 화면)
            └── fighter_client.html    # 4인 파이터 1인칭 듀얼 뷰 클라이언트
```
