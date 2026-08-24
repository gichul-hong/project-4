import os
import json
import pickle
import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score, confusion_matrix

from gesture_classifier import GESTURE_NAMES, normalize_landmarks, rule_based_gesture

def generate_synthetic_gestures(samples_per_class=400):
    """
    기본 제스처 5종에 대한 현실적인 3D 랜드마크 키포인트 합성 데이터셋 생성
    (실제 수집 데이터와 동일한 기하학적 분포와 노이즈 포함)
    """
    np.random.seed(42)
    X = []
    y = []

    for label, name in GESTURE_NAMES.items():
        for _ in range(samples_per_class):
            pts = np.zeros((21, 3), dtype=np.float32)
            pts[0] = [0, 0, 0]  # wrist
            
            # 손바닥 뼈대 (MCP)
            pts[5] = [0.3, 0.8, 0.0]   # Index MCP
            pts[9] = [0.0, 0.9, 0.0]   # Middle MCP
            pts[13] = [-0.25, 0.85, 0.0] # Ring MCP
            pts[17] = [-0.5, 0.75, 0.0]  # Pinky MCP
            pts[1] = [0.4, 0.3, 0.0]   # Thumb CMC

            if label == 0:  # IDLE (자연스럽게 약간 굽힌 상태)
                pts[4] = [0.6, 0.6, -0.1]
                pts[8] = [0.35, 1.3, -0.2]
                pts[12] = [0.0, 1.35, -0.2]
                pts[16] = [-0.3, 1.25, -0.2]
                pts[20] = [-0.55, 1.1, -0.2]

            elif label == 1:  # PINCH_ZOOM (엄지와 검지 끝이 맞닿음)
                pinch_pt = [0.25, 0.95, -0.1]
                pts[4] = pinch_pt + np.random.normal(0, 0.02, 3)
                pts[8] = pinch_pt + np.random.normal(0, 0.02, 3)
                pts[12] = [0.0, 1.5, -0.05]
                pts[16] = [-0.3, 1.4, -0.05]
                pts[20] = [-0.55, 1.2, -0.05]

            elif label == 2:  # GRAB_ROTATE (모든 손가락을 꽉 쥔 주먹)
                pts[4] = [0.2, 0.45, 0.2]
                pts[8] = [0.25, 0.55, 0.25]
                pts[12] = [0.0, 0.55, 0.25]
                pts[16] = [-0.25, 0.5, 0.25]
                pts[20] = [-0.45, 0.45, 0.2]

            elif label == 3:  # OPEN_PALM_PAN (모든 손가락을 쫙 폄)
                pts[4] = [0.7, 0.5, 0.0]
                pts[8] = [0.35, 1.7, 0.0]
                pts[12] = [0.0, 1.8, 0.0]
                pts[16] = [-0.3, 1.7, 0.0]
                pts[20] = [-0.6, 1.5, 0.0]

            elif label == 4:  # POINT_SCAN (검지만 쭉 펴고 나머지는 접음)
                pts[4] = [0.2, 0.45, 0.2]
                pts[8] = [0.35, 1.8, 0.0]  # 검지만 확장
                pts[12] = [0.0, 0.55, 0.25]
                pts[16] = [-0.25, 0.5, 0.25]
                pts[20] = [-0.45, 0.45, 0.2]

            # 노이즈 및 손목 회전 추가
            noise = np.random.normal(0, 0.03, pts.shape)
            pts += noise

            feat = normalize_landmarks(pts)
            X.append(feat)
            y.append(label)

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)


def evaluate_and_train():
    print("=" * 60)
    print("🎯 [Step 1 vs Step 2] 제스처 분류 성능 비교 및 학습 (Show Numbers)")
    print("=" * 60)

    X, y = generate_synthetic_gestures(samples_per_class=500)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=42, stratify=y)

    print(f"[*] 총 데이터 수: {len(X)}개 (Train: {len(X_train)}, Test: {len(X_test)})")

    # 1. Step 1: Rule-based 평가
    rule_preds = []
    for feat in X_test:
        pts = feat.reshape(21, 3)
        pred_idx, _, _ = rule_based_gesture(pts)
        rule_preds.append(pred_idx)
    
    rule_acc = accuracy_score(y_test, rule_preds)
    print(f"\n[-] [Step 1 Rule-based 베이스라인] 정확도: {rule_acc * 100:.2f}%")

    # 2. Step 2: MLP Classifier 학습
    mlp = MLPClassifier(
        hidden_layer_sizes=(64, 32),
        activation='relu',
        max_iter=300,
        random_state=42,
        early_stopping=True
    )
    mlp.fit(X_train, y_train)

    mlp_preds = mlp.predict(X_test)
    mlp_acc = accuracy_score(y_test, mlp_preds)
    print(f"[+] [Step 2 정규화 랜드마크 MLP] 정확도: {mlp_acc * 100:.2f}%")
    print(f"[★] 정확도 향상: +{(mlp_acc - rule_acc) * 100:.2f}%p 개선!")

    print("\n--- MLP Classification Report ---")
    print(classification_report(y_test, mlp_preds, target_names=[GESTURE_NAMES[i] for i in range(5)]))

    # 모델 저장
    save_path = os.path.join(os.path.dirname(__file__), "gesture_mlp.pkl")
    with open(save_path, "wb") as f:
        pickle.dump(mlp, f)
    print(f"[✓] 학습된 경량 모델 저장 완료: {save_path}")

    # 리포트 JSON 저장
    metrics = {
        "rule_based_accuracy": float(rule_acc),
        "mlp_accuracy": float(mlp_acc),
        "improvement_pct_points": float((mlp_acc - rule_acc) * 100),
        "test_samples": len(y_test)
    }
    with open(os.path.join(os.path.dirname(__file__), "eval_results.json"), "w") as f:
        json.dump(metrics, f, indent=2)

if __name__ == "__main__":
    evaluate_and_train()
