import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, trainUpload } from "../src/api";

export default function Train() {
  const [csvPath, setCsvPath] = useState("data/QA_Defects_Issues.csv");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  const mJira = useMutation({
    mutationFn: () => api.post("/train/jira", { max_results: 200 }).then(r => r.data),
  });

  const mCsv = useMutation({
    mutationFn: () => api.post("/train/csv", { csv_path: csvPath }).then(r => r.data),
  });

  const mUpload = useMutation({
    mutationFn: (file: File) => trainUpload(file),
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFile(file);
    }
  };

  const handleUploadTrain = () => {
    if (!uploadedFile) {
      alert("Please select a CSV file first");
      return;
    }
    mUpload.mutate(uploadedFile);
  };

  // Helper: Parse classification report into structured rows
  const parseReport = (reportText: string) => {
    const lines = reportText.split("\n").map(l => l.trim()).filter(Boolean);

    const headers = ["Class", "Precision", "Recall", "F1-Score", "Support"];
    const rows: string[][] = [];
    const summary: string[][] = [];

    for (let line of lines) {
      if (/^(micro|macro|weighted) avg/.test(line)) {
        const parts = line.split(/\s+/);
        summary.push([
          parts.slice(0, 2).join(" "),
          parts[2] || "-",
          parts[3] || "-",
          parts[4] || "-",
          parts[5] || "-"
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

      {/* Train from Jira */}
      <div className="card">
        <h3>Train from Jira</h3>
        <button
          type="button"
          className="btn-recs"
          onClick={() => mJira.mutate()}
          disabled={mJira.isPending}
        >
          {mJira.isPending ? <><span className="spinner" /> Training...</> : "Train from Jira"}
        </button>

        {renderResult(mJira.data)}
      </div>

      {/* Train from Server CSV */}
      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Train from Server Data (Developer Only)</h3>
        <input
          value={csvPath}
          onChange={(e) => setCsvPath(e.target.value)}
          className="csv-input"
          style={{ marginRight: "0.5rem" }}
        />

        <button
          type="button"
          className="btn-recs"
          onClick={() => mCsv.mutate()}
          disabled={mCsv.isPending}
        >
          {mCsv.isPending ? <><span className="spinner" /> Training...</> : "Train from Server CSV"}
        </button>

        {renderResult(mCsv.data)}
      </div>

      {/* Upload CSV */}
      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Upload & Train from CSV 📁</h3>
        
        <div style={{ marginBottom: "0.75rem", padding: "0.75rem", background: "#f0f9ff", borderRadius: 6, border: "1px solid #bfdbfe" }}>
          <strong style={{ fontSize: 13 }}>📋 Required CSV Columns:</strong>
          <ul style={{ marginTop: 6, marginBottom: 0, fontSize: 13, lineHeight: 1.6 }}>
            <li><code>Issue Key</code> or <code>issue_key</code></li>
            <li><code>Summary</code></li>
            <li><code>Description</code> or <code>ticket_description</code></li>
          </ul>
          <div style={{ marginTop: 8, fontSize: 12, color: "#475569" }}>
            Optional: Labels, Priority, Severity, Status, Root Cause, Sprint
          </div>
        </div>

        <input
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          style={{ marginRight: "0.5rem" }}
        />

        {uploadedFile && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#334155" }}>
            Selected: <strong>{uploadedFile.name}</strong> ({(uploadedFile.size / 1024).toFixed(1)} KB)
          </div>
        )}

        <button
          type="button"
          className="btn-recs"
          onClick={handleUploadTrain}
          disabled={mUpload.isPending || !uploadedFile}
          style={{ marginTop: "0.75rem" }}
        >
          {mUpload.isPending ? <><span className="spinner" /> Training...</> : "Train from Uploaded CSV"}
        </button>

        {renderResult(mUpload.data)}
      </div>
    </div>
  );
}