# Face models (self-hosted, CROPS)

Served from our own origin; no CDN. The same two files and the same preprocessing
(`apps/web/lib/face/`) run on the recipient phone (`/receive`) and the payer laptop (`/pay`).

| File | Model | Source | Licence | sha256 |
|---|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet face detector (bbox + 5 landmarks), input 1x3x640x640 BGR 0-255 | https://huggingface.co/opencv/face_detection_yunet (OpenCV Zoo) | MIT (`LICENSE-yunet-MIT.txt`) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec_int8.onnx` | SFace (MobileFaceNet, SFace loss), int8, input 1x3x112x112 RGB 0-255, output 128-d | https://huggingface.co/opencv/face_recognition_sface (OpenCV Zoo) | Apache-2.0 (`LICENSE-sface-Apache-2.0.txt`) | `2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a` |

Not InsightFace/ArcFace weights (those are non-commercial).

The onnxruntime-web runtime (`public/ort/`) is copied from `node_modules/onnxruntime-web/dist`
by `scripts/copy-ort.mjs` before `dev`/`build` (MIT, not committed).
