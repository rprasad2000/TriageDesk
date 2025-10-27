import React, { useEffect, useState } from "react";
import { getHeatmap } from "../api"; // adjust path if needed

type HeatmapPayload = {
  sprints: string[];
  labels: string[];
  matrix: Record<string, number[]>;
};

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

const HeatmapSection: React.FC<{ activeSprints?: string[] }> = ({ activeSprints }) => {
  const [data, setData] = useState<HeatmapPayload | null>(null);
  const [maxVal, setMaxVal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);

 
  // at top add error state
  const [error, setError] = useState<string | null>(null);
useEffect(() => {
  // defensive: coerce activeSprints to array so we don't call with undefined
  const raw = Array.isArray(activeSprints) ? activeSprints : [];

  // Filter out placeholder/future sprints which often contain zero issues and trigger backend NaNs.
  // Adjust regex if your placeholders use other naming.
  const filtered = raw.filter((s) => {
    if (!s || typeof s !== "string") return false;
    // exclude entries like "Future 1", "Future-1", "Backlog", etc. - tune as needed
    const lower = s.trim().toLowerCase();
    if (/^future\b/i.test(lower)) return false;
    if (/^backlog\b/i.test(lower)) return false;
    // keep everything else
    return true;
  });

  // If nothing remains after filter, show friendly message and skip API call
  if (filtered.length === 0) {
    setData(null);
    setMaxVal(1);
    setError("No valid active sprints available for heatmap (filtered out placeholder/future sprints).");
    return;
  }

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getHeatmap(filtered, 3); // filtered list
      if (!res || !Array.isArray((res as any).sprints) || !Array.isArray((res as any).labels)) {
        setData(null);
        setMaxVal(1);
        setError("Heatmap endpoint returned no data.");
      } else {
        setData(res);
        const allVals = Object.values(res.matrix || {}).flat();
        const mx = allVals.length ? Math.max(...allVals.map((v) => Number(v) || 0)) : 0;
        setMaxVal(mx || 1);
        setError(null);
      }
    } catch (e: any) {
      console.error("heatmap fetch failed", e?.response?.data || e.message || e);
      setData(null);
      setMaxVal(1);
      const msg = e?.response?.data?.detail || e?.response?.data || e?.message || "Failed to fetch heatmap (server error)";
      setError(String(msg));
    } finally {
      setLoading(false);
    }
  };
  load();
}, [activeSprints]);

 


  if (loading) return <div style={{ padding: 12 }}>Loading heatmap…</div>;
  if (error) return <div style={{ padding: 12, color: "crimson" }}>Heatmap: {error}</div>;
  if (!data) return <div style={{ padding: 12 }}>No heatmap data available</div>;

    // Color stops that match your legend
  const LOW = [200, 240, 220, 0.8];    // rgba(200,240,220,0.8)
  const MED = [255, 210, 120, 0.95];   // rgba(255,210,120,0.95)
  const HIGH = [255,  80,  60, 0.95];  // rgba(255,80,60,0.95)

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const lerpColor = (c1: number[], c2: number[], t: number) => {
    const r = Math.round(lerp(c1[0], c2[0], t));
    const g = Math.round(lerp(c1[1], c2[1], t));
    const b = Math.round(lerp(c1[2], c2[2], t));
    const a = lerp(c1[3], c2[3], t);
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
  };

  // Color function: returns rgba color string from value (0..maxVal)
  const cellColor = (val: number) => {
    const ratio = maxVal <= 0 ? 0 : clamp(Number(val) / maxVal, 0, 1);

    // Use two-stage interpolation: 0..0.5 => LOW -> MED, 0.5..1 => MED -> HIGH
    if (ratio <= 0.5) {
      const t = ratio / 0.5; // 0..1
      return lerpColor(LOW, MED, t);
    } else {
      const t = (ratio - 0.5) / 0.5; // 0..1
      return lerpColor(MED, HIGH, t);
    }
  };


  const { sprints, labels, matrix } = data;

  return (
    <div style={{
      border: "1px solid #e6e9ee",
      borderRadius: 8,
      padding: 12,
      marginTop: 16,
      background: "#fff"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Defect Heatmap — Label × Sprint</h3>
        <div style={{ fontSize: 13, color: "#4b5563" }}>
          <span style={{ marginRight: 10 }}>Max per-cell: <strong>{maxVal}</strong></span>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #eef2f7", width: 220 }}>Label</th>
              {sprints.map((s) => (
                <th key={s} style={{ padding: "8px 12px", borderBottom: "1px solid #eef2f7", textAlign: "center", whiteSpace: "nowrap" }}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => {
              const row = matrix[label] || sprints.map(() => 0);
              return (
                <tr key={label}>
                  <td style={{ padding: "10px 12px", borderBottom: "1px solid #f3f6f9", fontWeight: 600 }}>{label}</td>
                  {row.map((val, idx) => (
                    <td key={idx} style={{
                      padding: 6,
                      borderBottom: "1px solid #f3f6f9",
                      textAlign: "center",
                      background: val > 0 ? cellColor(val) : "transparent",
                      color: val > maxVal * 0.5 ? "#fff" : "#1f2937",
                      minWidth: 80,
                      verticalAlign: "middle"
                    }}
                      title={`${label} — ${sprints[idx]}: ${val}`}
                    >
                      <div style={{ minHeight: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontWeight: 600 }}>{val}</span>
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <div style={{ fontSize: 13, color: "#4b5563", minWidth: 90 }}>Legend:</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <LegendBox label="Low" color="rgba(200,240,220,0.8)" />
          <LegendBox label="Medium" color="rgba(255,210,120,0.95)" />
          <LegendBox label="High" color="rgba(255,80,60,0.95)" />
        </div>
      </div>
    </div>
  );
};

const LegendBox: React.FC<{ label: string; color: string }> = ({ label, color }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <div style={{ width: 36, height: 16, background: color, borderRadius: 4, border: "1px solid rgba(0,0,0,0.06)" }} />
    <div style={{ fontSize: 13 }}>{label}</div>
  </div>
);

export default HeatmapSection;
