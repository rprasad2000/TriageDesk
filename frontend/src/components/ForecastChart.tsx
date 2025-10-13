// frontend/src/components/ForecastChart.tsx
import React, { useMemo, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { api, getSprints } from "../api";

const LS_KEY = "forecast_visible_labels_v1";

type ForecastResp = {
  forecast: {
    [label: string]: {
      sprints: string[];
      history: number[];
      forecast: number[];
      n_history?: number;
      delta_next?: number | null;
      explanation?: { 
        top_root_causes?: string[]; 
        examples?: { issue_key?: string; summary?: string; url?: string; created?: string; resolved?: string; assignee?: string; priority?: string }[] 
      };
    };
  };
  insights: { label: string; trend: string; growth_rate: number; message: string }[];
};

type Props = {
  refreshKey?: number | string;
  selectedSprint?: string | null;
  forecastHorizon?: number;
  topK?: number;
};

// ==================== ANALYTICS HELPER FUNCTIONS ====================

function calculateHealthScore(insights: ForecastResp["insights"]): number {
  if (!insights || insights.length === 0) return 50;
  
  let score = 100;
  for (const ins of insights) {
    const rate = ins.growth_rate;
    if (rate > 50) score -= 15; // severe upward trend
    else if (rate > 20) score -= 8;
    else if (rate > 5) score -= 3;
    else if (rate < -20) score += 5; // improvement
    else if (rate < -5) score += 2;
  }
  return Math.max(0, Math.min(100, score));
}

function getTopRisks(insights: ForecastResp["insights"]): Array<{ label: string; rate: number; message: string }> {
  return insights
    .filter(i => i.growth_rate > 5)
    .sort((a, b) => b.growth_rate - a.growth_rate)
    .slice(0, 3)
    .map(i => ({ label: i.label, rate: i.growth_rate, message: i.message }));
}

function getTopWins(insights: ForecastResp["insights"]): Array<{ label: string; rate: number; message: string }> {
  return insights
    .filter(i => i.growth_rate < -5)
    .sort((a, b) => a.growth_rate - b.growth_rate)
    .slice(0, 3)
    .map(i => ({ label: i.label, rate: Math.abs(i.growth_rate), message: i.message }));
}

function calculateConfidenceLevel(forecast: ForecastResp["forecast"]): number {
  let totalPoints = 0;
  let count = 0;
  for (const val of Object.values(forecast)) {
    totalPoints += val.n_history || 0;
    count++;
  }
  const avgPoints = count > 0 ? totalPoints / count : 0;
  // 4+ points = high confidence (90%), 3 = medium (70%), 2 = low (50%)
  if (avgPoints >= 4) return 90;
  if (avgPoints >= 3) return 70;
  if (avgPoints >= 2) return 50;
  return 30;
}

function generateRecommendations(risks: Array<{ label: string; rate: number }>): string[] {
  const recommendations: string[] = [];
  for (const risk of risks) {
    if (risk.label.includes("API")) {
      recommendations.push(`🔧 Increase API test coverage and add integration tests`);
    } else if (risk.label.includes("Performance")) {
      recommendations.push(`⚡ Schedule performance profiling sprint`);
    } else if (risk.label.includes("Security")) {
      recommendations.push(`🔒 Conduct security audit and implement SAST tools`);
    } else if (risk.label.includes("UI")) {
      recommendations.push(`🎨 Add visual regression testing and accessibility audits`);
    } else {
      recommendations.push(`📊 Allocate ${Math.ceil(risk.rate / 20)} additional engineers to ${risk.label}`);
    }
  }
  if (recommendations.length === 0) {
    recommendations.push("✅ Continue current quality practices - trends are stable");
  }
  return recommendations.slice(0, 3);
}

function calculateSprintDeltas(forecast: ForecastResp["forecast"]): Array<{ label: string; sprints: string[]; deltas: number[] }> {
  const result: Array<{ label: string; sprints: string[]; deltas: number[] }> = [];
  
  for (const [label, val] of Object.entries(forecast)) {
    const deltas: number[] = [];
    for (let i = 1; i < val.history.length; i++) {
      const prev = val.history[i - 1];
      const curr = val.history[i];
      const delta = prev === 0 ? 0 : ((curr - prev) / prev) * 100;
      deltas.push(Number(delta.toFixed(1)));
    }
    result.push({ label, sprints: val.sprints.slice(1), deltas });
  }
  
  return result;
}

function calculateCorrelationMatrix(forecast: ForecastResp["forecast"]): Array<{ labelA: string; labelB: string; correlation: number }> {
  const labels = Object.keys(forecast);
  const correlations: Array<{ labelA: string; labelB: string; correlation: number }> = [];
  
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const labelA = labels[i];
      const labelB = labels[j];
      const histA = forecast[labelA].history;
      const histB = forecast[labelB].history;
      
      // simple correlation: if both increase/decrease together
      let matchCount = 0;
      const minLen = Math.min(histA.length, histB.length);
      for (let k = 1; k < minLen; k++) {
        const deltaA = histA[k] - histA[k - 1];
        const deltaB = histB[k] - histB[k - 1];
        if ((deltaA > 0 && deltaB > 0) || (deltaA < 0 && deltaB < 0)) {
          matchCount++;
        }
      }
      const correlation = minLen > 1 ? (matchCount / (minLen - 1)) * 100 : 0;
      if (correlation > 50) {
        correlations.push({ labelA, labelB, correlation: Number(correlation.toFixed(1)) });
      }
    }
  }
  
  return correlations.sort((a, b) => b.correlation - a.correlation).slice(0, 5);
}

