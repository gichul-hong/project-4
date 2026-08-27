"""Load collected chest-up Pose samples as fixed-length training arrays."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np


MOTION_CLASSES = {
    0: "IDLE",
    1: "OTHER",
    2: "LEFT_JAB",
    3: "RIGHT_JAB",
    4: "LEFT_HOOK",
    5: "RIGHT_HOOK",
    6: "LEFT_UPPERCUT",
    7: "RIGHT_UPPERCUT",
    8: "TWO_HAND_GUARD",
    9: "ENERGY_WAVE",
}
LABEL_TO_INDEX = {label: index for index, label in MOTION_CLASSES.items()}
FEATURE_SIZES = {
    "game_7j_v1": 42,
    "chest_up_15j_v1": 90,
    "game_7j_temporal_v2": 70,
    "chest_up_15j_temporal_v2": 150,
    "heuristic_7j_v1": 17,
}
GAME_RAW_LOCAL_INDICES = [0, 3, 4, 5, 6, 7, 8]


def _frame_timestamps(raw_frames: list[dict[str, Any]]) -> np.ndarray:
    timestamps = np.asarray(
        [frame.get("relative_time_ms", frame.get("timestamp_ms", index)) for index, frame in enumerate(raw_frames)],
        dtype=np.float64,
    )
    return timestamps - timestamps[0] if timestamps.size else timestamps


def _accelerations(velocities: np.ndarray, timestamps: np.ndarray) -> np.ndarray:
    acceleration = np.zeros_like(velocities, dtype=np.float32)
    for index in range(1, len(velocities)):
        delta_seconds = max(1.0 / 120.0, min(0.25, (timestamps[index] - timestamps[index - 1]) / 1000.0))
        acceleration[index] = (velocities[index] - velocities[index - 1]) / delta_seconds
    return acceleration


def _temporal_from_v1(
    base: np.ndarray,
    raw_frames: list[dict[str, Any]],
    timestamps: np.ndarray,
    raw_local_indices: list[int],
) -> np.ndarray:
    joint_count = len(raw_local_indices)
    position_size = joint_count * 3
    if (
        base.ndim != 2
        or base.shape[1] != position_size * 2
        or len(raw_frames) != len(base)
        or len(timestamps) != len(base)
    ):
        return np.empty((0, position_size * 3 + joint_count), dtype=np.float32)
    positions = base[:, :position_size]
    velocities = base[:, position_size:]
    acceleration = _accelerations(velocities, timestamps)
    visibility = np.asarray(
        [
            [float(frame["landmarks"][index].get("visibility", 1.0)) for index in raw_local_indices]
            for frame in raw_frames
        ],
        dtype=np.float32,
    )
    return np.concatenate((positions, velocities, acceleration, visibility), axis=1).astype(np.float32)


def _angle_ratio(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    left, right = a - b, c - b
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator <= 1e-8:
        return 0.0
    cosine = float(np.clip(np.dot(left, right) / denominator, -1.0, 1.0))
    return float(np.arccos(cosine) / np.pi)


def _heuristic_from_game_v1(base: np.ndarray) -> np.ndarray:
    if base.ndim != 2 or base.shape[1] != 42:
        return np.empty((0, 17), dtype=np.float32)
    rows: list[list[float]] = []
    for row in base:
        points = row[:21].reshape(7, 3)
        velocity = row[21:].reshape(7, 3)
        distance = lambda a, b: float(np.linalg.norm(a - b))
        rows.append([
            _angle_ratio(points[1], points[3], points[5]),
            _angle_ratio(points[2], points[4], points[6]),
            distance(points[1], points[5]),
            distance(points[2], points[6]),
            *velocity[5].tolist(),
            *velocity[6].tolist(),
            float(np.linalg.norm(velocity[5])),
            float(np.linalg.norm(velocity[6])),
            distance(points[5], points[6]),
            distance(points[5], points[0]),
            distance(points[6], points[0]),
            distance(points[3], points[4]),
            float((points[5, 2] + points[6, 2]) * 0.5),
        ])
    return np.asarray(rows, dtype=np.float32)


def _load_features(
    document: dict[str, Any],
    feature_set: str,
    raw_frames: list[dict[str, Any]],
    timestamps: np.ndarray,
) -> np.ndarray:
    stored = np.asarray(document.get("features", {}).get(feature_set, []), dtype=np.float32)
    if stored.ndim == 2 and stored.shape[1] == FEATURE_SIZES[feature_set]:
        return stored
    features = document.get("features", {})
    if feature_set == "heuristic_7j_v1":
        return _heuristic_from_game_v1(np.asarray(features.get("game_7j_v1", []), dtype=np.float32))
    if feature_set == "game_7j_temporal_v2":
        return _temporal_from_v1(
            np.asarray(features.get("game_7j_v1", []), dtype=np.float32),
            raw_frames,
            timestamps,
            GAME_RAW_LOCAL_INDICES,
        )
    if feature_set == "chest_up_15j_temporal_v2":
        return _temporal_from_v1(
            np.asarray(features.get("chest_up_15j_v1", []), dtype=np.float32),
            raw_frames,
            timestamps,
            list(range(15)),
        )
    return stored


def resample_sequence(
    sequence: np.ndarray,
    timestamps_ms: np.ndarray,
    sequence_length: int = 30,
) -> np.ndarray:
    """Linearly resample a [time, feature] array using real timestamps."""
    if sequence.ndim != 2 or sequence.shape[0] < 2:
        raise ValueError("sequence must contain at least two frames")
    if timestamps_ms.shape != (sequence.shape[0],):
        raise ValueError("timestamps must contain one value per frame")
    elapsed = timestamps_ms - timestamps_ms[0]
    if elapsed[-1] <= 0 or np.any(np.diff(elapsed) <= 0):
        source_time = np.linspace(0.0, 1.0, sequence.shape[0])
    else:
        source_time = elapsed / elapsed[-1]
    target_time = np.linspace(0.0, 1.0, sequence_length)
    output = np.empty((sequence_length, sequence.shape[1]), dtype=np.float32)
    for feature_index in range(sequence.shape[1]):
        output[:, feature_index] = np.interp(
            target_time,
            source_time,
            sequence[:, feature_index],
        )
    return output


def load_collected_dataset(
    data_dir: str | Path | None = None,
    sequence_length: int = 30,
    feature_set: str = "game_7j_v1",
    segment: str = "full",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[dict[str, Any]]]:
    """Return resampled full/action sequences for heuristics or Bi-LSTM.

    ``feature_set='game_7j_v1'`` returns [samples, sequence_length, 42].
    ``feature_set='chest_up_15j_v1'`` returns [samples, sequence_length, 90].
    Participant IDs must be used for group-disjoint evaluation splits.
    """
    if feature_set not in FEATURE_SIZES:
        raise ValueError(f"unknown feature_set: {feature_set}")
    if segment not in {"full", "action"}:
        raise ValueError("segment must be 'full' or 'action'")

    root = Path(data_dir or Path(__file__).resolve().parent / "collected_pose")
    expected_size = FEATURE_SIZES[feature_set]
    sequences: list[np.ndarray] = []
    labels: list[int] = []
    participants: list[str] = []
    sessions: list[str] = []
    metadata: list[dict[str, Any]] = []

    for path in sorted(root.glob("*/*/*/*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        label = document.get("label")
        if label not in LABEL_TO_INDEX:
            continue
        raw_frames = document.get("raw_frames", [])
        timestamps = _frame_timestamps(raw_frames)
        features = _load_features(document, feature_set, raw_frames, timestamps)
        if features.ndim != 2 or features.shape[0] < 2 or features.shape[1] != expected_size:
            continue
        if timestamps.shape[0] != features.shape[0] or not np.isfinite(features).all():
            continue

        if segment == "action":
            annotation = document.get("annotation", {})
            action_start = float(annotation.get("action_prompt_start_ms", timestamps[0]))
            action_end = float(annotation.get("action_prompt_end_ms", timestamps[-1]))
            mask = (timestamps >= action_start) & (timestamps <= action_end)
            if int(mask.sum()) < 2:
                continue
            features = features[mask]
            timestamps = timestamps[mask]

        sequences.append(resample_sequence(features, timestamps, sequence_length))
        labels.append(LABEL_TO_INDEX[label])
        participants.append(str(document.get("participant_id", "unknown")))
        sessions.append(str(document.get("session_id", "unknown")))
        metadata.append(
            {
                "path": str(path),
                "sample_id": document.get("sample_id"),
                "label": label,
                "variant": document.get("variant"),
                "participant_id": document.get("participant_id"),
                "session_id": document.get("session_id"),
                "original_frame_count": int(features.shape[0]),
                "segment": segment,
                "quality": document.get("quality", {}),
            }
        )

    if not sequences:
        return (
            np.empty((0, sequence_length, expected_size), dtype=np.float32),
            np.empty((0,), dtype=np.int64),
            np.empty((0,), dtype=str),
            np.empty((0,), dtype=str),
            [],
        )
    return (
        np.stack(sequences).astype(np.float32),
        np.asarray(labels, dtype=np.int64),
        np.asarray(participants),
        np.asarray(sessions),
        metadata,
    )


def load_tcn_windows(
    data_dir: str | Path | None = None,
    window_size: int = 10,
    stride: int = 1,
    feature_set: str = "game_7j_temporal_v2",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[dict[str, Any]]]:
    """Return right-aligned, past-only windows and per-window causal targets.

    The target is taken from the final frame in each window. Prepare frames are
    IDLE and action frames use the sample label. Legacy post-roll recovery frames
    remain ignored. This prevents future frames from leaking into TCN training.
    """
    if feature_set not in FEATURE_SIZES:
        raise ValueError(f"unknown feature_set: {feature_set}")
    if window_size < 2:
        raise ValueError("window_size must be at least 2")
    if stride < 1:
        raise ValueError("stride must be at least 1")

    root = Path(data_dir or Path(__file__).resolve().parent / "collected_pose")
    expected_size = FEATURE_SIZES[feature_set]
    windows: list[np.ndarray] = []
    labels: list[int] = []
    participants: list[str] = []
    sessions: list[str] = []
    metadata: list[dict[str, Any]] = []

    for path in sorted(root.glob("*/*/*/*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        sample_label = document.get("label")
        if sample_label not in LABEL_TO_INDEX:
            continue
        raw_frames = document.get("raw_frames", [])
        timestamps = _frame_timestamps(raw_frames)
        features = _load_features(document, feature_set, raw_frames, timestamps)
        if (
            features.ndim != 2
            or features.shape[0] < window_size
            or features.shape[1] != expected_size
            or len(raw_frames) != features.shape[0]
            or not np.isfinite(features).all()
        ):
            continue

        annotation = document.get("annotation", {})
        action_start = float(annotation.get("action_prompt_start_ms", 0.0))
        action_end = float(annotation.get("action_prompt_end_ms", timestamps[-1]))
        explicit_targets = [frame.get("causal_target") for frame in raw_frames]
        has_explicit_targets = all(target is not None for target in explicit_targets)

        for end_index in range(window_size - 1, features.shape[0], stride):
            if has_explicit_targets:
                target = str(explicit_targets[end_index])
            elif sample_label == "IDLE":
                target = "IDLE"
            elif timestamps[end_index] < action_start:
                target = "IDLE"
            elif timestamps[end_index] <= action_end:
                target = str(sample_label)
            else:
                target = "IGNORE"
            if target not in LABEL_TO_INDEX:
                continue

            start_index = end_index - window_size + 1
            windows.append(features[start_index:end_index + 1])
            labels.append(LABEL_TO_INDEX[target])
            participant_id = str(document.get("participant_id", "unknown"))
            session_id = str(document.get("session_id", "unknown"))
            participants.append(participant_id)
            sessions.append(session_id)
            metadata.append({
                "path": str(path),
                "sample_id": document.get("sample_id"),
                "sample_label": sample_label,
                "target": target,
                "participant_id": participant_id,
                "session_id": session_id,
                "window_start_frame": start_index,
                "window_end_frame": end_index,
                "window_end_ms": float(timestamps[end_index]),
                "causal": True,
            })

    if not windows:
        return (
            np.empty((0, window_size, expected_size), dtype=np.float32),
            np.empty((0,), dtype=np.int64),
            np.empty((0,), dtype=str),
            np.empty((0,), dtype=str),
            [],
        )
    return (
        np.stack(windows).astype(np.float32),
        np.asarray(labels, dtype=np.int64),
        np.asarray(participants),
        np.asarray(sessions),
        metadata,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect the collected iter3 motion dataset")
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--feature-set", choices=sorted(FEATURE_SIZES), default="game_7j_v1")
    parser.add_argument("--mode", choices=("sequence", "tcn"), default="sequence")
    parser.add_argument("--sequence-length", type=int, default=30)
    parser.add_argument("--segment", choices=("full", "action"), default="full")
    parser.add_argument("--window-size", type=int, default=10)
    parser.add_argument("--stride", type=int, default=1)
    args = parser.parse_args()

    if args.mode == "tcn":
        X, y, people, sessions, _ = load_tcn_windows(
            data_dir=args.data_dir,
            window_size=args.window_size,
            stride=args.stride,
            feature_set=args.feature_set,
        )
    else:
        X, y, people, sessions, _ = load_collected_dataset(
            data_dir=args.data_dir,
            sequence_length=args.sequence_length,
            feature_set=args.feature_set,
            segment=args.segment,
        )
    print(f"feature_set={args.feature_set} samples={len(y)} X={X.shape} y={y.shape}")
    print(f"participants={sorted(set(people))}")
    print(f"sessions={sorted(set(sessions))}")
    for class_index, class_name in MOTION_CLASSES.items():
        print(f"{class_index}: {class_name:<18} {(y == class_index).sum()}")


if __name__ == "__main__":
    main()
