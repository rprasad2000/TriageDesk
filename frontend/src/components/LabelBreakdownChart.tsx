// src/components/LabelBreakdownChart.tsx
import React from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";

type LabelItem = {
  name: string;
  open: number;
  closed: number;
  total: number;
};

interface Props {
  labels: LabelItem[];
  onShowList: (label: string) => void;
}



export default function LabelBreakdownChart({ labels, onShowList }: Props) {
  const perLabelPx = 80;
  const innerWidth = Math.max(labels.length * perLabelPx, 600);

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8 }}>
      <h3 style={{ margin: "0 0 8px" }}>Label Classification — Open vs Closed</h3>

      {/* alignItems:flex-start prevents right list from stretching the container vertically */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {/* Chart column: show horizontal scroll, hide any vertical scroll on this area */}
        <div
          style={{
            flex: 1,
            minWidth: 0,                   // allow the overflow wrapper to work
            overflowX: "auto",             // <- horizontal scrollbar shown here
            overflowY: "hidden",
            paddingBottom: 8,              // provide little room for the scrollbar
          }}
        >
          <div style={{ width: innerWidth, height: 320 }}>
            <ResponsiveContainer width={innerWidth} height="100%">
              <BarChart data={labels} margin={{ left: 12, right: 24, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="open" stackId="a" fill="#82ca9d" />
                <Bar dataKey="closed" stackId="a" fill="#8884d8" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Side list */}
        <div style={{ width: 260 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {labels.map((l) => (
              <div
                key={l.name}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 4px",
                  borderRadius: 6,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, color: "#666" }}>{l.name}</div>
                  <div style={{ fontWeight: 700, fontSize: 18 }}>{l.total}</div>
                </div>
                <div>
                  <button className="btn-recs" onClick={() => onShowList(l.name)} aria-label={`Show list for ${l.name}`}>
                    Show list
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

