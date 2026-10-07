import json
import sys
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
CLASSES = [
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "crosswalk",
    "zebra crossing",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
]

model = YOLO(str(ROOT / "yolov8s-worldv2.pt"))
model.set_classes(CLASSES)
print("ready", file=sys.stderr, flush=True)

for line in sys.stdin:
    image_path = line.strip()
    if not image_path:
        continue
    detections = []
    try:
        results = model.predict(image_path, conf=0.15, verbose=False)
        for result in results:
            if result.boxes is None:
                continue
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                class_id = int(box.cls[0])
                detections.append(
                    {
                        "label": CLASSES[class_id] if class_id < len(CLASSES) else f"class_{class_id}",
                        "confidence": round(float(box.conf[0]), 3),
                        "box": [round(x1), round(y1), round(x2 - x1), round(y2 - y1)],
                    }
                )
    except Exception as error:
        print(f"detect failed for {image_path}: {error}", file=sys.stderr, flush=True)
    print(json.dumps(detections), flush=True)
