import React, { useState, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

type ForecastDataPoint = {
  sprint: string;
  label: string;
  count: number;
  type: "actual" | "forecast";
  confidence?: number;
  lower_bound?: number;
  upper_bound?: number;
};

type ForecastChartProps = {
  sprints: string[];
  data: ForecastDataPoint[];
  allLabels: string[];
  healthScore: number;
  forecastConfidence: number;
  recommendations: Array<{ type: string; message: string }>;
  risks: Array<{ label: string; type: string; percentage: string }>;
  wins: Array<{ label: string; type: string; percentage: string }>;
  activeSprints: string[];
};

const COLORS = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"
];

export default function EnhancedForecastChart({
  sprints,
  data,
  allLabels,
  healthScore,
  forecastConfidence,
  recommendations,
  risks,
  wins,
  activeSprints
}: ForecastChartProps) {
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set(allLabels));
  const [activeTab, setActiveTab] = useState<"summary" | "comparison" | "rootcause">("summary");

  // Transform data for Recharts
  const chartData = useMemo(() => {
    const bySprintLabel = new Map<string, any>();
    
    for (const point of data) {
      if (!selectedLabels.has(point.label)) continue;
      
      const key = point.sprint;
      if (!bySprintLabel.has(key)) {
        bySprintLabel.set(key, { sprint: key });
      }
      
      const entry = bySprintLabel.get(key)!;
      entry[point.label] = point.count;
      
      // Store metadata for tooltip
      if (!entry._meta) entry._meta = {};
      entry._meta[point.label] = {
        type: point.type,
        confidence: point.confidence,
        lower: point.lower_bound,
        upper: point.upper_bound
      };
    }
    
    return sprints.map(s => bySprintLabel.get(s) || { sprint: s });
  }, [data, sprints, selectedLabels]);

  // Calculate time comparison data
  const timeComparisonData = useMemo(() => {
    const comparisons: Array<{
      label: string;
      lastActual: number;
      firstForecast: number;
      change: string;
      trend: string;
    }> = [];

    for (const label of allLabels) {
      const labelData = data.filter(d => d.label === label);
      const actuals = labelData.filter(d => d.type === "actual");
      const forecasts = labelData.filter(d => d.type === "forecast");

      if (actuals.length === 0 || forecasts.length === 0) continue;

      const lastActual = actuals[actuals.length - 1].count;
      const firstForecast = forecasts[0].count;
      const changePct = lastActual === 0 
        ? (firstForecast > 0 ? 100 : 0)
        : ((firstForecast - lastActual) / lastActual) * 100;

      comparisons.push({
        label,
        lastActual,
        firstForecast,
        change: `${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%`,
        trend: changePct > 20 ? "↗️ Increasing" : changePct < -20 ? "↘️ Decreasing" : "→ Stable"
      });
    }

    return comparisons.sort((a, b) => 
      parseFloat(b.change) - parseFloat(a.change)
    );
  }, [data, allLabels]);

  // Root cause analysis (mock data - enhance with actual root cause from backend)
  const rootCauseData = useMemo(() => {
    // In real implementation, fetch from backend endpoint that analyzes root_cause field
    return [
      { cause: "Code Quality Issues", count: 25, percentage: "35%" },
      { cause: "Requirement Gaps", count: 18, percentage: "25%" },
      { cause: "Integration Problems", count: 15, percentage: "21%" },
      { cause: "Environment Issues", count: 10, percentage: "14%" },
      { cause: "Other", count: 4, percentage: "5%" }
    ];
  }, []);

  const toggleLabel = (label: string) => {
    setSelectedLabels(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const healthColor = healthScore >= 70 ? "#22c55e" : healthScore >= 40 ? "#eab308" : "#ef4444";

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || payload.length === 0) return null;

    const sprint = payload[0]?.payload?.sprint;
    const meta = payload[0]?.payload?._meta || {};

    return (
      <div style={{
        background: "white",
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 12,
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)"
      }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{sprint}</div>
        {payload.map((entry: any, i: number) => {
          const labelMeta = meta[entry.dataKey] || {};
          const isActual = labelMeta.type === "actual";
          
          return (
            <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: entry.color }}>●</span> {entry.dataKey}: {entry.value} issues
              {!isActual && labelMeta.confidence && (
                <span style={{ color: "#666", marginLeft: 6 }}>
                  (±{labelMeta.upper - entry.value}, {Math.round(labelMeta.confidence * 100)}% conf)
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Export handlers
  const exportCSV = () => {
  if (!data || data.length === 0) {
    alert("No data to export.");
    return;
  }

  // 1️⃣ Get all unique labels and sprints
  const labels = [...new Set(data.map(d => d.label))];
  const sprints = [...new Set(data.map(d => d.sprint))];

  // Sort sprints (keep actual first, then futures)
  const sortedSprints = sprints.sort((a, b) => {
    const isFutureA = a.toLowerCase().includes("future");
    const isFutureB = b.toLowerCase().includes("future");
    if (isFutureA && !isFutureB) return 1;
    if (!isFutureA && isFutureB) return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  // 2️⃣ Build header row
  const header = ["Label", ...sortedSprints];

  // 3️⃣ Build rows per label
  const rows = labels.map(label => {
    const countsBySprint: Record<string, number> = {};
    data
      .filter(d => d.label === label)
      .forEach(d => {
        countsBySprint[d.sprint] = d.count;
      });

    return [label, ...sortedSprints.map(s => countsBySprint[s] ?? 0)];
  });

  // 4️⃣ Convert to CSV string
  const csvContent =
    [header, ...rows].map(r =>
      r.map(val => (typeof val === "string" ? `"${val}"` : val)).join(",")
    ).join("\n");

  // 5️⃣ Trigger download
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.setAttribute("download", "defect_trend_export.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};


  const exportPNG = async () => {
    const chartEl = document.querySelector("#forecast-chart-container");
    if (!chartEl) return;
    
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(chartEl as HTMLElement, { scale: 2 });
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `forecast_${new Date().toISOString().split("T")[0]}.png`;
        a.click();
        URL.revokeObjectURL(url);
      });
    } catch (err) {
      console.error("PNG export failed:", err);
      alert("Export failed. Ensure html2canvas is installed.");
    }
  };

  return (
    <div style={{ width: "100%", boxSizing: "border-box" }} className="enhanced-forecast-root">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Defect Trends (Forecast)</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button onClick={exportCSV} style={{ padding: "8px 16px", cursor: "pointer", border: "none", borderRadius: 9999, background: "#1e3a8a",color:"white",fontWeight: 500, flexShrink: 0 }}>
            Export CSV
          </button>
          <button onClick={exportPNG} style={{ padding: "8px 16px", cursor: "pointer", border: "none", borderRadius: 9999, background: "#1e3a8a",color:"white",fontWeight: 500, flexShrink: 0 }}>
            Export PNG
          </button>
        </div>
      </div>

      {/* Label filters */}
      <div style={{ marginBottom: 16 }}>
        <span style={{ marginRight: 12, fontWeight: 600 }}>Labels:</span>
        {allLabels.map(label => (
          <button
            key={label}
            onClick={() => toggleLabel(label)}
            style={{
              padding: "6px 12px",
              marginRight: 8,
              marginBottom: 8,
              border: "none",
              borderRadius: 20,
              cursor: "pointer",
              background: selectedLabels.has(label) ? "#1f77b4" : "#e5e7eb",
              color: selectedLabels.has(label) ? "white" : "#374151",
              fontWeight: 500,
              transition: "all 0.2s"
            }}
          >
            {label}
          </button>
        ))}
        <button onClick={() => setSelectedLabels(new Set(allLabels))} style={{ padding: "8px 16px", marginRight: 8, cursor: "pointer", border: "none", borderRadius: 9999, background: "#1e3a8a", color:"white", fontWeight:500 }}>
          Show all
        </button>
        <button onClick={() => setSelectedLabels(new Set())} style={{ padding: "8px 16px", marginRight: 8, cursor: "pointer", border: "none", borderRadius: 9999, background: "#1e3a8a", color:"white", fontWeight:500 }}>
          Clear
        </button>
      </div>

      {/* Chart */}
      <div id="forecast-chart-container" style={{ width: "100%", maxHeight:420, border: "1px solid #e5e7eb", borderRadius: 8, background: "white", boxSizing: "border-box", overflow: "auto" }}>
       <div style={{ minWidth: `${Math.max(840, (sprints?.length || 4) * 140)}px`, height: 400, padding: 16, boxSizing: "border-box" }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 25 }}>
            <CartesianGrid strokeDasharray="3 3"/>
            <XAxis dataKey="sprint"/>
            <YAxis/>
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            {/* Render one solid + one dashed line per label, but on shared chartData */}
            {Array.from(selectedLabels).map((label, i) => {
              const color = COLORS[i % COLORS.length];
              
              return (
                <React.Fragment key={label}>
                  {/* Single unified line - we'll use CSS/SVG trick */}
                  <Line
                    type="monotone"
                    dataKey={label}
                    stroke={color}
                    strokeWidth={2}
                    dot={{ r: 4, fill: color }}
                    connectNulls
                    name={label}
                  />
                </React.Fragment>
              );
            })}
          </LineChart>
        </ResponsiveContainer>
       </div>
      </div>

      {/* Tabs */}
      <div style={{ marginTop: 24, borderBottom: "2px solid #e5e7eb" }}>
        <button
          onClick={() => setActiveTab("summary")}
          style={{
            padding: "12px 24px",
            border: "none",
            borderBottom: activeTab === "summary" ? "2px solid #1f77b4" : "2px solid transparent",
            background: "transparent",
            cursor: "pointer",
            fontWeight: activeTab === "summary" ? 600 : 400,
            color: activeTab === "summary" ? "#1f77b4" : "#6b7280"
          }}
        >
          📊 Executive Summary
        </button>
        <button
          onClick={() => setActiveTab("comparison")}
          style={{
            padding: "12px 24px",
            border: "none",
            borderBottom: activeTab === "comparison" ? "2px solid #1f77b4" : "2px solid transparent",
            background: "transparent",
            cursor: "pointer",
            fontWeight: activeTab === "comparison" ? 600 : 400,
            color: activeTab === "comparison" ? "#1f77b4" : "#6b7280"
          }}
        >
          📈 Time Comparison
        </button>
        <button
          onClick={() => setActiveTab("rootcause")}
          style={{
            padding: "12px 24px",
            border: "none",
            borderBottom: activeTab === "rootcause" ? "2px solid #1f77b4" : "2px solid transparent",
            background: "transparent",
            cursor: "pointer",
            fontWeight: activeTab === "rootcause" ? 600 : 400,
            color: activeTab === "rootcause" ? "#1f77b4" : "#6b7280"
          }}
        >
          🔍 Root Cause Analysis
        </button>
      </div>

      {/* Tab Content */}
      <div style={{ marginTop: 16, boxSizing: "border-box", width: "100%" }}>
        {activeTab === "summary" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
            {/* Health Score */}
            <div style={{ padding: 20, border: "1px solid #e5e7eb", borderRadius: 8, background: "white" }}>
              <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 8 }}>Overall Health Score</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 60, height: 60, borderRadius: "50%", background: healthColor, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: "white" }}>{healthScore}</span>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>out of 100</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    Forecast Confidence: {forecastConfidence}%
                  </div>
                </div>
              </div>
            </div>

            {/* Top 3 Risks */}
            <div style={{ padding: 20, border: "1px solid #e5e7eb", borderRadius: 8, background: "white" }}>
              <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#ef4444", fontSize: 18 }}>🔴</span>
                <span style={{ fontWeight: 600 }}>Top 3 Risks</span>
              </div>
              {risks.length === 0 ? (
                <div style={{ color: "#9ca3af", fontSize: 13 }}>No significant risks detected</div>
              ) : (
                risks.map((risk, i) => (
                  <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < risks.length - 1 ? "1px solid #f3f4f6" : "none" }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{risk.label}</div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{risk.type}</div>
                    <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 600, marginTop: 4 }}>{risk.percentage}</div>
                  </div>
                ))
              )}
            </div>

            {/* Top 3 Wins */}
            <div style={{ padding: 20, border: "1px solid #e5e7eb", borderRadius: 8, background: "white" }}>
              <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#22c55e", fontSize: 18 }}>🟢</span>
                <span style={{ fontWeight: 600 }}>Top 3 Wins</span>
              </div>
              {wins.length === 0 ? (
                <div style={{ color: "#9ca3af", fontSize: 13 }}>No significant improvements yet</div>
              ) : (
                wins.map((win, i) => (
                  <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < wins.length - 1 ? "1px solid #f3f4f6" : "none" }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{win.label}</div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{win.type}</div>
                    <div style={{ fontSize: 13, color: "#22c55e", fontWeight: 600, marginTop: 4 }}>{win.percentage}</div>
                  </div>
                ))
              )}
            </div>

            {/* Recommendations (full width) */}
            <div style={{ gridColumn: "1 / -1", padding: 20, border: "1px solid #e5e7eb", borderRadius: 8, background: "white" }}>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recommended Actions</div>
              {recommendations.map((rec, i) => (
                <div key={i} style={{ 
                  marginBottom: 8, 
                  padding: "10px 12px", 
                  borderRadius: 6,
                  background: rec.type === "success" ? "#f0fdf4" : "#fef3c7",
                  border: `1px solid ${rec.type === "success" ? "#86efac" : "#fde047"}`
                }}>
                  <div style={{ fontSize: 14, color: "#374151" }}>{rec.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "comparison" && (
          <div style={{ padding: 20, border: "1px solid #e5e7eb", borderRadius: 8, background: "white" }}>
            <h3 style={{ marginTop: 0, marginBottom: 16 }}>Sprint-over-Sprint Trend Analysis</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f9fafb", borderBottom: "2px solid #e5e7eb" }}>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>Label</th>
                    <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600 }}>Last Actual</th>
                    <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600 }}>Next Forecast</th>
                    <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600 }}>Change</th>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {timeComparisonData.map((row, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 500 }}>{row.label}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>{row.lastActual}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>{row.firstForecast}</td>
                      <td style={{ 
                        padding: "12px 16px", 
                        textAlign: "right",
                        color: row.change.startsWith("+") ? "#ef4444" : row.change.startsWith("-") ? "#22c55e" : "#6b7280",
                        fontWeight: 600
                      }}>
                        {row.change}
                      </td>
                      <td style={{ padding: "12px 16px" }}>{row.trend}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div style={{ marginTop: 20, padding: 16, background: "#f9fafb", borderRadius: 6, border: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Key Insights</div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#374151" }}>
                {timeComparisonData.filter(d => parseFloat(d.change) > 30).length > 0 && (
                  <li style={{ marginBottom: 4 }}>
                    <b>{timeComparisonData.filter(d => parseFloat(d.change) > 30).length}</b> categories showing significant increase (&gt;30%)
                  </li>
                )}
                {timeComparisonData.filter(d => parseFloat(d.change) < -20).length > 0 && (
                  <li style={{ marginBottom: 4 }}>
                    <b>{timeComparisonData.filter(d => parseFloat(d.change) < -20).length}</b> categories improving (decrease &gt;20%)
                  </li>
                )}
                {timeComparisonData.filter(d => Math.abs(parseFloat(d.change)) <= 20).length > 0 && (
                  <li>
                    <b>{timeComparisonData.filter(d => Math.abs(parseFloat(d.change)) <= 20).length}</b> categories showing stable trends
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}

        {activeTab === "rootcause" && (
          <div style={{ padding: 20, border: "1px solid #e5e7eb", borderRadius: 8, background: "white" }}>
            <h3 style={{ marginTop: 0, marginBottom: 16 }}>Root Cause Distribution</h3>
            
            {/* Simple bar chart visualization */}
            <div style={{ marginBottom: 24 }}>
              {rootCauseData.map((item, i) => (
                <div key={i} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{item.cause}</span>
                    <span style={{ fontSize: 14, color: "#6b7280" }}>{item.count} issues ({item.percentage})</span>
                  </div>
                  <div style={{ width: "100%", height: 24, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ 
                      width: item.percentage, 
                      height: "100%", 
                      background: `hsl(${200 - i * 30}, 70%, 50%)`,
                      transition: "width 0.3s ease"
                    }} />
                  </div>
                </div>
              ))}
            </div>

            <div style={{ padding: 16, background: "#fef3c7", borderRadius: 6, border: "1px solid #fde047" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>💡 Actionable Recommendations</div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#374151" }}>
                <li style={{ marginBottom: 6 }}>Focus code reviews on modules with highest Code Quality Issues</li>
                <li style={{ marginBottom: 6 }}>Schedule requirements clarification sessions with stakeholders</li>
                <li style={{ marginBottom: 6 }}>Enhance integration testing coverage for API endpoints</li>
                <li>Standardize environment setup with infrastructure-as-code</li>
              </ul>
            </div>

            <div style={{ marginTop: 20, fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
              Note: Root cause analysis is based on historical defect metadata. Update issue root_cause fields in Jira for more accurate insights.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}