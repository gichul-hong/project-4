"""Guided chest-up boxing motion dataset collector.

Run from the repository root:
    python iter3/motion_learning/collector_app.py

Open in Chrome or Edge:
    http://localhost:8010
"""

from __future__ import annotations

import json
import math
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "collector_templates"
DEFAULT_DATA_DIR = BASE_DIR / "collected_pose"
MANIFEST_LOCK = threading.Lock()

# MediaPipe Pose indices retained in every saved frame.  Hips and lower-body
# points are intentionally excluded because collection is framed chest-up.
CHEST_UP_POSE_INDICES = [
    0,
    7,
    8,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
]
CHEST_UP_JOINT_ORDER = [
    "nose",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_pinky",
    "right_pinky",
    "left_index",
    "right_index",
    "left_thumb",
    "right_thumb",
]

# Subset used by the current iter3 JavaScript heuristic.
GAME_POSE_INDICES = [0, 11, 12, 13, 14, 15, 16]
GAME_JOINT_ORDER = [
    "nose",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
]
GAME_LOCAL_INDICES = [CHEST_UP_POSE_INDICES.index(index) for index in GAME_POSE_INDICES]
LEFT_SHOULDER_LOCAL_INDEX = CHEST_UP_POSE_INDICES.index(11)
RIGHT_SHOULDER_LOCAL_INDEX = CHEST_UP_POSE_INDICES.index(12)
HEURISTIC_SIGNAL_NAMES = [
    "left_elbow_angle_ratio",
    "right_elbow_angle_ratio",
    "left_reach",
    "right_reach",
    "left_wrist_vx",
    "left_wrist_vy",
    "left_wrist_vz",
    "right_wrist_vx",
    "right_wrist_vy",
    "right_wrist_vz",
    "left_wrist_speed",
    "right_wrist_speed",
    "hands_distance",
    "left_wrist_to_nose",
    "right_wrist_to_nose",
    "elbow_distance",
    "average_wrist_z",
]

QUALITY_THRESHOLDS = {
    "visibility": 0.35,
    "critical_valid_ratio": 0.85,
    "upper_body_valid_ratio": 0.75,
    "minimum_inference_fps": 8.0,
    "maximum_frame_gap_ms": 350.0,
    "minimum_frames": 12,
}
MAX_VIDEO_BYTES = 50 * 1024 * 1024

