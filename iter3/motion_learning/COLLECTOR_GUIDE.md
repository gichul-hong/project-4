# Iter3 가슴 위 복싱 동작 데이터 수집기

장풍을 포함한 10개 라벨을 수집합니다. 촬영 영상은 기본으로 저장되며, 각 프레임에는 MediaPipe Pose의 가슴 위 15개 랜드마크가 저장됩니다. 하나의 JSON에서 휴리스틱 최적화, Bi-LSTM 전체 시퀀스 학습, TCN 인과 윈도우 학습 데이터를 모두 만들 수 있습니다.

## 실행

프로젝트 루트에서:

```powershell
.\.venv\Scripts\python.exe .\iter3\motion_learning\collector_app.py
```

또는 다음 파일을 실행합니다.

```text
iter3\motion_learning\run_collector.bat
```

Chrome 또는 Edge에서 접속합니다.

```text
http://localhost:8010
```

## 수집 라벨

```text
IDLE
OTHER
LEFT_JAB
RIGHT_JAB
LEFT_HOOK
RIGHT_HOOK
LEFT_UPPERCUT
RIGHT_UPPERCUT
TWO_HAND_GUARD
ENERGY_WAVE
```

모든 라벨은 설정한 반복 수만큼 동일하게 수집됩니다. 동작 순서는 반복 블록마다 무작위로 섞입니다.

## 촬영 순서

1. 참가자 ID와 세션 ID를 입력합니다.
2. `카메라 시작`을 누릅니다.
3. 머리, 양쪽 어깨, 팔꿈치와 양손이 화면 안에 들어오도록 맞춥니다.
4. `POSE: 상체 준비 완료`를 확인합니다.
5. 라벨별 반복 수를 선택한 뒤 양손을 머리 위로 올려 1.2초 유지합니다. 화면의 `수집 시작` 버튼을 눌러도 됩니다.
6. `준비 3초 → 액션` 안내에 따라 움직입니다.
7. 품질이 낮은 샘플은 영상과 관절 데이터 모두 저장하지 않고 같은 동작을 자동 재촬영합니다.

촬영 화면의 단계는 다음과 같이 구분됩니다.

- 노란색 `준비`: 3초 동안 아직 동작하지 않고 기본자세를 유지합니다.
- 빨간색 `지금 동작!`: 안내된 동작을 수행합니다.
- 중앙 숫자와 막대는 현재 단계의 남은 시간을 나타냅니다.

카메라 미리보기만 좌우 반전됩니다. 저장 영상과 관절 좌표는 카메라·MediaPipe 원본 좌우 기준입니다.

## 저장 위치

```text
iter3/motion_learning/collected_pose/
├─ manifest.jsonl
└─ person_01/
   └─ session_01/
      ├─ IDLE/
      │  ├─ sample_id.json
      │  └─ sample_id.webm
      ├─ OTHER/
      ├─ LEFT_JAB/
      └─ ...
```

각 JSON에는 다음 정보가 포함됩니다.

- 참가자·세션·동작·촬영 변형
- 프레임별 실제 타임스탬프
- 프레임별 상대 시간, `prepare/action` 구간 및 TCN 인과 목표 라벨
- 15개 관절의 `x, y, z, visibility`
- 동작 안내 시작·종료 시점
- 카메라와 MediaPipe 설정
- 프레임률·관절 가시성·최대 프레임 간격 품질지표
- `game_7j_v1`: 30프레임 변환 전 42차원 특징
- `chest_up_15j_v1`: 30프레임 변환 전 90차원 특징
- `heuristic_7j_v1`: 팔꿈치 각도, 팔 뻗음, 손목 속도·거리 등 17개 해석 가능한 신호
- `game_7j_temporal_v2`: 7관절 위치·속도·가속도·가시성 70차원 특징
- `chest_up_15j_temporal_v2`: 15관절 위치·속도·가속도·가시성 150차원 특징

각 JSON과 동일한 `sample_id.webm` 파일에는 준비 3초와 액션 전체 영상이 저장됩니다. 영상 저장은 기본값이며 수집 화면에서 끌 수 없습니다. 참가자에게 영상 저장 및 활용 동의를 받은 후 수집해야 합니다.

## 학습 방식별 데이터 확인

휴리스틱 임계값 최적화용 액션 구간:

```powershell
.\.venv\Scripts\python.exe .\iter3\motion_learning\pose_dataset.py --feature-set heuristic_7j_v1 --segment action
```

상체 15관절 Bi-LSTM 전체 동작 분류용:

```powershell
.\.venv\Scripts\python.exe .\iter3\motion_learning\pose_dataset.py --feature-set chest_up_15j_temporal_v2 --segment action --sequence-length 30
```

7관절 Causal TCN 실시간 추론용 최근 10프레임 윈도우:

```powershell
.\.venv\Scripts\python.exe .\iter3\motion_learning\pose_dataset.py --mode tcn --feature-set game_7j_temporal_v2 --window-size 10
```

시퀀스 모드는 실제 타임스탬프 기준으로 지정한 길이에 재표본화합니다. TCN 모드는 미래 프레임을 사용하지 않고 각 윈도우 마지막 프레임의 목표를 사용합니다. `prepare`는 `IDLE`, `action`은 촬영 라벨로 처리됩니다. 기존 스키마의 `post_roll` 데이터는 계속 `IGNORE` 처리됩니다.

평가 시에는 반드시 `participant_id`를 그룹으로 사용해 동일 참가자가 학습과 평가에 동시에 포함되지 않도록 해야 합니다. 8명 수집 시에는 참가자 단위 분할이나 Leave-One-Subject-Out 평가를 권장합니다.
