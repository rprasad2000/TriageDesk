// src/pages/Dashboard.tsx
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getDashboard } from "../api";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export default function Dashboard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => getDashboard(),
  });

  if (isLoading) return <p>Loading dashboard...</p>;
  if (isError) {
    console.error(error);
    return <p style={{ color: "crimson" }}>Failed to load dashboard</p>;
  }

  const sprintData = data?.sprints || [];
  const quarterData = data?.quarters || [];
  const incidents = data?.incidents || [];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ textAlign: "center" }}>Defect Dashboard</h2>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: "#fff", padding: 12, borderRadius: 6, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
          <h4>Bugs by Period</h4>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sprintData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={sprintData[0]?.label ? "label" : "period"} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="count" stroke="#8884d8" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ background: "#fff", padding: 12, borderRadius: 6, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
          <h4>Bugs by Quarter</h4>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={quarterData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="count" stroke="#82ca9d" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{
          width: "95%",
          maxWidth: 1200,
          border: "1px solid #e6e6e6",
          borderRadius: 6,
          overflow: "hidden",
          boxShadow: "0 2px 8px rgba(0,0,0,0.05)"
        }}>
          <div style={{ padding: 12, background: "#fafafa", borderBottom: "1px solid #eee" }}>
            <strong>All Incidents</strong> — {incidents.length} records
          </div>
          <div style={{ maxHeight: "56vh", overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead style={{ position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
                <tr>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>#</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Incident No.</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Created</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Priority</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Brief</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Status</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Severity</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Prediction</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Confidence</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Sprint</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((it: any, idx: number) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: 8 }}>{idx + 1}</td>
                    <td style={{ padding: 8 }}>{it.incident_no}</td>
                    <td style={{ padding: 8 }}>{it.creation_time}</td>
                    <td style={{ padding: 8 }}>{it.priority}</td>
                    <td style={{ padding: 8, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.brief_detail}</td>
                    <td style={{ padding: 8 }}>{it.status}</td>
                    <td style={{ padding: 8 }}>{it.severity}</td>
                    <td style={{ padding: 8 }}>{it.prediction || "-"}</td>
                    <td style={{ padding: 8 }}>{it.confidence_score ? `${it.confidence_score}%` : "-"}</td>
                    <td style={{ padding: 8 }}>{it.Sprint || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  );
}