ACTION_CONFIG: dict[str, dict[str, Any]] = {
    "IDLE": {
        "label_ko": "대기 자세",
        "instruction": "복싱 기본자세에서 공격하지 말고 자연스럽게 호흡하고 작게 움직이세요.",
        "action_duration_ms": 1800,
        "variants": ["기본자세", "작은 좌우 흔들림", "가벼운 고개 움직임", "손 위치 조정"],
    },
    "OTHER": {
        "label_ko": "기타 동작",
        "instruction": "안내된 비공격 동작을 자연스럽게 수행한 뒤 기본자세로 돌아오세요.",
        "action_duration_ms": 1800,
        "variants": ["얼굴 만지기", "머리 정리", "옷소매 정리", "손 흔들기", "팔 스트레칭", "불완전한 펀치"],
    },
    "LEFT_JAB": {
        "label_ko": "왼손 잽",
        "instruction": "왼손을 정면으로 곧게 뻗고 즉시 기본자세로 회수하세요.",
        "action_duration_ms": 1300,
        "variants": ["보통 속도", "느린 속도", "빠른 속도", "작은 동작", "큰 동작"],
    },
    "RIGHT_JAB": {
        "label_ko": "오른손 잽",
        "instruction": "오른손을 정면으로 곧게 뻗고 즉시 기본자세로 회수하세요.",
        "action_duration_ms": 1300,
        "variants": ["보통 속도", "느린 속도", "빠른 속도", "작은 동작", "큰 동작"],
    },
    "LEFT_HOOK": {
        "label_ko": "왼손 훅",
        "instruction": "왼팔을 굽힌 채 주먹을 수평 원호로 휘두르고 기본자세로 회수하세요.",
        "action_duration_ms": 1500,
        "variants": ["보통 속도", "느린 속도", "빠른 속도", "작은 원호", "큰 원호"],
    },
    "RIGHT_HOOK": {
        "label_ko": "오른손 훅",
        "instruction": "오른팔을 굽힌 채 주먹을 수평 원호로 휘두르고 기본자세로 회수하세요.",
        "action_duration_ms": 1500,
        "variants": ["보통 속도", "느린 속도", "빠른 속도", "작은 원호", "큰 원호"],
    },
    "LEFT_UPPERCUT": {
        "label_ko": "왼손 어퍼컷",
        "instruction": "왼팔을 굽힌 채 주먹을 아래에서 위로 올리고 기본자세로 회수하세요.",
        "action_duration_ms": 1500,
        "variants": ["보통 속도", "느린 속도", "빠른 속도", "작은 동작", "큰 동작"],
    },
    "RIGHT_UPPERCUT": {
        "label_ko": "오른손 어퍼컷",
        "instruction": "오른팔을 굽힌 채 주먹을 아래에서 위로 올리고 기본자세로 회수하세요.",
        "action_duration_ms": 1500,
        "variants": ["보통 속도", "느린 속도", "빠른 속도", "작은 동작", "큰 동작"],
    },
    "TWO_HAND_GUARD": {
        "label_ko": "양손 가드",
        "instruction": "양손을 얼굴 가까이에 올려 방어 자세를 유지한 뒤 기본자세로 돌아오세요.",
        "action_duration_ms": 1800,
        "variants": ["정면 가드", "얼굴 가까이", "얼굴에서 약간 멀리", "작은 상체 움직임"],
    },
    "ENERGY_WAVE": {
        "label_ko": "장풍",
        "instruction": "양팔을 굽혀 양손을 가슴 앞에 모아 잠시 충전한 뒤, 두 손을 카메라 방향으로 함께 빠르게 밀어내고 기본자세로 돌아오세요.",
        "action_duration_ms": 2000,
        "variants": ["보통 속도", "느린 충전", "빠른 방출", "작은 밀어내기", "큰 밀어내기"],
    },
}


class Landmark(BaseModel):
    x: float
    y: float
    z: float
    visibility: float = 1.0


class PoseFrame(BaseModel):
    timestamp_ms: float
    landmarks: list[Landmark]


class CaptureMetadata(BaseModel):
    width: int = Field(ge=1, le=8192)
    height: int = Field(ge=1, le=8192)
    mirrored_preview: bool = True
    model_complexity: int = Field(default=0, ge=0, le=2)
    smooth_landmarks: bool = True
    min_detection_confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    min_tracking_confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    video_enabled: bool = True
    video_mime_type: str = Field(default="video/webm", min_length=1, max_length=128)


class PhaseMarkers(BaseModel):
    action_prompt_start_ms: float = Field(ge=0.0)
    action_prompt_end_ms: float = Field(ge=0.0)


class SampleUpload(BaseModel):
    participant_id: str = Field(min_length=1, max_length=32)
    session_id: str = Field(min_length=1, max_length=32)
    label: str
    variant: str = Field(default="기본", min_length=1, max_length=64)
    repetition: int = Field(ge=1, le=10000)
    target_duration_ms: int = Field(ge=500, le=10000)
    staged_video_id: str = Field(min_length=32, max_length=32)
    capture: CaptureMetadata
    phase_markers: PhaseMarkers
    frames: list[PoseFrame]


def _safe_identifier(value: str, field_name: str) -> str:
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", value):
        raise HTTPException(
            status_code=422,
            detail=f"{field_name}에는 영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.",
        )
    return value


