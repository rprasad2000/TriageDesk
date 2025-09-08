import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../src/api";

export default function Train() {
  const [csvPath, setCsvPath] = useState("data/QA_Defects_Issues.csv");

  const mJira = useMutation({
    mutationFn: () => api.post("/train/jira", { max_results: 200 }).then(r => r.data),
  });

  const mCsv = useMutation({
    mutationFn: () => api.post("/train/csv", { csv_path: csvPath }).then(r => r.data),
  });

  // Helper: Parse classification report into structured rows
  // Helper: Parse classification report into structured rows
const parseReport = (reportText: string) => {
  const lines = reportText.split("\n").map(l => l.trim()).filter(Boolean);

  const headers = ["Class", "Precision", "Recall", "F1-Score", "Support"];
  const rows: string[][] = [];
  const summary: string[][] = [];

  for (let line of lines) {
    // Match summary rows explicitly
    if (/^(micro|macro|weighted) avg/.test(line)) {
      const parts = line.split(/\s+/);
      summary.push([
        parts.slice(0, 2).join(" "), // e.g. "micro avg"
        parts[2] || "-",
        parts[3] || "-",
        parts[4] || "-",
        parts[5] || "-"
      ]);
    } else {
      // Normal class rows (handle spaces in class names)
      const parts = line.split(/\s+/);
      if (parts.length >= 5) {
        const cls = parts.slice(0, parts.length - 4).join(" "); // merge back spaces
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
        maxHeight: "500px",
        overflowY: "auto",
        border: "1px solid #ccc",
        borderRadius: "6px",
        padding: "1rem",
        background: "#fafafa",
      }}
    >
      <h4>{message}</h4>
      <p>
        <b>Trained:</b> {trained ? "✅ Yes" : "❌ No"}
      </p>
      <p>
        <b>Accuracy:</b> {accuracy ? (accuracy * 100).toFixed(2) + "%" : "-"}
      </p>
      <p>
        <b>Samples:</b> {n_samples}
      </p>

      <div>
        <b>Classes:</b>
        <ul>
          {classes?.map((c: string) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>

      {parsed && (
        <div style={{ marginTop: "1rem" }}>
          <h5>Classification Report</h5>

          {/* Class-wise metrics */}
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
              marginBottom: "1rem",
            }}
          >
            <thead style={{ background: "#f5f5f5" }}>
              <tr>
                {parsed.headers.map((h, i) => (
                  <th
                    key={i}
                    style={{
                      border: "1px solid #ddd",
                      padding: "6px",
                      fontWeight: "bold",
                    }}
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
                      style={{
                        border: "1px solid #ddd",
                        padding: "6px",
                        whiteSpace: "nowrap",
                      }}
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
            <div>
              <h6>Summary Averages</h6>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  textAlign: "left",
                }}
              >
                <thead style={{ background: "#f5f5f5" }}>
                  <tr>
                    {parsed.headers.map((h, i) => (
                      <th
                        key={i}
                        style={{
                          border: "1px solid #ddd",
                          padding: "6px",
                          fontWeight: "bold",
                        }}
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
                        <td
                          key={j}
                          style={{
                            border: "1px solid #ddd",
                            padding: "6px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};


  return (
    <div>
      <h2>Train</h2>

      <div className="card">
        <h3>Train from Jira</h3>
        <button
          type="button"
          className="btn btn-primary btn-pill"
          onClick={() => mJira.mutate()}
          disabled={mJira.isPending}
        >
          {mJira.isPending ? <><span className="spinner" /> Training...</> : "Train from Jira"}
        </button>

        {renderResult(mJira.data)}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Train from CSV (Developer Only)</h3>
        <input
          value={csvPath}
          onChange={(e) => setCsvPath(e.target.value)}
          className="csv-input"
          style={{ marginRight: "0.5rem" }}
        />

        <button
          type="button"
          className="btn btn-primary btn-pill"
          onClick={() => mCsv.mutate()}
          disabled={mCsv.isPending}
        >
          {mCsv.isPending ? <><span className="spinner" /> Training...</> : "Train from CSV"}
        </button>

        {renderResult(mCsv.data)}
      </div>
    </div>
  );
}
