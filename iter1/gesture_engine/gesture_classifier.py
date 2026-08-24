import os
import math
import pickle
import numpy as np

GESTURE_NAMES = {
    0: "IDLE",
    1: "PINCH_ZOOM",
    2: "GRAB_ROTATE",
    3: "OPEN_PALM_PAN",
    4: "POINT_SCAN"
}

def normalize_landmarks(landmarks_3d):
    """
    21개 손 랜드마크(x, y, z)를 손목(0번) 원점 기준으로 평행이동하고,
    손바닥 크기(0번 손목과 9번 중지 기저부 사이의 거리)로 스케일 정규화하여
    거리 및 카메라 위치에 불변한 63차원 벡터 생성.
    """
    pts = np.array(landmarks_3d, dtype=np.float32)  # shape: (21, 3)
    wrist = pts[0].copy()
    pts_centered = pts - wrist  # 손목을 (0, 0, 0)으로 이동

    # 0번(손목)과 9번(중지 MCP) 사이의 거리
    palm_size = np.linalg.norm(pts_centered[9])
    if palm_size < 1e-4:
        palm_size = 1.0

    pts_normalized = pts_centered / palm_size
    return pts_normalized.flatten()  # 63차원 1D 벡터


def rule_based_gesture(landmarks_3d):
    """
    [Step 1 베이스라인] 단순 관절 간 유클리드 거리 및 각도 기반 룰 제스처 판별기
    """
    pts = np.array(landmarks_3d, dtype=np.float32)
    wrist = pts[0]
    thumb_tip = pts[4]
    index_tip = pts[8]
    middle_tip = pts[12]
    ring_tip = pts[16]
    pinky_tip = pts[20]

    # 손가락 끝과 손목 간 거리
    palm_scale = np.linalg.norm(pts[9] - wrist) + 1e-5
    d_thumb = np.linalg.norm(thumb_tip - wrist) / palm_scale
    d_index = np.linalg.norm(index_tip - wrist) / palm_scale
    d_middle = np.linalg.norm(middle_tip - wrist) / palm_scale
    d_ring = np.linalg.norm(ring_tip - wrist) / palm_scale
    d_pinky = np.linalg.norm(pinky_tip - wrist) / palm_scale

    # 1. 핀치 (엄지와 검지 끝점의 거리)
    pinch_dist = np.linalg.norm(thumb_tip - index_tip) / palm_scale
    if pinch_dist < 0.35 and d_middle > 1.0:
        return 1, "PINCH_ZOOM", 0.85

    # 2. 주먹 (모든 손가락 끝이 손목에 가까움)
    if d_index < 1.1 and d_middle < 1.1 and d_ring < 1.1 and d_pinky < 1.1:
        return 2, "GRAB_ROTATE", 0.90

    # 3. 검지 찌르기 (검지만 펴지고 나머지는 접힘)
    if d_index > 1.3 and d_middle < 1.15 and d_ring < 1.15 and d_pinky < 1.15:
        return 4, "POINT_SCAN", 0.92

    # 4. 손바닥 펴기 (모든 손가락이 활짝 펴짐)
    if d_index > 1.3 and d_middle > 1.3 and d_ring > 1.3 and d_pinky > 1.3:
        return 3, "OPEN_PALM_PAN", 0.88

    return 0, "IDLE", 0.70


class MLPGestureClassifier:
    """
    [Step 2 개선 모델] 정규화된 랜드마크 기반 MLP 제스처 분류기
    """
    def __init__(self, model_path=None):
        self.model = None
        if model_path and os.path.exists(model_path):
            self.load(model_path)

    def load(self, model_path):
        with open(model_path, "rb") as f:
            self.model = pickle.load(f)

    def predict(self, landmarks_3d):
        if self.model is None:
            # 학습 모델이 없으면 룰 기반으로 fallback
            return rule_based_gesture(landmarks_3d)

        feat = normalize_landmarks(landmarks_3d).reshape(1, -1)
        pred_idx = int(self.model.predict(feat)[0])
        proba = float(np.max(self.model.predict_proba(feat)[0]))
        return pred_idx, GESTURE_NAMES.get(pred_idx, "UNKNOWN"), proba
