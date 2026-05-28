//
// PathScout.swift
//
// Capacitor plugin that owns the rear camera and the Core ML curb /
// sidewalk segmentation model. When the JS side calls `scan()` we grab
// the most recent camera frame, run inference, and return a single
// guidance dict the JS side hands to `announce()`.
//
// Why a custom plugin (instead of e.g. @capacitor-community/camera-preview):
//   - Need raw CVPixelBuffer access for Vision/Core ML.
//   - Need to do the YOLOv8/v11-seg mask decode + open-path grid
//     analysis on-device (it's all in this file, ported from
//     `open_path.py` in the repo root). Returning the raw 8400-anchor
//     detection tensor to JS would be much slower.
//   - The capture session is intentionally headless: blind users get
//     audio cues, not a viewfinder.
//
// Model spec (see convert_to_coreml.py):
//   input  "image"     : CVPixelBuffer 640x640 BGR (Core ML colorSpace=20)
//   output "var_1324"  : Float32 [1, 40, 8400]    -- detection tensor
//                        (4 bbox + 4 class + 32 mask coef per anchor)
//   output "var_1362"  : Float32 [1, 32, 160, 160] -- mask prototypes
//
// The output names are positional ("first 3D tensor with 40 channels,
// first 4D tensor with 32 channels"); we don't hardcode the auto-
// generated `var_NNNN` names because they change every export.
//

import AVFoundation
import Accelerate
import Capacitor
import CoreML
import CoreVideo
import Foundation
import UIKit
import Vision

// MARK: - Capacitor plugin shell

@objc(PathScoutPlugin)
public class PathScoutPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PathScoutPlugin"
    public let jsName = "PathScout"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan",        returnType: CAPPluginReturnPromise),
    ]

    private let scanner = PathScoutScanner()

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve([
            "available": scanner.modelAvailable,
            "modelPath": scanner.modelURL?.lastPathComponent ?? "",
        ])
    }

    @objc func start(_ call: CAPPluginCall) {
        scanner.start { err in
            if let err = err { call.reject(err.localizedDescription) }
            else { call.resolve() }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        scanner.stop()
        call.resolve()
    }

    @objc func scan(_ call: CAPPluginCall) {
        scanner.scanOnce { result in
            switch result {
            case .success(let dict): call.resolve(dict)
            case .failure(let err):  call.reject(err.localizedDescription)
            }
        }
    }
}

// MARK: - Errors

enum PathScoutError: LocalizedError {
    case modelMissing
    case modelLoadFailed(String)
    case cameraDenied
    case cameraUnavailable
    case captureSetupFailed(String)
    case noFrameAvailable
    case inferenceFailed(String)
    case malformedOutput

    var errorDescription: String? {
        switch self {
        case .modelMissing:               return "PathScout.mlmodelc not bundled. Did you drag PathScout.mlpackage into Xcode?"
        case .modelLoadFailed(let m):     return "Model load failed: \(m)"
        case .cameraDenied:               return "Camera permission denied."
        case .cameraUnavailable:          return "No rear camera available."
        case .captureSetupFailed(let m):  return "Camera setup failed: \(m)"
        case .noFrameAvailable:           return "No camera frame yet. Wait ~500ms after start()."
        case .inferenceFailed(let m):     return "Inference failed: \(m)"
        case .malformedOutput:            return "Model output didn't match expected shape (1x40x8400 + 1x32x160x160)."
        }
    }
}

// MARK: - Scanner (camera + model + post-processing)

final class PathScoutScanner: NSObject {

    // Class order matches the python training set:
    //   0 = curb_down  (a step going DOWN from where you stand)
    //   1 = curb_up    (a step going UP)
    //   2 = road       (street / vehicle surface)
    //   3 = sidewalk   (the path)
    static let classNames = ["curb_down", "curb_up", "road", "sidewalk"]
    static let classCount = 4
    static let maskProtoChannels = 32
    static let detectionChannels = classCount + 4 + maskProtoChannels   // = 40
    static let modelInputSize: CGFloat = 640
    static let maskProtoSize = 160
    static let anchorCount = 8400
    static let confidenceThreshold: Float = 0.40
    static let nmsIouThreshold: Float = 0.50
    static let maskBinaryThreshold: Float = 0.50