function analyzeRootCausePatterns(forecast: ForecastResp["forecast"]): Array<{ cause: string; count: number; labels: string[] }> {
  const causeMap = new Map<string, Set<string>>();
  
  for (const [label, val] of Object.entries(forecast)) {
    const causes = val.explanation?.top_root_causes || [];
    for (const cause of causes) {
      if (!causeMap.has(cause)) {
        causeMap.set(cause, new Set());
      }
      causeMap.get(cause)!.add(label);
    }
  }
  
  const result: Array<{ cause: string; count: number; labels: string[] }> = [];
  for (const [cause, labelSet] of causeMap.entries()) {
    result.push({ cause, count: labelSet.size, labels: Array.from(labelSet) });
  }
  
  return result.sort((a, b) => b.count - a.count).slice(0, 6);
}

// ==================== MAIN COMPONENT HELPERS ====================

function pickTopKLabels(forecast: ForecastResp["forecast"], k: number) {
  const totals: Array<{ label: string; total: number }> = [];
  for (const [lab, val] of Object.entries(forecast || {})) {
    const histSum = (val.history || []).reduce((a, b) => a + (Number(b) || 0), 0);
    totals.push({ label: lab, total: histSum });
  }
  totals.sort((a, b) => b.total - a.total);
  return totals.slice(0, k).map((t) => t.label);
}

