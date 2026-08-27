"""iter2 Hand/Fist-based Punch Recognition Engine (Offline Evaluator).

Directly replicates the 3D Hand velocity and depth-based detection engine
from iter2/server/templates/fighter_client.html (lines 300-345)
using MediaPipe Pose wrist and index knuckle landmarks (nodes 15,16,17,18,19,20).

Usage:
  python iter2/eval/evaluate_iter2.py [--landmarks iter4/eval/video/benchmark_landmarks.jsonl]
"""
import argparse
import csv
import json
import math
import sys
from pathlib import Path

# Landmark indices (MediaPipe Pose)
# 15: L_WRIST, 16: R_WRIST
# 17: L_PINKY, 18: R_PINKY
# 19: L_INDEX, 20: R_INDEX
L_WR, R_WR = 15, 16
L_PINKY, R_PINKY = 17, 18
L_INDEX, R_INDEX = 19, 20


class Iter2HandsPunchEngine:
    """Replicates iter2 client-side JS detection logic in Python."""
    def __init__(self, vel_thresh=12.0, cd_ms=350.0):
        self.vel_thresh = vel_thresh
        self.cd_ms = cd_ms
        self.last_punch_t = -1e9
        self.prev_hands = {}
        self.punches = []

    def reset(self):
        self.last_punch_t = -1e9
        self.prev_hands = {}
        self.punches = []

    def process_frame(self, lm, now_ms):
        if not lm or len(lm) <= R_INDEX:
            return None

        # Extract Left & Right hand endpoints
        # In iter2 JS: lm[0] is wrist, lm[8] is index tip.
        # From Pose: lm[15/16] is wrist, lm[19/20] is index knuckle.
        hands_data = [
            ("Left", lm[L_WR], lm[L_INDEX]),
            ("Right", lm[R_WR], lm[R_INDEX]),
        ]

        detected_punches = []

        for hand_label, wrist, idx_tip in hands_data:
            wrist_x, wrist_y, wrist_z = wrist[0], wrist[1], wrist[2]
            idx_x, idx_y, idx_z = idx_tip[0], idx_tip[1], idx_tip[2]

            # depthExt in iter2: wristZ - idxTipZ
            depth_ext = wrist_z - idx_z

            p = self.prev_hands.get(hand_label)
            vel_3d = 0.0
            depth_vel = 0.0

            if p and (now_ms - p["t"]) > 20:
                dt = (now_ms - p["t"]) / 1000.0
                dist_xy = math.hypot(idx_x - p["x"], idx_y - p["y"])

                # dz in iter2: (p.wz - wristZ) * 50
                dz = (p["wz"] - wrist_z) * 50.0
                vel_3d = (math.sqrt(dist_xy * dist_xy + dz * dz) * 1.5 / dt) * 3.6
                depth_vel = (abs(p["wz"] - wrist_z) / dt) * 100.0

            self.prev_hands[hand_label] = {
                "x": idx_x, "y": idx_y, "z": idx_z,
                "wz": wrist_z, "de": depth_ext, "t": now_ms, "dv": depth_vel
            }

            # iter2 classification rule (lines 332-341)
            if vel_3d > self.vel_thresh and (now_ms - self.last_punch_t) > self.cd_ms:
                abs_depth_ext = abs(depth_ext)
                if depth_vel > 3.0 and abs_depth_ext > 0.03:
                    punch_type = "LEFT_HOOK" if hand_label == "Left" else "RIGHT_CROSS"
                elif depth_vel > 1.5:
                    punch_type = "LEFT_JAB" if hand_label == "Left" else "RIGHT_UPPERCUT"
                else:
                    punch_type = "LEFT_JAB" if hand_label == "Left" else "RIGHT_CROSS"

                side = "L" if hand_label == "Left" else "R"
                kind = "STRAIGHT"
                if "HOOK" in punch_type:
                    kind = "HOOK"
                elif "UPPERCUT" in punch_type:
                    kind = "UPPERCUT"

                self.last_punch_t = now_ms
                event = {
                    "t_ms": int(now_ms),
                    "side": side,
                    "action": punch_type,
                    "kind": kind,
                    "speed_kmh": round(vel_3d, 2),
                    "elbow_deg": 0.0,
                    "conf_margin": 0.0,
                }
                self.punches.append(event)
                detected_punches.append(event)

        return detected_punches