    // 3x7 grid open-path analysis (ported from open_path.py
    // OpenPathAnalyzer). Decision area is the centre 2x5; the outer
    // margin gives every decision cell 4-neighbours for the smoothed
    // "adjusted score" so the recommendation doesn't whiplash from a
    // single-cell mask hole.
    static let gridRows = 3
    static let gridCols = 7
    static let decisionRows = 2
    static let decisionCols = 5
    static let decisionStartRow = 1
    static let decisionStartCol = 1

    // Camera session ----------------------------------------------------

    private let cameraQueue = DispatchQueue(label: "PathScout.camera")
    private let inferenceQueue = DispatchQueue(label: "PathScout.inference", qos: .userInitiated)
    private var session: AVCaptureSession?
    private var videoOutput: AVCaptureVideoDataOutput?
    private let frameLock = NSLock()
    private var latestPixelBuffer: CVPixelBuffer?

    // Model -------------------------------------------------------------

    private(set) var modelAvailable: Bool = false
    private(set) var modelURL: URL?
    private var visionModel: VNCoreMLModel?

    override init() {
        super.init()
        loadModelIfAvailable()
    }

    private func loadModelIfAvailable() {
        // Xcode compiles a .mlpackage into a .mlmodelc directory inside
        // the app bundle at build time. We look for either, in that order.
        let candidates = ["PathScout.mlmodelc", "PathScout.mlpackage"]
        for name in candidates {
            let base = (name as NSString).deletingPathExtension
            let ext  = (name as NSString).pathExtension
            if let url = Bundle.main.url(forResource: base, withExtension: ext) {
                modelURL = url
                do {
                    let cfg = MLModelConfiguration()
                    cfg.computeUnits = .all    // Neural Engine when available, else GPU, else CPU
                    let mlmodel = try MLModel(contentsOf: url, configuration: cfg)
                    visionModel = try VNCoreMLModel(for: mlmodel)
                    modelAvailable = true
                    return
                } catch {
                    NSLog("[PathScout] Failed to load model at \(url.path): \(error)")
                }
            }
        }
        modelAvailable = false
    }

    // MARK: - Public lifecycle

