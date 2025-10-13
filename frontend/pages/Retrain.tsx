// frontend/src/pages/Retrain.tsx
import React, { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getFeedbackSummary, clearFeedback } from "../src/api";

const parseReport = (reportText: string) => {
  const lines = reportText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const headers = ["Class", "Precision", "Recall", "F1-Score", "Support"];
  const rows: string[][] = [];
  const summary: string[][] = [];

  for (let line of lines) {
    if (/^(micro|macro|weighted)\s+avg/.test(line)) {
      const parts = line.split(/\s+/);
      summary.push([
        parts.slice(0, 2).join(" "),
        parts[2] || "-",
        parts[3] || "-",
        parts[4] || "-",
        parts[5] || "-",
      ]);
    } else {
      const parts = line.split(/\s+/);
      if (parts.length >= 5) {
        const cls = parts.slice(0, parts.length - 4).join(" ");
        const metrics = parts.slice(-4);
        rows.push([cls, ...metrics]);
      }
    }
  }

  return { headers, rows, summary };
};

const renderResult = (data: any) => {
  if (!data) return null;
  const { message, trained, classes, n_samples, metrics } = data;
  const { accuracy, report } = metrics || {};
  const parsed = report ? parseReport(report) : null;

  return (
    <div
      style={{
        marginTop: "1rem",
        maxHeight: "520px",
        overflowY: "auto",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "1rem",
        background: "#fafafa",
      }}
    >
      <h4 style={{ marginTop: 0 }}>{message || "Retrain result"}</h4>

      <p style={{ margin: "8px 0" }}>
        <b>Trained:</b> {trained ? "✅ Yes" : "❌ No"}
      </p>

      <p style={{ margin: "8px 0" }}>
        <b>Accuracy:</b>{" "}
        {typeof accuracy === "number" ? (accuracy * 100).toFixed(2) + "%" : "-"}
      </p>

      <p style={{ margin: "8px 0" }}>
        <b>Samples:</b> {n_samples ?? "-"}
      </p>

      <div style={{ marginTop: 8 }}>
        <b>Classes:</b>
        <ul style={{ marginTop: 6 }}>
          {Array.isArray(classes) && classes.length > 0 ? (
            classes.map((c: string) => <li key={c}>{c}</li>)
          ) : (
            <li>-</li>
          )}
        </ul>
      </div>

      {parsed && (
        <div style={{ marginTop: "1rem" }}>
          <h5 style={{ marginBottom: 8 }}>Classification Report</h5>

          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", marginBottom: 12 }}>
            <thead style={{ background: "#f5f7fa" }}>
              <tr>
                {parsed.headers.map((h, i) => (
                  <th
                    key={i}
                    style={{ border: "1px solid #e6e6e6", padding: 8, fontWeight: 700, fontSize: 13 }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row: string[], i: number) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      style={{ border: "1px solid #eee", padding: 8, whiteSpace: "nowrap", fontSize: 13 }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {parsed.summary.length > 0 && (
            <>
              <h6 style={{ marginTop: 8, marginBottom: 6 }}>Summary Averages</h6>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead style={{ background: "#f5f7fa" }}>
                  <tr>
                    {parsed.headers.map((h, i) => (
                      <th
                        key={i}
                        style={{ border: "1px solid #e6e6e6", padding: 8, fontWeight: 700 }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.summary.map((row: string[], i: number) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} style={{ border: "1px solid #eee", padding: 8, whiteSpace: "nowrap" }}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default function Retrain() {
  const queryClient = useQueryClient();

  // Fetch feedback summary
  const { data: feedbackData, refetch: refetchFeedback } = useQuery({
    queryKey: ["feedbackSummary"],
    queryFn: getFeedbackSummary,
    staleTime: 5000,
  });

  const mRetrain = useMutation({
    mutationFn: () => api.post("/retrain").then((r) => r.data),
    onSuccess: () => {
      // Refresh feedback summary after retrain
      refetchFeedback();
    }
  });

  const mClear = useMutation({
    mutationFn: clearFeedback,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feedbackSummary"] });
    }
  });

  const fbCount = feedbackData?.count || 0;
  const fbLabels = feedbackData?.labels || [];

  return (
    <div style={{ padding: "1.5rem" }}>
      <h2>Retrain</h2>

      {/* Feedback Summary Card */}
      <div className="card" style={{ marginTop: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Pending Feedback</h3>
        
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            Total: <span style={{ color: fbCount > 0 ? "#0b5d9d" : "#666" }}>{fbCount}</span> entries
          </div>
          
          {fbCount > 0 && (
            <button
              onClick={() => mClear.mutate()}
              disabled={mClear.isPending}
              className="btn btn-ghost"
              type="button"
              style={{ marginLeft: "auto" }}
            >
              {mClear.isPending ? "Clearing..." : "Clear All"}
            </button>
          )}
        </div>

        {fbLabels.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h4 style={{ fontSize: 14, marginBottom: 8 }}>Label Breakdown:</h4>
            <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 500 }}>
              <thead style={{ background: "#f5f5f5" }}>
                <tr>
                  <th style={{ border: "1px solid #ddd", padding: 8, textAlign: "left" }}>Label</th>
                  <th style={{ border: "1px solid #ddd", padding: 8, textAlign: "center", width: 80 }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {fbLabels.map((item: any, idx: number) => (
                  <tr key={idx}>
                    <td style={{ border: "1px solid #ddd", padding: 8 }}>{item.label}</td>
                    <td style={{ border: "1px solid #ddd", padding: 8, textAlign: "center" }}>{item.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {fbCount === 0 && (
          <div style={{ padding: 12, color: "#666", fontStyle: "italic" }}>
            No feedback entries yet. Go to Predict page and save corrected labels.
          </div>
        )}
      </div>

      {/* Retrain Button */}
      <div style={{ marginTop: 12 }}>
        <button
          onClick={() => mRetrain.mutate()}
          disabled={mRetrain.isPending || fbCount === 0}
          className="btn-recs"
          type="button"
        >
          {mRetrain.isPending ? (
            <>
              <span className="spinner" /> Retraining…
            </>
          ) : (
            `Retrain with Feedback (${fbCount})`
          )}
        </button>
      </div>

      {/* Retrain Results */}
      <div>{mRetrain.data ? renderResult(mRetrain.data) : null}</div>
    </div>
  );
}