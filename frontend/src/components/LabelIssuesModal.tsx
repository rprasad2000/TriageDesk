// src/components/LabelIssuesModal.tsx
import React, { useEffect, useState } from "react";
import { getLabelIssues } from "../api";

interface Issue {
  issue_key: string;
  summary: string;
  status: string;
  priority: string;
  severity: string;
  created: string;
  url: string;
  sprint: string;
}

interface Props {
  label: string | null;
  onClose: () => void;
}

export default function LabelIssuesModal({ label, onClose }: Props) {
  const [status, setStatus] = useState<"open" | "closed" | "both">("open");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!label) return;
    setLoading(true);
    getLabelIssues(label, status)
      .then((res) => setIssues(res.issues || []))
      .catch((e) => console.error("Failed to fetch label issues:", e))
      .finally(() => setLoading(false));
  }, [label, status]);

  if (!label) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-panel"
        style={{ width: "min(1200px, 96%)", maxHeight: "80vh", overflow: "auto" }}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <h3 style={{ marginTop: 0 }}>
          {label} — Issues &nbsp;
          <small style={{ color: "#666" }}>
            ({issues.length} {status})
          </small>
        </h3>

        {/* Toggle */}
        <div style={{ marginBottom: 12 }}>
          <label>Status:</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
            style={{ marginLeft: 8 }}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="both">Both</option>
          </select>
        </div>

        {/* Table */}
        {loading ? (
          <div>Loading...</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "#fafafa", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ padding: 8 }}>Issue</th>
                <th style={{ padding: 8 }}>Summary</th>
                <th style={{ padding: 8 }}>Priority</th>
                <th style={{ padding: 8 }}>Severity</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Sprint</th>
                <th style={{ padding: 8 }}>Created</th>
                <th style={{ padding: 8 }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((it) => (
                <tr key={it.issue_key}>
                  <td style={{ padding: 8 }}>{it.issue_key}</td>
                  <td style={{ padding: 8, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.summary}
                  </td>
                  <td style={{ padding: 8 }}>{it.priority}</td>
                  <td style={{ padding: 8 }}>{it.severity}</td>
                  <td style={{ padding: 8 }}>{it.status}</td>
                  <td style={{ padding: 8 }}>{it.sprint || "-"}</td>
                  <td style={{ padding: 8 }}>{it.created}</td>
                  <td style={{ padding: 8 }}>
                    <a className="btn-jira" href={it.url} target="_blank" rel="noreferrer" title="Open in Jira">➤</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
