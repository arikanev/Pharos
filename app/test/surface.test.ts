import { describe, it, expect } from "vitest";
import {
  classifySurfaceValue,
  summarizeSurface,
  mergeSurfaceSpans,
  type SurfaceSegment,
} from "../src/lib/surface";

describe("classifySurfaceValue", () => {
  it("maps known paved values", () => {
    for (const v of ["asphalt", "concrete", "paving_stones", "sett", "paved"]) {
      expect(classifySurfaceValue(v)).toBe("paved");
    }
  });

  it("maps known unpaved values", () => {
    for (const v of ["gravel", "compacted", "ground", "dirt", "grass", "sand", "unpaved"]) {
      expect(classifySurfaceValue(v)).toBe("unpaved");
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(classifySurfaceValue(" ASPHALT ")).toBe("paved");
    expect(classifySurfaceValue("Gravel")).toBe("unpaved");
  });

  it("returns unknown for missing or unrecognized values", () => {
    expect(classifySurfaceValue(undefined)).toBe("unknown");
    expect(classifySurfaceValue("")).toBe("unknown");
    expect(classifySurfaceValue("moon_dust")).toBe("unknown");
  });
});

function seg(
  fromIdx: number,
  surface: SurfaceSegment["surface"],
  lengthFt: number,
  startFt: number,
): SurfaceSegment {
  return {
    fromIdx,
    toIdx: fromIdx + 1,
    startFt,
    endFt: startFt + lengthFt,
    lengthFt,
    surface,
    rawValue: surface === "unknown" ? null : surface,
    offRouteFt: 1,
  };
}

describe("summarizeSurface", () => {
  it("totals by class and computes fractions over classified length", () => {
    const segs = [
      seg(0, "paved", 100, 0),
      seg(1, "unpaved", 300, 100),
      seg(2, "unknown", 100, 400),
    ];
    const s = summarizeSurface(segs);
    expect(s.pavedFt).toBe(100);
    expect(s.unpavedFt).toBe(300);
    expect(s.unknownFt).toBe(100);
    expect(s.totalFt).toBe(500);
    // unpaved fraction is over classified (paved+unpaved) length only: 300/400
    expect(s.unpavedFraction).toBeCloseTo(0.75);
    expect(s.unknownFraction).toBeCloseTo(0.2);
  });

  it("does not divide by zero when nothing is classified", () => {
    const s = summarizeSurface([seg(0, "unknown", 100, 0)]);
    expect(s.unpavedFraction).toBe(0);
    expect(s.unknownFraction).toBe(1);
  });

  it("handles an empty segment list", () => {
    const s = summarizeSurface([]);
    expect(s).toEqual({
      totalFt: 0,
      pavedFt: 0,
      unpavedFt: 0,
      unknownFt: 0,
      unpavedFraction: 0,
      unknownFraction: 0,
    });
  });
});

describe("mergeSurfaceSpans", () => {
  it("collapses consecutive same-class segments", () => {
    const segs = [
      seg(0, "paved", 50, 0),
      seg(1, "paved", 50, 50),
      seg(2, "unpaved", 100, 100),
      seg(3, "paved", 25, 200),
    ];
    const spans = mergeSurfaceSpans(segs);
    expect(spans.map((s) => s.surface)).toEqual(["paved", "unpaved", "paved"]);
    expect(spans[0]).toMatchObject({ fromIdx: 0, toIdx: 2, startFt: 0, endFt: 100, lengthFt: 100 });
    expect(spans[1]).toMatchObject({ fromIdx: 2, toIdx: 3, lengthFt: 100 });
    expect(spans[2]).toMatchObject({ fromIdx: 3, toIdx: 4, lengthFt: 25 });
  });

  it("does not mutate the input segments", () => {
    const segs = [seg(0, "paved", 50, 0), seg(1, "paved", 50, 50)];
    mergeSurfaceSpans(segs);
    expect(segs[0].toIdx).toBe(1);
    expect(segs[0].endFt).toBe(50);
  });

  it("returns [] for empty input", () => {
    expect(mergeSurfaceSpans([])).toEqual([]);
  });
});