def _validate_sample(sample: SampleUpload) -> None:
    if sample.label not in ACTION_CONFIG:
        raise HTTPException(status_code=422, detail="지원하지 않는 동작 라벨입니다.")
    if not QUALITY_THRESHOLDS["minimum_frames"] <= len(sample.frames) <= 240:
        raise HTTPException(status_code=422, detail="프레임 수가 허용 범위를 벗어났습니다.")
    if sample.phase_markers.action_prompt_end_ms < sample.phase_markers.action_prompt_start_ms:
        raise HTTPException(status_code=422, detail="동작 구간의 종료 시간이 시작 시간보다 빠릅니다.")
    if not re.fullmatch(r"[a-f0-9]{32}", sample.staged_video_id):
        raise HTTPException(status_code=422, detail="유효하지 않은 staged_video_id입니다.")
    if not sample.capture.video_enabled:
        raise HTTPException(status_code=422, detail="영상 저장은 필수입니다.")
    for frame in sample.frames:
        if len(frame.landmarks) != len(CHEST_UP_JOINT_ORDER):
            raise HTTPException(status_code=422, detail="각 프레임에는 정확히 15개 상체 관절이 필요합니다.")
        for point in frame.landmarks:
            values = (point.x, point.y, point.z, point.visibility)
            if not all(math.isfinite(value) for value in values):
                raise HTTPException(status_code=422, detail="관절 좌표에 유효하지 않은 값이 있습니다.")


def _assess_quality(frames: list[PoseFrame]) -> dict[str, Any]:
    visibility_threshold = QUALITY_THRESHOLDS["visibility"]
    critical_valid = 0
    upper_valid = 0
    for frame in frames:
        if all(frame.landmarks[index].visibility >= visibility_threshold for index in GAME_LOCAL_INDICES):
            critical_valid += 1
        upper_valid += sum(point.visibility >= visibility_threshold for point in frame.landmarks)

    frame_count = len(frames)
    duration_ms = max(0.0, frames[-1].timestamp_ms - frames[0].timestamp_ms)
    inference_fps = (frame_count - 1) * 1000.0 / duration_ms if duration_ms > 0 and frame_count > 1 else 0.0
    frame_gaps = [
        frames[index].timestamp_ms - frames[index - 1].timestamp_ms
        for index in range(1, frame_count)
    ]
    maximum_gap_ms = max(frame_gaps, default=0.0)
    critical_ratio = critical_valid / frame_count
    upper_ratio = upper_valid / (frame_count * len(CHEST_UP_JOINT_ORDER))

    checks = {
        "minimum_frames": frame_count >= QUALITY_THRESHOLDS["minimum_frames"],
        "critical_valid_ratio": critical_ratio >= QUALITY_THRESHOLDS["critical_valid_ratio"],
        "upper_body_valid_ratio": upper_ratio >= QUALITY_THRESHOLDS["upper_body_valid_ratio"],
        "minimum_inference_fps": inference_fps >= QUALITY_THRESHOLDS["minimum_inference_fps"],
        "maximum_frame_gap_ms": maximum_gap_ms <= QUALITY_THRESHOLDS["maximum_frame_gap_ms"],
    }
    return {
        "status": "accepted" if all(checks.values()) else "rejected",
        "checks": checks,
        "critical_valid_ratio": round(critical_ratio, 4),
        "upper_body_valid_ratio": round(upper_ratio, 4),
        "inference_fps": round(inference_fps, 2),
        "maximum_frame_gap_ms": round(maximum_gap_ms, 2),
    }


