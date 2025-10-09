// frontend/src/pages/Retrain.tsx
import React from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../src/api";

/**
 * Helper: Parse sklearn-style classification report text into structured rows + summary.
 * (Copied/adapted from Train.tsx)
 */
const parseReport = (reportText: string) => {
  const lines = reportText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const headers = ["Class", "Precision", "Recall", "F1-Score", "Support"];
  const rows: string[][] = [];
  const summary: string[][] = [];

  for (let line of lines) {
    // Recognize summary rows like "micro avg", "macro avg", "weighted avg"
    if (/^(micro|macro|weighted)\s+avg/.test(line)) {
      const parts = line.split(/\s+/);
      summary.push([
        parts.slice(0, 2).join(" "), // e.g. "micro avg"
        parts[2] || "-",
        parts[3] || "-",
        parts[4] || "-",
        parts[5] || "-",
      ]);
    } else {
      // Class rows — handle class names that contain spaces
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

          {/* Class-wise metrics */}
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

          {/* Summary averages */}
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
  const mRetrain = useMutation({
    mutationFn: () => api.post("/retrain").then((r) => r.data),
  });

  return (
    <div style={{ padding: "1.5rem" }}>
      <h2>Retrain</h2>

      <div style={{ marginTop: 12 }}>
        <button
          onClick={() => mRetrain.mutate()}
          disabled={mRetrain.isPending}
          className="btn-recs"
          type="button"
        >
          {mRetrain.isPending ? (
            <>
              <span className="spinner" /> Retraining…
            </>
          ) : (
            "Retrain with Feedback"
          )}
        </button>
      </div>

      <div>{mRetrain.data ? renderResult(mRetrain.data) : null}</div>

      {/* Fallback: if result is unexpected shape, show JSON for debugging */}
      {mRetrain.data && typeof mRetrain.data !== "object" && (
        <pre style={{ marginTop: 12 }}>{JSON.stringify(mRetrain.data, null, 2)}</pre>
      )}
    </div>
  );
}