    func start(completion: @escaping (Error?) -> Void) {
        if !modelAvailable { completion(PathScoutError.modelMissing); return }

        // Permission ----------------------------------------------------
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            cameraQueue.async { [weak self] in self?.setupSession(completion: completion) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard granted else { completion(PathScoutError.cameraDenied); return }
                self?.cameraQueue.async { self?.setupSession(completion: completion) }
            }
        default:
            completion(PathScoutError.cameraDenied)
        }
    }

    func stop() {
        cameraQueue.async { [weak self] in
            guard let self = self else { return }
            if let s = self.session, s.isRunning { s.stopRunning() }
            self.session = nil
            self.videoOutput = nil
            self.frameLock.lock()
            self.latestPixelBuffer = nil
            self.frameLock.unlock()
        }
    }

    private func setupSession(completion: @escaping (Error?) -> Void) {
        if session != nil { completion(nil); return }   // already running
        let session = AVCaptureSession()
        session.beginConfiguration()
        session.sessionPreset = .vga640x480   // model wants 640x640; 480p is plenty and cheap

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                                   for: .video, position: .back) else {
            completion(PathScoutError.cameraUnavailable); return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                completion(PathScoutError.captureSetupFailed("can't add input")); return
            }
            session.addInput(input)
        } catch {
            completion(PathScoutError.captureSetupFailed(error.localizedDescription)); return
        }

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: cameraQueue)
        guard session.canAddOutput(output) else {
            completion(PathScoutError.captureSetupFailed("can't add output")); return
        }
        session.addOutput(output)

        // Force portrait so "up" in the buffer == "up" in the world.
        if let conn = output.connection(with: .video) {
            if conn.isVideoOrientationSupported { conn.videoOrientation = .portrait }
            if conn.isVideoMirroringSupported { conn.isVideoMirrored = false }
        }

        session.commitConfiguration()
        session.startRunning()
        self.session = session
        self.videoOutput = output
        completion(nil)
    }

    // MARK: - Scan

    func scanOnce(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let vnModel = visionModel else {
            completion(.failure(PathScoutError.modelMissing)); return
        }
        frameLock.lock()
        let buf = latestPixelBuffer
        frameLock.unlock()
        guard let pixelBuffer = buf else {
            completion(.failure(PathScoutError.noFrameAvailable)); return
        }

        inferenceQueue.async { [weak self] in
            guard let self = self else { return }
            let request = VNCoreMLRequest(model: vnModel) { req, err in
                if let err = err {
                    completion(.failure(PathScoutError.inferenceFailed(err.localizedDescription)))
                    return
                }
                guard let observations = req.results as? [VNCoreMLFeatureValueObservation] else {
                    completion(.failure(PathScoutError.malformedOutput)); return
                }
                // Identify the two output tensors by shape (their names are
                // auto-generated by coremltools and vary between exports).
                var detection: MLMultiArray?
                var prototypes: MLMultiArray?
                for obs in observations {
                    guard let arr = obs.featureValue.multiArrayValue else { continue }
                    let shape = arr.shape.map { $0.intValue }
                    if shape.count == 3 && shape[1] == Self.detectionChannels { detection = arr }
                    else if shape.count == 4 && shape[1] == Self.maskProtoChannels { prototypes = arr }
                }
                guard let det = detection, let proto = prototypes else {
                    completion(.failure(PathScoutError.malformedOutput)); return
                }
                let dict = self.buildGuidance(detection: det, prototypes: proto)
                completion(.success(dict))
            }
            // .scaleFit = letterbox; preserves aspect ratio so left/right
            // distances aren't squashed when the camera is 4:3 vs 1:1.
            request.imageCropAndScaleOption = .scaleFit
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer,
                                                orientation: .up,
                                                options: [:])
            do {
                try handler.perform([request])
            } catch {
                completion(.failure(PathScoutError.inferenceFailed(error.localizedDescription)))
            }
        }
    }

    // MARK: - YOLO-seg post-processing

    /// Top-level decoder: takes raw model output, produces the guidance dict
    /// the JS side hands to `announce()`.
    private func buildGuidance(detection: MLMultiArray, prototypes: MLMultiArray) -> [String: Any] {

        // 1) Decode detection tensor → list of (classIdx, score, box, mask coefs)
        let detections = decodeDetections(detection)

        // 2) NMS per class
        let kept = nms(detections, iouThreshold: Self.nmsIouThreshold)

        // 3) Union masks per class (so we can analyse "all sidewalk together")
        //    Mask is 160x160 binary; we work directly at that resolution and
        //    only upsample logically (grid cell ratios) when we analyse.
        var classMaskUnion = [[UInt8]](repeating: [UInt8](repeating: 0,
                                                          count: Self.maskProtoSize * Self.maskProtoSize),
                                        count: Self.classCount)
        var perClassCount = [Int](repeating: 0, count: Self.classCount)

        let protoFlat = bindFloatPointer(prototypes)
        let protoStride = Self.maskProtoSize * Self.maskProtoSize     // 25600 floats per channel

        for det in kept {
            if det.classIdx < 0 || det.classIdx >= Self.classCount { continue }
            perClassCount[det.classIdx] += 1
            // mask = sigmoid(sum_k coef_k * proto_k), cropped to box
            // box is in 640x640 model space; convert to 160x160 mask space.
            let bx0 = Int((det.box.minX / Self.modelInputSize) * CGFloat(Self.maskProtoSize)).clamped(0, Self.maskProtoSize - 1)
            let by0 = Int((det.box.minY / Self.modelInputSize) * CGFloat(Self.maskProtoSize)).clamped(0, Self.maskProtoSize - 1)
            let bx1 = Int((det.box.maxX / Self.modelInputSize) * CGFloat(Self.maskProtoSize)).clamped(0, Self.maskProtoSize - 1)
            let by1 = Int((det.box.maxY / Self.modelInputSize) * CGFloat(Self.maskProtoSize)).clamped(0, Self.maskProtoSize - 1)

            // Walk only inside the box -- saves a lot of compute on small detections.
            for y in by0...by1 {
                let rowBase = y * Self.maskProtoSize
                for x in bx0...bx1 {
                    var acc: Float = 0
                    let pi = rowBase + x
                    for k in 0..<Self.maskProtoChannels {
                        acc += det.maskCoef[k] * protoFlat[k * protoStride + pi]
                    }
                    // sigmoid
                    let s = 1.0 / (1.0 + expf(-acc))
                    if s >= Self.maskBinaryThreshold {
                        classMaskUnion[det.classIdx][pi] = 1
                    }
                }
            }
        }

        // 4) Coverage fractions per class (over the full 160x160 frame).
        var areaFraction = [Float](repeating: 0, count: Self.classCount)
        let totalPixels = Float(Self.maskProtoSize * Self.maskProtoSize)
        for c in 0..<Self.classCount {
            var sum: Int = 0
            for b in classMaskUnion[c] { sum += Int(b) }
            areaFraction[c] = Float(sum) / totalPixels
        }

        // 5) Open-path analysis on sidewalk mask (cls=3).
        let openPath = analyseOpenPath(maskBitmap: classMaskUnion[3],
                                       size: Self.maskProtoSize)

        // 6) Curb-in-fan: is curb_down (0) or curb_up (1) anywhere in the
        //    bottom-centre wedge? We approximate the fan as the bottom-half
        //    centre 3 grid columns (j = 2,3,4 of 7 cols, i = 1,2 of 3 rows).
        let curbDownInFan  = anyMaskPixel(in: classMaskUnion[0], inFanZone: true)
        let curbUpInFan    = anyMaskPixel(in: classMaskUnion[1], inFanZone: true)
        let curbDownPresent = perClassCount[0] > 0
        let curbUpPresent   = perClassCount[1] > 0

        // 7) Estimate distance to nearest curb (very rough; see header).
        let curbDownDistFt = curbDownInFan ? estimateForwardDistanceFt(of: classMaskUnion[0],
                                                                       size: Self.maskProtoSize) : nil
        let curbUpDistFt   = curbUpInFan   ? estimateForwardDistanceFt(of: classMaskUnion[1],
                                                                       size: Self.maskProtoSize) : nil

        // 8) Combine everything into a single human sentence.
        let guidance = composeGuidance(direction: openPath.direction,
                                       intensity: openPath.intensity,
                                       sidewalkArea: areaFraction[3],
                                       roadArea: areaFraction[2],
                                       curbDownInFan: curbDownInFan,
                                       curbUpInFan: curbUpInFan,
                                       curbDownDistFt: curbDownDistFt,
                                       curbUpDistFt: curbUpDistFt)

        return [
            "guidance":        guidance,
            "direction":       openPath.direction,     // "left" | "center" | "right" | "unknown"
            "intensity":       openPath.intensity,     // "strong" | "weak" | "none"
            "sidewalkArea":    areaFraction[3],
            "roadArea":        areaFraction[2],
            "curbDownAhead":   curbDownInFan,
            "curbUpAhead":     curbUpInFan,
            "curbDownDistFt":  curbDownDistFt as Any,
            "curbUpDistFt":    curbUpDistFt as Any,
            "curbDownPresent": curbDownPresent,
            "curbUpPresent":   curbUpPresent,
        ]
    }

    // ---- Detection decode ------------------------------------------------

    private struct DecodedDet {
        let classIdx: Int
        let score: Float
        let box: CGRect             // in 640x640 model space
        let maskCoef: [Float]       // length 32
    }

    /// Walk all 8400 anchors, keep those with max class confidence >=
    /// `confidenceThreshold`. The tensor layout is channels-major:
    /// index = channel * 8400 + anchor.
    private func decodeDetections(_ det: MLMultiArray) -> [DecodedDet] {
        let p = bindFloatPointer(det)
        let A = Self.anchorCount
        var out: [DecodedDet] = []
        out.reserveCapacity(256)

        let classCount = Self.classCount
        let coefStart  = 4 + classCount       // = 8 in our 40-channel layout

        for k in 0..<A {
            // Find the best class for this anchor.
            var bestCls = 0
            var bestScore: Float = 0
            for c in 0..<classCount {
                let s = p[(4 + c) * A + k]
                if s > bestScore { bestScore = s; bestCls = c }
            }
            if bestScore < Self.confidenceThreshold { continue }

            // YOLO box is centre-x, centre-y, width, height in 640px space.
            let cx = CGFloat(p[0 * A + k])
            let cy = CGFloat(p[1 * A + k])
            let w  = CGFloat(p[2 * A + k])
            let h  = CGFloat(p[3 * A + k])
            let box = CGRect(x: cx - w * 0.5, y: cy - h * 0.5, width: w, height: h)

            // Mask coefficients.
            var coef = [Float](repeating: 0, count: Self.maskProtoChannels)
            for ki in 0..<Self.maskProtoChannels {
                coef[ki] = p[(coefStart + ki) * A + k]
            }

            out.append(DecodedDet(classIdx: bestCls, score: bestScore, box: box, maskCoef: coef))
        }
        return out
    }

    /// Standard greedy NMS, applied independently per class.
    private func nms(_ dets: [DecodedDet], iouThreshold: Float) -> [DecodedDet] {
        var byClass = [Int: [DecodedDet]]()
        for d in dets { byClass[d.classIdx, default: []].append(d) }
        var kept: [DecodedDet] = []
        for (_, list) in byClass {
            let sorted = list.sorted { $0.score > $1.score }
            var alive = [Bool](repeating: true, count: sorted.count)
            for i in 0..<sorted.count where alive[i] {
                kept.append(sorted[i])
                for j in (i+1)..<sorted.count where alive[j] {
                    if iou(sorted[i].box, sorted[j].box) > iouThreshold { alive[j] = false }
                }
            }
        }
        return kept
    }

    private func iou(_ a: CGRect, _ b: CGRect) -> Float {
        let inter = a.intersection(b)
        if inter.isNull || inter.isEmpty { return 0 }
        let interA = Float(inter.width * inter.height)
        let uA = Float(a.width * a.height + b.width * b.height) - interA
        return uA > 0 ? interA / uA : 0
    }

    // ---- Open path 3x7 grid (ported from OpenPathAnalyzer) ---------------

    private struct OpenPathResult {
        let direction: String   // "left" | "center" | "right" | "unknown"
        let intensity: String   // "strong" | "weak" | "none"
    }

    private func analyseOpenPath(maskBitmap: [UInt8], size: Int) -> OpenPathResult {
        // Need *some* sidewalk pixels at all -- otherwise nothing to analyse.
        var topY = size
        for y in 0..<size {
            let rowBase = y * size
            var rowHas = false
            for x in 0..<size { if maskBitmap[rowBase + x] != 0 { rowHas = true; break } }
            if rowHas { topY = y; break }
        }
        if topY >= size { return OpenPathResult(direction: "unknown", intensity: "none") }

        // Clamp top to a sensible range so a single sidewalk pixel near the
        // top of the frame doesn't stretch the grid over the whole image.
        topY = max(Int(0.10 * Double(size)), min(Int(0.50 * Double(size)), topY))
        let gridHeight = size - topY
        let cellH = gridHeight / Self.gridRows
        let cellW = size / Self.gridCols
        if cellH < 1 || cellW < 1 { return OpenPathResult(direction: "unknown", intensity: "none") }

        // 3x7 raw_scores (coverage per cell)
        var raw = Array(repeating: Array(repeating: Float(0), count: Self.gridCols), count: Self.gridRows)
        for r in 0..<Self.gridRows {
            let y0 = topY + r * cellH
            let y1 = min(topY + (r + 1) * cellH, size)
            for c in 0..<Self.gridCols {
                let x0 = c * cellW
                let x1 = min((c + 1) * cellW, size)
                var sum: Int = 0
                for y in y0..<y1 {
                    let rb = y * size
                    for x in x0..<x1 { sum += Int(maskBitmap[rb + x]) }
                }
                let total = (y1 - y0) * (x1 - x0)
                raw[r][c] = total > 0 ? Float(sum) / Float(total) : 0
            }
        }

        // 2x5 adjusted_scores: 0.4 C + 0.2 T + 0.1 (L + R + TR + TL)
        var adj = Array(repeating: Array(repeating: Float(0), count: Self.decisionCols), count: Self.decisionRows)
        for r in 0..<Self.decisionRows {
            for c in 0..<Self.decisionCols {
                let i = r + Self.decisionStartRow
                let j = c + Self.decisionStartCol
                let C  = raw[i  ][j  ]
                let T  = raw[i-1][j  ]
                let L  = raw[i  ][j-1]
                let R  = raw[i  ][j+1]
                let TR = raw[i-1][j+1]
                let TL = raw[i-1][j-1]
                adj[r][c] = 0.4 * C + 0.2 * T + 0.1 * (L + R + TR + TL)
            }
        }
        // Centre-column boost and high-score boost (rules 1 & 2 in the paper).
        let centerCol = 2
        for r in 0..<Self.decisionRows {
            adj[r][centerCol] += 0.05
            for c in 0..<Self.decisionCols where adj[r][c] > 0.95 { adj[r][c] += 0.05 }
        }
        // If everything is essentially saturated, walk straight.
        if adj.allSatisfy({ $0.allSatisfy { $0 >= 0.99 } }) {
            return OpenPathResult(direction: "center", intensity: "strong")
        }

        // Pick the column with the highest column-sum of adjusted scores.
        var bestCol = 0; var bestSum: Float = -1
        for c in 0..<Self.decisionCols {
            var s: Float = 0
            for r in 0..<Self.decisionRows { s += adj[r][c] }
            if s > bestSum { bestSum = s; bestCol = c }
        }
        let direction: String =
            bestCol <= 1 ? "left" : (bestCol >= 3 ? "right" : "center")
        let intensity: String
        if bestSum < 0.8 { intensity = "none" }
        else if adj[0][bestCol] >= 0.9 { intensity = "strong" }
        else { intensity = "weak" }
        return OpenPathResult(direction: direction, intensity: intensity)
    }

    // ---- Curb "fan zone" check -------------------------------------------

    /// True if any mask pixel falls in the bottom-centre wedge of the
    /// frame -- our coarse proxy for "directly in front of the user".
    /// Wedge is the centre 3 columns × bottom 2 rows of the 3x7 grid.
    private func anyMaskPixel(in maskBitmap: [UInt8], inFanZone: Bool) -> Bool {
        let size = Self.maskProtoSize
        let topY = size / 3                  // bottom 2/3 of the image
        let xLo  = (2 * size) / 7            // centre 3/7 columns
        let xHi  = (5 * size) / 7
        for y in topY..<size {
            let rb = y * size
            for x in xLo..<xHi where maskBitmap[rb + x] != 0 { return true }
        }
        return false
    }

    /// Crude pin-hole distance estimate for an object directly ahead.
    /// We anchor on the LOWEST mask pixel (closest to the camera). Mapping
    /// is empirical for a phone held vertically at ~chest height:
    ///   y_norm = 1   (mask touches bottom of frame)  -> ~ 2 ft
    ///   y_norm = 0.5 (mask centred in the frame)     -> ~10 ft
    ///   y_norm = 0   (mask near top of frame)        -> ~25 ft
    /// Returned values are clamped to [2, 30] ft.
    private func estimateForwardDistanceFt(of maskBitmap: [UInt8], size: Int) -> Double {
        var lowestY: Int = -1
        for y in stride(from: size - 1, through: 0, by: -1) {
            let rb = y * size
            for x in 0..<size where maskBitmap[rb + x] != 0 { lowestY = y; break }
            if lowestY >= 0 { break }
        }
        if lowestY < 0 { return 30 }
        let yNorm = Double(lowestY) / Double(size - 1)
        let dist = 2.0 + (1.0 - yNorm) * 23.0
        return max(2.0, min(30.0, dist))
    }

    // ---- Guidance composition -------------------------------------------

    private func composeGuidance(direction: String,
                                 intensity: String,
                                 sidewalkArea: Float,
                                 roadArea: Float,
                                 curbDownInFan: Bool,
                                 curbUpInFan: Bool,
                                 curbDownDistFt: Double?,
                                 curbUpDistFt: Double?) -> String {

        // Nothing recognisable in view at all.
        if sidewalkArea < 0.02 && roadArea < 0.02 && !curbDownInFan && !curbUpInFan {
            return "No path detected. Point the phone forward and try again."
        }

        // Curb has highest priority -- the user could step into traffic
        // or trip if we let path guidance speak first.
        var parts: [String] = []
        if curbUpInFan, let d = curbUpDistFt {
            parts.append("Curb up \(Int(d.rounded())) feet ahead, step up cautiously.")
        } else if curbDownInFan, let d = curbDownDistFt {
            parts.append("Curb down \(Int(d.rounded())) feet ahead, step down cautiously.")
        }

        // Path direction.
        switch (direction, intensity) {
        case ("center", "strong"):
            parts.append("Path is clear, continue straight.")
        case ("center", "weak"):
            parts.append("Sidewalk narrow ahead, proceed with caution.")
        case ("left", "strong"):
            parts.append("Sidewalk continues to your left, turn left.")
        case ("left", "weak"):
            parts.append("Obstacle ahead, move slightly to your left.")
        case ("right", "strong"):
            parts.append("Sidewalk continues to your right, turn right.")
        case ("right", "weak"):
            parts.append("Obstacle ahead, move slightly to your right.")
        case (_, "none"):
            // Sidewalk visible but no clear gap. If road area is high,
            // the user is probably mid-street.
            if roadArea > 0.3 {
                parts.append("You appear to be on the road. Step back to the sidewalk.")
            } else if sidewalkArea < 0.10 {
                parts.append("Sidewalk hard to see ahead. Sweep the phone left and right.")
            } else {
                parts.append("Path unclear. Proceed slowly.")
            }
        default:
            parts.append("Path unclear.")
        }
        return parts.joined(separator: " ")
    }

    // ---- Helpers ---------------------------------------------------------

    private func bindFloatPointer(_ arr: MLMultiArray) -> UnsafePointer<Float> {
        return UnsafePointer<Float>(OpaquePointer(arr.dataPointer))
    }
}

// MARK: - Sample buffer delegate

extension PathScoutScanner: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        frameLock.lock()
        latestPixelBuffer = pb
        frameLock.unlock()
    }
}

// MARK: - Tiny utility

private extension Int {
    func clamped(_ lo: Int, _ hi: Int) -> Int { Swift.max(lo, Swift.min(hi, self)) }
}