def _derive_feature_components(
    frames: list[PoseFrame],
    local_indices: list[int],
) -> tuple[list[list[float]], list[list[float]], list[list[float]], list[list[float]]]:
    """Return normalized position, velocity, acceleration, and visibility."""
    normalized_positions: list[list[float]] = []
    visibility_rows: list[list[float]] = []
    previous_valid: list[tuple[float, float, float] | None] = [None] * len(CHEST_UP_JOINT_ORDER)
    visibility_threshold = QUALITY_THRESHOLDS["visibility"]

    for frame in frames:
        points: list[tuple[float, float, float]] = []
        for index, landmark in enumerate(frame.landmarks):
            current = (landmark.x, landmark.y, landmark.z)
            if landmark.visibility < visibility_threshold and previous_valid[index] is not None:
                current = previous_valid[index]
            else:
                previous_valid[index] = current
            points.append(current)

        left_shoulder = points[LEFT_SHOULDER_LOCAL_INDEX]
        right_shoulder = points[RIGHT_SHOULDER_LOCAL_INDEX]
        center = tuple((left_shoulder[axis] + right_shoulder[axis]) * 0.5 for axis in range(3))
        shoulder_width = math.hypot(
            left_shoulder[0] - right_shoulder[0],
            left_shoulder[1] - right_shoulder[1],
        )
        scale = max(shoulder_width, 1e-4)

        positions: list[float] = []
        for index in local_indices:
            point = points[index]
            positions.extend((point[axis] - center[axis]) / scale for axis in range(3))
        normalized_positions.append(positions)
        visibility_rows.append([frame.landmarks[index].visibility for index in local_indices])

    velocities: list[list[float]] = []
    for index, positions in enumerate(normalized_positions):
        if index == 0:
            velocity = [0.0] * len(positions)
        else:
            delta_seconds = max(
                1.0 / 120.0,
                min(0.25, (frames[index].timestamp_ms - frames[index - 1].timestamp_ms) / 1000.0),
            )
            velocity = [
                (positions[column] - normalized_positions[index - 1][column]) / delta_seconds
                for column in range(len(positions))
            ]
        velocities.append(velocity)

    accelerations: list[list[float]] = []
    for index, velocity in enumerate(velocities):
        if index == 0:
            acceleration = [0.0] * len(velocity)
        else:
            delta_seconds = max(
                1.0 / 120.0,
                min(0.25, (frames[index].timestamp_ms - frames[index - 1].timestamp_ms) / 1000.0),
            )
            acceleration = [
                (velocity[column] - velocities[index - 1][column]) / delta_seconds
                for column in range(len(velocity))
            ]
        accelerations.append(acceleration)
    return normalized_positions, velocities, accelerations, visibility_rows


def _derive_features(frames: list[PoseFrame], local_indices: list[int]) -> list[list[float]]:
    """Return shoulder-normalized xyz and time-normalized velocity features."""
    positions, velocities, _, _ = _derive_feature_components(frames, local_indices)
    return [position + velocity for position, velocity in zip(positions, velocities)]


def _derive_temporal_features(frames: list[PoseFrame], local_indices: list[int]) -> list[list[float]]:
    """Return position, velocity, acceleration, and visibility for sequence models."""
    positions, velocities, accelerations, visibility = _derive_feature_components(frames, local_indices)
    return [
        position + velocity + acceleration + visible
        for position, velocity, acceleration, visible in zip(
            positions, velocities, accelerations, visibility
        )
    ]


def _vector_angle(a: list[float], b: list[float], c: list[float]) -> float:
    left = [a[axis] - b[axis] for axis in range(3)]
    right = [c[axis] - b[axis] for axis in range(3)]
    denominator = math.sqrt(sum(value * value for value in left)) * math.sqrt(
        sum(value * value for value in right)
    )
    if denominator <= 1e-8:
        return 0.0
    cosine = max(-1.0, min(1.0, sum(x * y for x, y in zip(left, right)) / denominator))
    return math.acos(cosine) / math.pi


def _derive_heuristic_signals(frames: list[PoseFrame]) -> list[list[float]]:
    """Return interpretable signals matching the current seven-joint game heuristic."""
    positions, velocities, _, _ = _derive_feature_components(frames, GAME_LOCAL_INDICES)
    rows: list[list[float]] = []
    for position, velocity in zip(positions, velocities):
        points = [position[index:index + 3] for index in range(0, len(position), 3)]
        speeds = [math.sqrt(sum(value * value for value in velocity[index:index + 3])) for index in (15, 18)]
        distance = lambda a, b: math.sqrt(sum((a[axis] - b[axis]) ** 2 for axis in range(3)))
        rows.append([
            _vector_angle(points[1], points[3], points[5]),
            _vector_angle(points[2], points[4], points[6]),
            distance(points[1], points[5]),
            distance(points[2], points[6]),
            *velocity[15:18],
            *velocity[18:21],
            *speeds,
            distance(points[5], points[6]),
            distance(points[5], points[0]),
            distance(points[6], points[0]),
            distance(points[3], points[4]),
            (points[5][2] + points[6][2]) * 0.5,
        ])
    return rows


