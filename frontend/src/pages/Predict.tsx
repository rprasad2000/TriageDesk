// frontend/src/pages/Predict.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient  } from "@tanstack/react-query";
import { predict, feedback, getSprints, getIssues, predictBulk, feedbackBulk, PredictResponse, getSprintsLive, syncJira } from "../api";

type IssueRow = {
  issue_key: string;
  summary?: string;
  brief_detail?: string;
  ticket_description?: string;
  description?: string;
  priority?: string;
  severity?: string;
  status?: string;
  prediction?: string;
  confidence_score?: number; // in [0,1] or percent depending on backend
  recommendations?: any[];
  Sprint?: string;
};

export default function Predict() {
  
  // Single-text quick classify (existing)
  const [text, setText] = useState<string>("Login page throws exception when submitting invalid email format.");
  const [topk, setTopk] = useState<number>(5);

  const singlePred = useMutation<PredictResponse, Error, void>({
    mutationFn: async () => {
      return await predict(text, topk);
    },
  });

  const singleFb = useMutation<any, Error, { true_label: string }>({
    mutationFn: async (p) => {
      return await feedback(text, p.true_label);
    },
  });

  /* --- New: Sprint-based bulk prediction (use cached live sprints) --- */
  const { data: sprints = [], isLoading: sprintsLoading, refetch: refetchSprints } = useQuery<string[]>({
    queryKey: ["sprints"],
    queryFn: () => getSprintsLive(false),
  });


  const [selectedSprint, setSelectedSprint] = useState<string>("");

  useEffect(() => {
    if (!selectedSprint && sprints && sprints.length > 0) setSelectedSprint(sprints[0]);
  }, [sprints, selectedSprint]);

  const {
    data: issuesFromApi = [],
    isLoading: issuesLoading,
    refetch: refetchIssues,
  } = useQuery<IssueRow[]>({
    queryKey: ["issues", selectedSprint],
    queryFn: () => getIssues(selectedSprint, true),
    enabled: !!selectedSprint,
  });

    // --- Jira sync helper state ---
  const [syncing, setSyncing] = useState<boolean>(false);

    const queryClient = useQueryClient();

  const handleRefreshFromJira = async () => {
    if (!window.confirm("Refresh from Jira now? This will fetch latest sprints/issues from Jira.")) return;
    setSyncing(true);
    try {
      // capture current sprint list from react-query cache (may be undefined)
      const prevSprints: string[] = (queryClient.getQueryData(["sprints"]) as string[]) || (sprints || []);
      // start background sync on server
      const startRes = await syncJira(selectedSprint || undefined, true);
      console.info("syncJira start response:", startRes);

      if (!startRes || (startRes.status !== "started" && startRes.status !== "ok" && startRes.status !== "cached")) {
        // If server returned an error-like response, show it (but continue to poll if 'ok')
        alert("Sync request returned: " + JSON.stringify(startRes));
      }

      // Poll for updated sprints (force refresh) up to N attempts
      const maxAttempts = 10;
      const delayMs = 2000;
      let success = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // wait a bit before first poll so the background job gets a chance to run
        await new Promise((res) => setTimeout(res, delayMs));

        // fetch fresh sprints forcing a Jira read/merge
        let fresh: string[] = [];
        try {
          fresh = await getSprintsLive(true);
        } catch (err) {
          console.warn("getSprintsLive failed during polling:", err);
          // continue polling; maybe transient
          fresh = [];
        }

        // If fresh is non-empty and differs from previous, we've updated
        const prevLen = Array.isArray(prevSprints) ? prevSprints.length : 0;
        const freshLen = Array.isArray(fresh) ? fresh.length : 0;
        const pickedUpNew = freshLen !== prevLen || (selectedSprint && fresh.includes(selectedSprint));

        if (pickedUpNew && freshLen > 0) {
          // update react-query cache so your useQuery() sees new sprints immediately
          queryClient.setQueryData(["sprints"], fresh);
          // also refetch the issues for the currently selected sprint (if any)
          if (selectedSprint) {
            // small delay to allow corpus write to complete
            await new Promise((res) => setTimeout(res, 800));
            refetchIssues();
          }
          success = true;
          break;
        }
      }

      if (success) {
        alert("Jira sync completed and sprints refreshed.");
      } else {
        alert("Sync started but new sprints not detected within timeout. Try Refresh again in a few seconds.");
        // still trigger a forced update once more for UI
        try {
          const final = await getSprintsLive(true);
          if (Array.isArray(final) && final.length > 0) queryClient.setQueryData(["sprints"], final);
        } catch (e) {
          // ignore
        }
      }
    } catch (err: any) {
      console.error("Sync from Jira failed:", err);
      alert("Sync failed: " + (err?.message || err));
    } finally {
      setSyncing(false);
    }
  };


  const [issues, setIssues] = useState<IssueRow[]>([]);
  useEffect(() => {
    setIssues(Array.isArray(issuesFromApi) ? issuesFromApi : []);
  }, [issuesFromApi]);

  const [selectedMap, setSelectedMap] = useState<Record<string, boolean>>({});
  const toggleSelect = (key: string) => setSelectedMap((p) => ({ ...p, [key]: !p[key] }));
  const selectAllVisible = (checked: boolean) => {
    const m: Record<string, boolean> = {};
    for (const it of issues) if (it.issue_key) m[it.issue_key] = checked;
    setSelectedMap(m);
  };

  const [fbInputs, setFbInputs] = useState<Record<string, string>>({});
  const setFbInput = (key: string, val: string) => setFbInputs((p) => ({ ...p, [key]: val }));

  // Bulk predict mutation: expects array of issue keys
  const bulkPredictMut = useMutation<
    { predictions: any[] }, // return type from /predict/bulk
    Error,
    string[]
  >({
    mutationFn: async (issueKeys: string[]) => {
      return await predictBulk(issueKeys, undefined, topk);
    },
    onSuccess: (res) => {
      const preds = Array.isArray(res?.predictions) ? res.predictions : [];
      const byKey: Record<string, any> = {};
      for (const p of preds) byKey[p.issue_key] = p;
      setIssues((prev) =>
        prev.map((it) => {
          const k = it.issue_key;
          if (byKey[k]) {
            return {
              ...it,
              prediction: byKey[k].prediction,
              confidence_score: byKey[k].confidence,
              recommendations: byKey[k].recommendations,
            };
          }
          return it;
        })
      );
    },
    onError: (err) => {
      console.error("Bulk predict failed:", err);
      alert("Bulk predict failed: " + err.message);
    },
  });

  const bulkFeedbackMut = useMutation<any, Error, any[]>({
    mutationFn: async (entries) => {
      return await feedbackBulk(entries);
    },
    onSuccess: () => {
      // keep inputs as-is (user can see)
    },
    onError: (err) => {
      console.error("Bulk feedback save failed:", err);
      alert("Failed to save feedback: " + err.message);
    },
  });

  const selectedKeys = useMemo(() => Object.keys(selectedMap).filter((k) => selectedMap[k]), [selectedMap]);

  // Handlers
  const handlePredictSelected = async () => {
    if (selectedKeys.length === 0) return alert("Select one or more issues first.");
    bulkPredictMut.mutate(selectedKeys);
  };

  const handlePredictAllVisible = async () => {
    const keys = issues.map((it) => it.issue_key).filter(Boolean);
    if (keys.length === 0) return alert("No issues to predict.");
    bulkPredictMut.mutate(keys);
    selectAllVisible(true);
  };

  const handleRowPredict = (issue_key: string) => {
    bulkPredictMut.mutate([issue_key]);
    setSelectedMap((p) => ({ ...p, [issue_key]: true }));
  };

  const handleRowFeedback = (issue: IssueRow) => {
    const key = issue.issue_key;
    const label = fbInputs[key];
    if (!label || !label.trim()) return alert("Enter a label to save as feedback.");
    const textFor = issue.ticket_description || issue.description || "";
    bulkFeedbackMut.mutate([{ issue_key: key, text: textFor, true_label: label, source: "user" }]);
  };

  const handleBulkFeedbackFromSelected = () => {
    if (selectedKeys.length === 0) return alert("Select rows to send feedback for.");
    const entries = selectedKeys
      .map((k) => {
        const issue = issues.find((it) => it.issue_key === k) || ({} as IssueRow);
        return {
          issue_key: k,
          text: issue.ticket_description || issue.description || "",
          true_label: fbInputs[k] || "",
        };
      })
      .filter((e) => e.true_label && e.true_label.trim());
    if (entries.length === 0) return alert("Enter labels in the input boxes for selected rows.");
    bulkFeedbackMut.mutate(entries);
  };

  // helper booleans using mutation.status instead of .isLoading to be compatible with your TS definitions
  const singlePredLoading = singlePred.status === "pending";
  const bulkPredictLoading = bulkPredictMut.status === "pending";
  const bulkFeedbackLoading = bulkFeedbackMut.status === "pending";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {/* Left: free-text classifier */}
      <div className="card">
        <h2>Predict (single)</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            singlePred.mutate();
          }}
        >
          <label>Defect text</label>
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          <label>Top-K similar</label>
          <input type="number" value={topk} onChange={(e) => setTopk(parseInt(e.target.value || "1") || 1)} min={1} />
          <div style={{ marginTop: 8 }}>
            <button disabled={singlePredLoading}>{singlePredLoading ? "Classifying…" : "Classify"}</button>
          </div>
        </form>

        {singlePred.isError && <p style={{ color: "crimson" }}>Error: {(singlePred.error as any)?.message}</p>}

        {singlePred.data && (
          <div style={{ marginTop: 12 }}>
            <h3>Result</h3>
            <div>
              <b>Prediction:</b> {singlePred.data.prediction}
            </div>
            <div>
              <b>Confidence:</b> {(singlePred.data.confidence * 100).toFixed(1)}%
            </div>
            <div style={{ marginTop: 8 }}>
              <b>Similar tickets</b>
            </div>
            <div>
              {singlePred.data.recommendations.map((r: any, idx: number) => (
                <div key={idx} style={{ marginBottom: 8, padding: 6, border: "1px solid #eee" }}>
                  <div>
                    <b>{r.issue_key || "(no key)"}</b> — <i>{r.label || "-"}</i>
                  </div>
                  <div>{r.summary}</div>
                  {!!r.url && (
                    <div>
                      <a href={r.url} target="_blank" rel="noreferrer">
                        open
                      </a>
                    </div>
                  )}
                  <small className="mono">similarity: {r.similarity.toFixed(3)}</small>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <input id="fb" placeholder="True label…" />
              <button
                className="secondary"
                onClick={() => {
                  const el = document.getElementById("fb") as HTMLInputElement | null;
                  if (el?.value) {
                    singleFb.mutate({ true_label: el.value });
                  } else {
                    alert("Enter a label");
                  }
                }}
              >
                Send feedback
              </button>
            </div>
            {singleFb.isSuccess && <small>Thanks — feedback saved.</small>}
          </div>
        )}
      </div>

      {/* Right: Sprint-driven prediction UI */}
      <div className="card">
        <h2>Predict (Sprint)</h2>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <label style={{ marginRight: 6 }}>Sprint:</label>
          <select value={selectedSprint} onChange={(e) => setSelectedSprint(e.target.value)} disabled={syncing || sprintsLoading}>
            <option value="">-- select sprint --</option>
            {sprints.map((s: string) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <button onClick={() => refetchIssues()} disabled={!selectedSprint || issuesLoading} style={{ marginLeft: 8 }}>
            {issuesLoading ? "Loading…" : "Load issues"}
          </button>

          <button
            onClick={handleRefreshFromJira}
            disabled={syncing}
            title="Fetch latest sprints & issues from Jira"
            style={{ marginLeft: 8 }}
          >
            {syncing ? "Syncing…" : "Refresh from Jira"}
          </button>


          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={() => selectAllVisible(true)}>Select all</button>
            <button onClick={() => selectAllVisible(false)}>Clear</button>
            <button onClick={handlePredictSelected} disabled={bulkPredictLoading || selectedKeys.length === 0}>
              {bulkPredictLoading ? "Predicting…" : `Predict selected (${selectedKeys.length})`}
            </button>
            <button onClick={handlePredictAllVisible} disabled={bulkPredictLoading || issues.length === 0}>
              {bulkPredictLoading ? "Predicting…" : "Predict all visible"}
            </button>
          </div>
        </div>

        <div style={{ maxHeight: 420, overflow: "auto", borderTop: "1px solid #eee", paddingTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "#fafafa", position: "sticky", top: 0 }}>
              <tr>
                <th style={{ padding: 6 }}></th>
                <th style={{ padding: 6 }}>Issue</th>
                <th style={{ padding: 6 }}>Summary</th>
                <th style={{ padding: 6 }}>Status</th>
                <th style={{ padding: 6 }}>Severity</th>
                <th style={{ padding: 6 }}>Prediction</th>
                <th style={{ padding: 6 }}>Conf.</th>
                <th style={{ padding: 6 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((it, idx) => (
                <tr key={it.issue_key || idx} style={{ borderBottom: "1px solid #f3f3f3" }}>
                  <td style={{ padding: 6, width: 28 }}>
                    <input type="checkbox" checked={!!selectedMap[it.issue_key]} onChange={() => toggleSelect(it.issue_key)} />
                  </td>
                  <td style={{ padding: 6, whiteSpace: "nowrap" }}>{it.issue_key}</td>
                  <td style={{ padding: 6, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>{it.summary || it.brief_detail}</td>
                  <td style={{ padding: 6 }}>{it.status || "-"}</td>
                  <td style={{ padding: 6 }}>{it.severity || "-"}</td>
                  <td style={{ padding: 6 }}>{it.prediction || "-"}</td>
                  <td style={{ padding: 6 }}>
                    {it.confidence_score
                      ? typeof it.confidence_score === "number" && it.confidence_score <= 1
                        ? `${(it.confidence_score * 100).toFixed(2)}%`
                        : String(it.confidence_score)
                      : "-"}
                  </td>
                  <td style={{ padding: 6, display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={() => handleRowPredict(it.issue_key)}>Predict</button>
                    <input
                      placeholder="Correct label"
                      value={fbInputs[it.issue_key] || ""}
                      onChange={(e) => setFbInput(it.issue_key, e.target.value)}
                      style={{ width: 130 }}
                    />
                    <button onClick={() => handleRowFeedback(it)}>Save</button>
                    {!!it.recommendations?.length && (
                      <details style={{ marginLeft: 6 }}>
                        <summary style={{ cursor: "pointer" }}>Recs</summary>
                        <div style={{ padding: 6 }}>
                          {it.recommendations.map((r: any, i: number) => (
                            <div key={i} style={{ marginBottom: 6 }}>
                              <div>
                                <b>{r.issue_key}</b> — {r.summary}
                              </div>
                              <small className="mono">sim: {r.similarity?.toFixed(3)}</small>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button onClick={handleBulkFeedbackFromSelected} disabled={bulkFeedbackLoading || selectedKeys.length === 0}>
            {bulkFeedbackLoading ? "Saving…" : `Save feedback for selected (${selectedKeys.length})`}
          </button>
          <button
            onClick={() => {
              refetchIssues();
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