def main():
    ap = argparse.ArgumentParser(description="Evaluate iter2 hand tracking punch recognition")
    ap.add_argument("--landmarks", default="iter4/eval/video/benchmark_landmarks.jsonl")
    ap.add_argument("--labels", default="iter4/eval/video/benchmark_labels.json")
    ap.add_argument("--out-dir", default="iter4/eval/runs/v0_iter2_hands")
    args = ap.parse_args()

    project_root = Path(__file__).resolve().parent.parent.parent
    lm_path = project_root / args.landmarks if not Path(args.landmarks).is_absolute() else Path(args.landmarks)
    labels_path = project_root / args.labels if not Path(args.labels).is_absolute() else Path(args.labels)
    out_dir = project_root / args.out_dir if not Path(args.out_dir).is_absolute() else Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not lm_path.exists():
        print(f"❌ 랜드마크 파일을 찾을 수 없습니다: {lm_path}")
        sys.exit(1)

    print("=" * 65)
    print("🥊 iter2 손/주먹 3D 속도 기반 펀치 판정 엔진 평가")
    print("=" * 65)

    engine = Iter2HandsPunchEngine()
    with open(lm_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            data = json.loads(line)
            engine.process_frame(data.get("lm"), data.get("t_ms", 0))

    punches = engine.punches
    print(f"• 총 검출된 펀치: {len(punches)}발")

    # CSV 저장
    csv_path = out_dir / "punches.csv"
    cols = ["t_ms", "side", "action", "kind", "speed_kmh", "elbow_deg", "conf_margin"]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for p in punches:
            w.writerow(p)

    # 채점 (scoring)
    sys.path.insert(0, str(project_root / "iter4" / "eval"))
    from scoring import load_labels_file, score_predictions

    labels = load_labels_file(labels_path)
    metrics = score_predictions(punches, labels)
    metrics["version"] = "v0_iter2_hands"
    metrics["source_video"] = str(lm_path)

    # 풋워크/휴식 구간 분석
    from run_pipeline import calculate_phase_metrics, generate_markdown_report
    phase_metrics = calculate_phase_metrics(punches, duration_sec=90)
    metrics["phase_analysis"] = phase_metrics

    metrics_json_path = out_dir / "metrics.json"
    metrics_json_path.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")

    report_md_path = out_dir / "summary_report.md"
    generate_markdown_report(metrics, phase_metrics, punches, report_md_path)

    # report.json 도 대시보드 호환을 위해 생성
    report_json_path = out_dir / "report.json"
    summary_data = {
        "video_duration_s": 88.43,
        "pose_coverage_pct": 100.0,
        "pose_fps_mean": 30.0,
        "total_punches": len(punches),
        "by_side": {"L": sum(1 for p in punches if p["side"] == "L"), "R": sum(1 for p in punches if p["side"] == "R")},
        "scoring": metrics
    }
    report_json_path.write_text(json.dumps({"summary": summary_data, "punches": punches}, indent=2, ensure_ascii=False), encoding="utf-8")

    print("=" * 65)
    print(f"📊 채점 결과 (정답 {metrics['ground_truth']}발 / 예측 {metrics['predicted']}발):")
    print(f"  • TP: {metrics['tp']}  FP: {metrics['fp']}  FN: {metrics['fn']}")
    print(f"  • 정밀도(P): {metrics['precision']}  재현율(R): {metrics['recall']}  F1-Score: {metrics['f1']}")
    print(f"  • 종류 정확도(Kind Acc): {metrics['kind_accuracy']:.1%}  팔 정확도: {metrics['side_accuracy']:.1%}")
    print(f"  • 풋워크/휴식 FP: {phase_metrics['non_action_fp_total']}회")
    print("=" * 65)
    print(f"💾 아카이브 완료: {out_dir}")


if __name__ == "__main__":
    main()