def create_app(data_dir: Path | None = None) -> FastAPI:
    output_dir = Path(data_dir or DEFAULT_DATA_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)
    staging_dir = output_dir / ".video_staging"
    staging_dir.mkdir(parents=True, exist_ok=True)
    templates = Jinja2Templates(directory=str(TEMPLATE_DIR))
    collector = FastAPI(title="Iter3 Chest-up Boxing Dataset Collector")

    @collector.get("/", response_class=HTMLResponse)
    async def collector_page(request: Request):
        return templates.TemplateResponse(
            request=request,
            name="motion_collector.html",
            context={
                "actions": ACTION_CONFIG,
                "pose_indices": CHEST_UP_POSE_INDICES,
                "game_pose_indices": GAME_POSE_INDICES,
                "quality_thresholds": QUALITY_THRESHOLDS,
            },
        )

    @collector.get("/api/config")
    async def config():
        return {
            "schema_version": 4,
            "video_required": True,
            "video_format": "webm",
            "maximum_video_bytes": MAX_VIDEO_BYTES,
            "actions": ACTION_CONFIG,
            "chest_up_joint_order": CHEST_UP_JOINT_ORDER,
            "chest_up_pose_indices": CHEST_UP_POSE_INDICES,
            "game_joint_order": GAME_JOINT_ORDER,
            "game_pose_indices": GAME_POSE_INDICES,
            "quality_thresholds": QUALITY_THRESHOLDS,
            "feature_sets": {
                "game_7j_v1": 42,
                "chest_up_15j_v1": 90,
                "game_7j_temporal_v2": 70,
                "chest_up_15j_temporal_v2": 150,
                "heuristic_7j_v1": len(HEURISTIC_SIGNAL_NAMES),
            },
        }

    @collector.get("/api/stats")
    async def stats(
        participant_id: str | None = Query(default=None),
        session_id: str | None = Query(default=None),
    ):
        counts = {label: 0 for label in ACTION_CONFIG}
        root = output_dir
        if participant_id:
            root /= _safe_identifier(participant_id, "participant_id")
        if session_id:
            if not participant_id:
                raise HTTPException(status_code=422, detail="session_id 조회에는 participant_id가 필요합니다.")
            root /= _safe_identifier(session_id, "session_id")
        for label in counts:
            counts[label] = sum(1 for _ in root.glob(f"**/{label}/*.json")) if root.exists() else 0
        return {
            "counts": counts,
            "total": sum(counts.values()),
            "participant_id": participant_id,
            "session_id": session_id,
            "data_dir": str(output_dir),
        }

    @collector.put("/api/video-staging/{upload_id}")
    async def stage_video(upload_id: str, request: Request):
        if not re.fullmatch(r"[a-f0-9]{32}", upload_id):
            raise HTTPException(status_code=422, detail="유효하지 않은 영상 업로드 ID입니다.")
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "video/webm":
            raise HTTPException(status_code=415, detail="WebM 영상만 저장할 수 있습니다.")
        video_bytes = await request.body()
        if not video_bytes:
            raise HTTPException(status_code=422, detail="영상 데이터가 비어 있습니다.")
        if len(video_bytes) > MAX_VIDEO_BYTES:
            raise HTTPException(status_code=413, detail="영상 파일이 50MB 제한을 초과했습니다.")
        if not video_bytes.startswith(b"\x1aE\xdf\xa3"):
            raise HTTPException(status_code=422, detail="유효한 WebM 영상 헤더가 없습니다.")

        staged_path = staging_dir / f"{upload_id}.webm"
        temporary_path = staged_path.with_suffix(".tmp")
        temporary_path.write_bytes(video_bytes)
        temporary_path.replace(staged_path)
        return {
            "status": "staged",
            "upload_id": upload_id,
            "video_bytes": len(video_bytes),
        }

    @collector.post("/api/samples")
    async def save_sample(sample: SampleUpload):
        participant_id = _safe_identifier(sample.participant_id, "participant_id")
        session_id = _safe_identifier(sample.session_id, "session_id")
        _validate_sample(sample)
        quality = _assess_quality(sample.frames)
        if quality["status"] != "accepted":
            raise HTTPException(
                status_code=422,
                detail={"message": "품질검사를 통과하지 못했습니다. 다시 촬영하세요.", "quality": quality},
            )

        staged_video_path = staging_dir / f"{sample.staged_video_id}.webm"
        if not staged_video_path.is_file():
            raise HTTPException(status_code=422, detail="먼저 촬영 영상을 업로드해야 합니다.")
        video_bytes = staged_video_path.stat().st_size
        if video_bytes <= 0 or video_bytes > MAX_VIDEO_BYTES:
            raise HTTPException(status_code=422, detail="임시 영상 파일의 크기가 유효하지 않습니다.")

        label_dir = output_dir / participant_id / session_id / sample.label
        label_dir.mkdir(parents=True, exist_ok=True)
        created_at = datetime.now(timezone.utc)
        sample_id = f"{created_at.strftime('%Y%m%dT%H%M%S%fZ')}_{uuid.uuid4().hex[:8]}"
        output_path = label_dir / f"{sample_id}.json"
        video_path = label_dir / f"{sample_id}.webm"

        game_features = _derive_features(sample.frames, GAME_LOCAL_INDICES)
        chest_features = _derive_features(sample.frames, list(range(len(CHEST_UP_JOINT_ORDER))))
        game_temporal_features = _derive_temporal_features(sample.frames, GAME_LOCAL_INDICES)
        chest_temporal_features = _derive_temporal_features(
            sample.frames, list(range(len(CHEST_UP_JOINT_ORDER)))
        )
        heuristic_signals = _derive_heuristic_signals(sample.frames)
        first_timestamp = sample.frames[0].timestamp_ms
        action_start = sample.phase_markers.action_prompt_start_ms - first_timestamp
        action_end = sample.phase_markers.action_prompt_end_ms - first_timestamp
        raw_frames = []
        phase_counts = {"prepare": 0, "action": 0}
        for frame in sample.frames:
            relative_time = frame.timestamp_ms - first_timestamp
            phase = "prepare" if relative_time < action_start else "action"
            if sample.label == "IDLE":
                causal_target = "IDLE"
            elif phase == "prepare":
                causal_target = "IDLE"
            else:
                causal_target = sample.label
            dumped = frame.model_dump()
            dumped.update({
                "relative_time_ms": round(max(0.0, relative_time), 2),
                "phase": phase,
                "causal_target": causal_target,
            })
            raw_frames.append(dumped)
            phase_counts[phase] += 1

        document = {
            "schema_version": 4,
            "sample_id": sample_id,
            "participant_id": participant_id,
            "session_id": session_id,
            "label": sample.label,
            "label_ko": ACTION_CONFIG[sample.label]["label_ko"],
            "variant": sample.variant,
            "repetition": sample.repetition,
            "created_at": created_at.isoformat(),
            "source": "mediapipe_pose_web_chest_up",
            "capture": sample.capture.model_dump(),
            "video": {
                "path": str(video_path.relative_to(output_dir)).replace("\\", "/"),
                "mime_type": "video/webm",
                "bytes": video_bytes,
                "includes": "prepare + action",
            },
            "annotation": {
                "action_prompt_start_ms": round(max(0.0, action_start), 2),
                "action_prompt_end_ms": round(max(0.0, action_end), 2),
                "alignment": "prompt_aligned",
                "phase_counts": phase_counts,
                "causal_target_policy": {
                    "prepare": "IDLE",
                    "action": "sample_label",
                    "idle_sample": "IDLE_for_all_phases",
                },
            },
            "joint_sets": {
                "raw": {
                    "joint_order": CHEST_UP_JOINT_ORDER,
                    "pose_indices": CHEST_UP_POSE_INDICES,
                    "layout": "x, y, z, visibility",
                },
                "game_7j_v1": {
                    "joint_order": GAME_JOINT_ORDER,
                    "pose_indices": GAME_POSE_INDICES,
                    "feature_size": 42,
                    "layout": "shoulder-normalized xyz + xyz velocity per second",
                },
                "chest_up_15j_v1": {
                    "joint_order": CHEST_UP_JOINT_ORDER,
                    "pose_indices": CHEST_UP_POSE_INDICES,
                    "feature_size": 90,
                    "layout": "shoulder-normalized xyz + xyz velocity per second",
                },
                "game_7j_temporal_v2": {
                    "joint_order": GAME_JOINT_ORDER,
                    "pose_indices": GAME_POSE_INDICES,
                    "feature_size": 70,
                    "layout": "shoulder-normalized xyz + xyz velocity + xyz acceleration + visibility",
                },
                "chest_up_15j_temporal_v2": {
                    "joint_order": CHEST_UP_JOINT_ORDER,
                    "pose_indices": CHEST_UP_POSE_INDICES,
                    "feature_size": 150,
                    "layout": "shoulder-normalized xyz + xyz velocity + xyz acceleration + visibility",
                },
                "heuristic_7j_v1": {
                    "feature_size": len(HEURISTIC_SIGNAL_NAMES),
                    "feature_names": HEURISTIC_SIGNAL_NAMES,
                    "layout": "interpretable normalized angles, distances, and wrist velocities",
                },
            },
            "training_views": {
                "heuristic": {
                    "feature_set": "heuristic_7j_v1",
                    "target": "label",
                    "uses_timestamps": True,
                },
                "bilstm": {
                    "recommended_feature_set": "chest_up_15j_temporal_v2",
                    "target": "label",
                    "sequence_scope": "full_or_action_segment",
                },
                "tcn": {
                    "recommended_feature_set": "game_7j_temporal_v2",
                    "target_source": "raw_frames[].causal_target",
                    "window_alignment": "right_aligned_past_only",
                },
            },
            "frame_count": len(sample.frames),
            "duration_ms": round(sample.frames[-1].timestamp_ms - first_timestamp, 2),
            "target_duration_ms": sample.target_duration_ms,
            "quality": quality,
            "raw_frames": raw_frames,
            "features": {
                "game_7j_v1": game_features,
                "chest_up_15j_v1": chest_features,
                "game_7j_temporal_v2": game_temporal_features,
                "chest_up_15j_temporal_v2": chest_temporal_features,
                "heuristic_7j_v1": heuristic_signals,
            },
        }

        temporary_path = output_path.with_suffix(".tmp")
        temporary_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        staged_video_path.replace(video_path)
        temporary_path.replace(output_path)

        manifest_entry = {
            key: document[key]
            for key in (
                "schema_version",
                "sample_id",
                "participant_id",
                "session_id",
                "label",
                "variant",
                "repetition",
                "created_at",
                "frame_count",
                "duration_ms",
                "quality",
            )
        }
        manifest_entry["path"] = str(output_path.relative_to(output_dir)).replace("\\", "/")
        manifest_entry["video_path"] = document["video"]["path"]
        manifest_entry["video_bytes"] = video_bytes
        with MANIFEST_LOCK:
            with (output_dir / "manifest.jsonl").open("a", encoding="utf-8") as manifest:
                manifest.write(json.dumps(manifest_entry, ensure_ascii=False) + "\n")

        return {
            "status": "saved",
            "sample_id": sample_id,
            "path": manifest_entry["path"],
            "video_path": manifest_entry["video_path"],
            "video_bytes": video_bytes,
            "frame_count": len(sample.frames),
            "duration_ms": document["duration_ms"],
            "quality": quality,
        }

    return collector


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8010)
