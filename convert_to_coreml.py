"""
Convert the YOLOv8-seg curb/sidewalk model (best.pt) into the model
formats the Pharos app can bundle:

  * Core ML  (PathScout.mlpackage) -- iOS, run via Vision/Core ML.
  * ONNX     (PathScout.onnx)      -- iOS (ONNX Runtime) and Android.

Usage:
    python -m pip install --upgrade ultralytics coremltools onnx  # one-time
    python convert_to_coreml.py /path/to/best.pt                  # both formats
    python convert_to_coreml.py /path/to/best.pt --format coreml  # just Core ML
    python convert_to_coreml.py /path/to/best.pt --format onnx    # just ONNX

Core ML output is written next to this script as PathScout.mlpackage
(the iOS plugin loads a file named exactly PathScout.mlmodelc from the
app bundle, see app/ios/App/App/PathScoutPlugin.swift). Drag the
produced mlpackage into Xcode → App target → "Copy items if needed",
make sure "Target Membership" includes App, and Xcode will compile it
into PathScout.mlmodelc automatically.

ONNX output is written as PathScout.onnx. Drag it into Xcode the same
way (Target Membership: App) for the native ONNX Runtime engine, and
hand the identical file to the Android team -- the model is the only
cross-platform-portable artifact; the post-processing is reimplemented
per platform.

Both exports use nms=False on purpose. The built-in NMS export strips
the mask prototype branch, which we need for sidewalk/curb
segmentation. NMS is cheap enough to do in Swift/Kotlin on the
~hundred-or-so post-threshold detections. Both formats therefore emit
the identical two output tensors: detection [1, 40, 8400] and mask
prototypes [1, 32, 160, 160].
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def _load_model(pt_path: Path):
    try:
        from ultralytics import YOLO
    except ImportError as e:
        raise SystemExit(
            "ultralytics not installed. Run:\n"
            "    python -m pip install --upgrade ultralytics coremltools onnx"
        ) from e

    if not pt_path.exists():
        raise SystemExit(f"Input not found: {pt_path}")

    print(f"Loading {pt_path} ...")
    model = YOLO(str(pt_path))

    print(f"Classes the model knows about: {model.names}")
    expected = {"curb_down", "curb_up", "road", "sidewalk"}
    got = set(model.names.values())
    if got != expected:
        print(
            f"WARNING: class set differs from expected {expected}; got {got}. "
            "The Swift plugin assumes the standard 4-class ordering; you may "
            "need to update classNames in PathScoutPlugin.swift to match."
        )
    return model


def convert_coreml(model, out_dir: Path, imgsz: int = 640) -> Path:
    print(f"Exporting to Core ML at imgsz={imgsz} (this can take ~30s) ...")
    exported_path_str = model.export(
        format="coreml",
        imgsz=imgsz,
        nms=False,
        half=False,
        int8=False,
    )
    exported = Path(exported_path_str)
    print(f"Exporter wrote: {exported}")

    # Rename to a fixed name the plugin always looks for. mlpackages are
    # directories on disk, so use shutil for the rename/copy.
    target = out_dir / "PathScout.mlpackage"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(exported, target)
    print(f"Wrote: {target}")
    return target


def convert_onnx(model, out_dir: Path, imgsz: int = 640) -> Path:
    # opset 12 + simplify=False keeps the graph friendly to both
    # onnxruntime-objc (iOS) and onnxruntime-android. nms=False so the
    # mask-prototype branch survives, exactly like the Core ML export.
    print(f"Exporting to ONNX at imgsz={imgsz} (this can take ~30s) ...")
    exported_path_str = model.export(
        format="onnx",
        imgsz=imgsz,
        nms=False,
        half=False,
        opset=12,
        simplify=False,
        dynamic=False,
    )
    exported = Path(exported_path_str)
    print(f"Exporter wrote: {exported}")

    # ONNX is a single file; copy to the fixed name the app bundles.
    target = out_dir / "PathScout.onnx"
    if target.exists():
        target.unlink()
    shutil.copy2(exported, target)
    print(f"Wrote: {target}")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pt", type=Path, help="Path to best.pt (Ultralytics)")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Directory to write the model(s) into (default: repo root)",
    )
    parser.add_argument(
        "--format",
        choices=["coreml", "onnx", "both"],
        default="both",
        help="Which format(s) to export (default: both)",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
        help="Square model input size (default 640)",
    )
    args = parser.parse_args()

    model = _load_model(args.pt)
    outputs: list[Path] = []
    if args.format in ("coreml", "both"):
        outputs.append(convert_coreml(model, args.out, imgsz=args.imgsz))
    if args.format in ("onnx", "both"):
        outputs.append(convert_onnx(model, args.out, imgsz=args.imgsz))

    print()
    print("Next steps:")
    print(f"  1. open {args.out}")
    for out in outputs:
        print(f"  2. Drag {out.name} into Xcode (App target)")
    print(f"  3. Make sure 'Target Membership: App' is checked for each")
    print(f"  4. Build & Run on a real device (camera inference needs hardware)")
    print(f"  5. Hand PathScout.onnx to the Android team for their port")


if __name__ == "__main__":
    sys.exit(main())