function transformToChartData(
  forecast: ForecastResp["forecast"], 
  horizon: number,
  canonicalSprintOrder: string[]
) {
  const allHistSprintsSet = new Set<string>();
  for (const val of Object.values(forecast)) {
    for (const s of val.sprints) {
      allHistSprintsSet.add(s);
    }
  }

  const sprintRank = new Map<string, number>();
  canonicalSprintOrder.forEach((sprint, idx) => {
    sprintRank.set(sprint, idx);
  });

  const allHistSprints = Array.from(allHistSprintsSet).sort((a, b) => {
    const rankA = sprintRank.get(a) ?? 999999;
    const rankB = sprintRank.get(b) ?? 999999;
    if (rankA !== rankB) return rankA - rankB;
    return a.localeCompare(b);
  });

  const futureLabels = Array.from({ length: horizon }).map((_, i) => `Future ${i + 1}`);
  const xTicks = [...allHistSprints, ...futureLabels];

  const data = xTicks.map((sprint) => {
    const row: any = { sprint };
    for (const [lab, val] of Object.entries(forecast)) {
      const histIdx = val.sprints ? val.sprints.indexOf(sprint) : -1;
      if (histIdx >= 0) {
        row[`${lab}__hist`] = Number(val.history?.[histIdx] ?? null);
        row[`${lab}__fcast`] = null;
      } else {
        const futIndex = futureLabels.indexOf(sprint);
        if (futIndex >= 0) {
          row[`${lab}__hist`] = null;
          row[`${lab}__fcast`] = Number(val.forecast?.[futIndex] ?? null);
        } else {
          row[`${lab}__hist`] = null;
          row[`${lab}__fcast`] = null;
        }
      }
    }
    return row;
  });

  return { data, xTicks };
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const grouped: Record<string, { val: number | null; kind: "history" | "forecast" | null }> = {};
  for (const p of payload) {
    const key = p.dataKey as string;
    const v = p.value;
    if (key.endsWith("__hist")) {
      const lab = key.slice(0, -6);
      if (!grouped[lab]) grouped[lab] = { val: null, kind: null };
      if (v !== null && v !== undefined) grouped[lab] = { val: v, kind: "history" };
    } else if (key.endsWith("__fcast")) {
      const lab = key.slice(0, -7);
      if (!grouped[lab]) grouped[lab] = { val: null, kind: null };
      if (v !== null && v !== undefined) grouped[lab] = { val: v, kind: "forecast" };
    }
  }

  const rows = Object.entries(grouped).filter(([, v]) => v.val !== null);
  if (rows.length === 0) return null;

  return (
    <div style={{ background: "white", border: "1px solid rgba(0,0,0,0.08)", padding: 8, borderRadius: 6 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>{label}</div>
      {rows.map(([lab, v]) => (
        <div key={lab} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700 }}>{lab}</div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13 }}>{v.val}</div>
            <div style={{ fontSize: 11, color: v.kind === "forecast" ? "#b04" : "#666" }}>{v.kind === "forecast" ? "Forecast" : "History"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== ANALYTICS PANEL COMPONENTS ====================

function ExecutiveSummaryPanel({ data }: { data: ForecastResp }) {
  const healthScore = useMemo(() => calculateHealthScore(data.insights), [data.insights]);
  const topRisks = useMemo(() => getTopRisks(data.insights), [data.insights]);
  const topWins = useMemo(() => getTopWins(data.insights), [data.insights]);
  const confidence = useMemo(() => calculateConfidenceLevel(data.forecast), [data.forecast]);
  const recommendations = useMemo(() => generateRecommendations(topRisks), [topRisks]);

  const healthColor = healthScore >= 80 ? "#22c55e" : healthScore >= 60 ? "#f59e0b" : "#ef4444";
  const healthIcon = healthScore >= 80 ? "🟢" : healthScore >= 60 ? "🟡" : "🔴";

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {/* Health Score Card */}
        <div style={{ padding: 16, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fafafa" }}>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Overall Health Score</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: healthColor }}>{healthIcon}</div>
            <div>
              <div style={{ fontSize: 32, fontWeight: 700, color: healthColor }}>{healthScore}</div>
              <div style={{ fontSize: 12, color: "#666" }}>out of 100</div>
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
            Forecast Confidence: <b>{confidence}%</b>
          </div>
        </div>

        {/* Top Risks */}
        <div style={{ padding: 16, borderRadius: 8, border: "1px solid #fee2e2", background: "#fef2f2" }}>
          <div style={{ fontSize: 13, color: "#991b1b", marginBottom: 12, fontWeight: 600 }}>🔴 Top 3 Risks</div>
          {topRisks.length > 0 ? (
            topRisks.map((risk, i) => (
              <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < topRisks.length - 1 ? "1px solid #fecaca" : "none" }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{risk.label}</div>
                <div style={{ fontSize: 12, color: "#dc2626" }}>↑ {risk.rate.toFixed(1)}% increase</div>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: "#666" }}>No significant risks detected</div>
          )}
        </div>

        {/* Top Wins */}
        <div style={{ padding: 16, borderRadius: 8, border: "1px solid #d1fae5", background: "#f0fdf4" }}>
          <div style={{ fontSize: 13, color: "#065f46", marginBottom: 12, fontWeight: 600 }}>🟢 Top 3 Wins</div>
          {topWins.length > 0 ? (
            topWins.map((win, i) => (
              <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < topWins.length - 1 ? "1px solid #a7f3d0" : "none" }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{win.label}</div>
                <div style={{ fontSize: 12, color: "#16a34a" }}>↓ {win.rate.toFixed(1)}% decrease</div>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: "#666" }}>No significant improvements yet</div>
          )}
        </div>
      </div>

      {/* Recommended Actions */}
      <div style={{ marginTop: 16, padding: 16, borderRadius: 8, border: "1px solid #dbeafe", background: "#eff6ff" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#1e40af", marginBottom: 12 }}>💡 Recommended Actions</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#334155" }}>
          {recommendations.map((rec, i) => (
            <li key={i} style={{ marginBottom: 6 }}>{rec}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TimeComparisonPanel({ data }: { data: ForecastResp }) {
  const sprintDeltas = useMemo(() => calculateSprintDeltas(data.forecast), [data.forecast]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <h4 style={{ margin: 0, marginBottom: 8, fontSize: 14, color: "#334155" }}>Sprint-over-Sprint % Change</h4>
        <div style={{ maxHeight: 400, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ position: "sticky", top: 0, background: "#f9fafb", borderBottom: "2px solid #e5e7eb" }}>
              <tr>
                <th style={{ padding: 8, textAlign: "left", fontWeight: 600 }}>Category</th>
                {sprintDeltas[0]?.sprints.map((sprint, i) => (
                  <th key={i} style={{ padding: 8, textAlign: "right", fontWeight: 600 }}>{sprint}</th>
                ))}
                <th style={{ padding: 8, textAlign: "center", fontWeight: 600 }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {sprintDeltas.map((item, idx) => {
                const avgDelta = item.deltas.reduce((a, b) => a + b, 0) / item.deltas.length;
                const trendIcon = avgDelta > 10 ? "📈" : avgDelta < -10 ? "📉" : "➡️(stable)";
                return (
                  <tr key={idx} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: 8, fontWeight: 600 }}>{item.label}</td>
                    {item.deltas.map((delta, i) => (
                      <td key={i} style={{ padding: 8, textAlign: "right", color: delta > 0 ? "#dc2626" : delta < 0 ? "#16a34a" : "#64748b" }}>
                        {delta > 0 ? "+" : ""}{delta.toFixed(1)}%
                      </td>
                    ))}
                    <td style={{ padding: 8, textAlign: "center", fontSize: 16 }}>{trendIcon}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ padding: 12, borderRadius: 8, background: "#fef3c7", border: "1px solid #fcd34d" }}>
        <div style={{ fontSize: 13, color: "#92400e" }}>
          <b>💡 Velocity Insight:</b> Categories showing acceleration (increasing rate of change) require immediate attention.
        </div>
      </div>
    </div>
  );
}

function RootCausePanel({ data }: { data: ForecastResp }) {
  const correlations = useMemo(() => calculateCorrelationMatrix(data.forecast), [data.forecast]);
  const patterns = useMemo(() => analyzeRootCausePatterns(data.forecast), [data.forecast]);

  return (
    <div style={{ padding: 16 }}>
      {/* Correlation Matrix */}
      <div style={{ marginBottom: 24 }}>
        <h4 style={{ margin: 0, marginBottom: 12, fontSize: 14, color: "#334155" }}>🔗 Category Correlations</h4>
        {correlations.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {correlations.map((cor, i) => (
              <div key={i} style={{ padding: 12, borderRadius: 6, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {cor.labelA} ↔️ {cor.labelB}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>{cor.correlation.toFixed(0)}%</div>
                </div>
                <div style={{ fontSize: 12, color: "#166534", marginTop: 4 }}>
                  These categories tend to move together - fixing one may improve the other
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#666" }}>No strong correlations detected</div>
        )}
      </div>

      {/* Common Root Causes */}
      <div>
        <h4 style={{ margin: 0, marginBottom: 12, fontSize: 14, color: "#334155" }}>🎯 Common Root Cause Patterns</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {patterns.map((pattern, i) => (
            <div key={i} style={{ padding: 12, borderRadius: 6, background: "#fef2f2", border: "1px solid #fecaca" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#991b1b", marginBottom: 6 }}>{pattern.cause}</div>
              <div style={{ fontSize: 12, color: "#666" }}>
                Affects <b>{pattern.count}</b> {pattern.count === 1 ? "category" : "categories"}:
              </div>
              <div style={{ fontSize: 11, color: "#7f1d1d", marginTop: 4 }}>
                {pattern.labels.join(", ")}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==================== MAIN COMPONENT ====================

export default function ForecastChart(props: Props) {
  const { refreshKey = 0, forecastHorizon = 3, topK = 6 } = props;
  const queryKey = ["defect-trend-forecast", refreshKey, forecastHorizon];

  const { data: canonicalSprints = [] } = useQuery<string[]>({
    queryKey: ["sprints"],
    queryFn: () => getSprints(),
    staleTime: 30_000,
  });

  const { data, isLoading, isError, refetch } = useQuery<ForecastResp>({
    queryKey,
    queryFn: async () => {
      const resp = await api.get(`/trends/forecast?sprints=${forecastHorizon}`);
      return resp.data as ForecastResp;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const chartRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<"executive" | "comparison" | "rootcause">("executive");

  const allLabels = useMemo(() => Object.keys(data?.forecast || {}), [data]);
  const initialTop = useMemo(() => {
    if (!data || !data.forecast) return [];
    return pickTopKLabels(data.forecast, topK);
  }, [data, topK]);

  const [visibleLabels, setVisibleLabels] = useState<string[] | null>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as string[];
      }
    } catch (e) {
      // ignore
    }
    return null;
  });

  React.useEffect(() => {
    if (visibleLabels === null) {
      setVisibleLabels(initialTop);
    }
  }, [initialTop, visibleLabels]);

  React.useEffect(() => {
    try {
      if (visibleLabels !== null) localStorage.setItem(LS_KEY, JSON.stringify(visibleLabels));
    } catch (e) {
      // ignore
    }
  }, [visibleLabels]);

  const toggleLabel = (lab: string) => {
    setVisibleLabels((prev) => {
      if (!prev) return [lab];
      if (prev.includes(lab)) return prev.filter((l) => l !== lab);
      return [...prev, lab];
    });
  };

  const showAll = () => setVisibleLabels(allLabels.slice());
  const clearAll = () => setVisibleLabels([]);
  const resetTop = () => setVisibleLabels(initialTop.slice());

  const chartPayload = useMemo(() => {
    if (!data || !data.forecast) return { data: [], xTicks: [] as string[] };
    return transformToChartData(data.forecast, forecastHorizon, canonicalSprints);
  }, [data, forecastHorizon, canonicalSprints]);

  const palette = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
  ];

  const exportCSV = () => {
    const rows = chartPayload.data || [];
    if (!rows || rows.length === 0) {
      alert("No chart data to export.");
      return;
    }
    const labelKeys = allLabels;
    const header = ["sprint"];
    for (const lab of labelKeys) {
      header.push(`${lab}__hist`, `${lab}__fcast`);
    }
    const csvRows = [header.join(",")];
    for (const r of rows) {
      const cols = [ `"${r.sprint?.toString().replace(/\"/g, '""') || ""}"` ];
      for (const lab of labelKeys) {
        const h = (r[`${lab}__hist`] ?? "");
        const f = (r[`${lab}__fcast`] ?? "");
        cols.push(String(h), String(f));
      }
      csvRows.push(cols.join(","));
    }
    const csv = csvRows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `defect_trends_forecast_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPNG = async () => {
    try {
      if (!chartRef.current) return alert("Chart not ready.");
      const svg = chartRef.current.querySelector("svg");
      if (!svg) return alert("SVG not found.");
      const serializer = new XMLSerializer();
      const svgStr = serializer.serializeToString(svg);
      const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.width * 2;
          canvas.height = img.height * 2;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Failed to get canvas context");
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const png = canvas.toDataURL("image/png");
          const a = document.createElement("a");
          a.href = png;
          a.download = `defect_trends_${new Date().toISOString().slice(0,10)}.png`;
          a.click();
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        alert("Failed to export PNG.");
      };
      img.src = url;
    } catch (e) {
      console.error("exportPNG failed", e);
      alert("Export failed: " + (e as any)?.message);
    }
  };

  if (isLoading) {
    return (
      <div className="card" style={{ width: "100%", minWidth: 0, marginBottom: 12 }}>
        <h2>Defect Trends (Forecast)</h2>
        <div style={{ padding: 18, color: "#666" }}>Loading forecast...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card" style={{ width: "100%", minWidth: 0, marginBottom: 12 }}>
        <h2>Defect Trends (Forecast)</h2>
        <div style={{ padding: 18, color: "crimson" }}>
          Error loading forecast. <button className="btn btn-dark" onClick={() => refetch()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!data || !data.forecast || Object.keys(data.forecast).length === 0) {
    return (
      <div className="card" style={{ width: "100%", minWidth: 0, marginBottom: 12 }}>
        <h2>Defect Trends (Forecast)</h2>
        <div style={{ padding: 18, color: "#666" }}>Not enough historical data to generate forecasts.</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ width: "100%", minWidth: 0, marginBottom: 12 }}>
      <h2>Defect Trends (Forecast)</h2>

      {/* Label Filter Controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", flexWrap: "wrap" }}>
        <div style={{ color: "#666" }}>Labels:</div>
        {allLabels.slice(0, 30).map((lab) => {
          return (
            <button
              key={lab}
              className={`btn ${visibleLabels?.includes(lab) ? "btn-dark" : "btn-ghost"}`}
              onClick={() => toggleLabel(lab)}
              type="button"
              style={{ padding: "6px 8px", display: "inline-flex", gap: 8, alignItems: "center" }}
            >
              <span>{lab}</span>
            </button>
          );
        })}

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={exportCSV}>Export CSV</button>
          <button className="btn btn-ghost" onClick={exportPNG}>Export PNG</button>
          <button className="btn btn-dark" onClick={showAll} type="button">Show all</button>
          <button className="btn btn-ghost" onClick={clearAll} type="button">Clear</button>
          <button className="btn btn-ghost" onClick={resetTop} type="button">Reset top</button>
        </div>
      </div>

      {/* Main Chart */}
      <div ref={chartRef} style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartPayload.data} margin={{ top: 8, right: 24, left: 12, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="sprint" />
            <YAxis allowDecimals={false} />
            <Tooltip content={<CustomTooltip />} />

            {visibleLabels &&
              visibleLabels.map((lab, i) => {
                const histKey = `${lab}__hist`;
                const fKey = `${lab}__fcast`;
                const color = palette[i % palette.length];
                return (
                  <React.Fragment key={lab}>
                    <Line
                      type="monotone"
                      dataKey={histKey}
                      stroke={color}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 6 }}
                      connectNulls={false}
                      isAnimationActive={false}
                      name={lab}
                    />

                    <Line
                      type="monotone"
                      dataKey={fKey}
                      stroke={color}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 6 }}
                      strokeDasharray="6 4"
                      opacity={0.65}
                      connectNulls={false}
                      isAnimationActive={false}
                      name={`${lab} (forecast)`}
                    />
                  </React.Fragment>
                );
              })}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* NEW: Analytics Panel with Tabs */}
      <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 12 }}>
        {/* Tab Navigation */}
        <div style={{ display: "flex", gap: 4, padding: "0 12px", borderBottom: "2px solid #f3f4f6" }}>
          <button
            className={activeTab === "executive" ? "btn btn-dark" : "btn btn-ghost"}
            onClick={() => setActiveTab("executive")}
            style={{ 
              borderRadius: "6px 6px 0 0", 
              borderBottom: activeTab === "executive" ? "2px solid #1f2937" : "none",
              marginBottom: activeTab === "executive" ? "-2px" : "0"
            }}
          >
            📊 Executive Summary
          </button>
          <button
            className={activeTab === "comparison" ? "btn btn-dark" : "btn btn-ghost"}
            onClick={() => setActiveTab("comparison")}
            style={{ 
              borderRadius: "6px 6px 0 0",
              borderBottom: activeTab === "comparison" ? "2px solid #1f2937" : "none",
              marginBottom: activeTab === "comparison" ? "-2px" : "0"
            }}
          >
            📈 Time Comparison
          </button>
          <button
            className={activeTab === "rootcause" ? "btn btn-dark" : "btn btn-ghost"}
            onClick={() => setActiveTab("rootcause")}
            style={{ 
              borderRadius: "6px 6px 0 0",
              borderBottom: activeTab === "rootcause" ? "2px solid #1f2937" : "none",
              marginBottom: activeTab === "rootcause" ? "-2px" : "0"
            }}
          >
            🔍 Root Cause Analysis
          </button>
        </div>

        {/* Tab Content */}
        <div style={{ background: "#fafafa" }}>
          {activeTab === "executive" && <ExecutiveSummaryPanel data={data} />}
          {activeTab === "comparison" && <TimeComparisonPanel data={data} />}
          {activeTab === "rootcause" && <RootCausePanel data={data} />}
        </div>
      </div>
    </div>
  );
}