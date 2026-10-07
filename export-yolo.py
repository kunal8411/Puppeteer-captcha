from ultralytics import YOLO

CLASSES = [
    "crosswalk",
    "zebra crossing",
    "person",
    "car",
    "traffic light",
    "stop sign",
]

model = YOLO("yolov8s-worldv2.pt")
model.set_classes(CLASSES)
model.export(format="onnx", imgsz=640, simplify=False)
