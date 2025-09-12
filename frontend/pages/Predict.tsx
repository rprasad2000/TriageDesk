// frontend/src/pages/Predict.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  predict,
  feedback,
  getSprints,
  getIssues,
  predictBulk,
  feedbackBulk,
  PredictResponse,
  getSprintsLive,
  syncJira,
  api,
  postJiraComment,
  postJiraLabels 
} from "../src/api";
const JIRA_HOST = import.meta.env.VITE_JIRA_HOST || "";

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
  confidence_score?: number;
  recommendations?: any[];
  Sprint?: string;
};

export default function Predict() {
  // Single-text quick classify (existing)
  const [text, setText] = useState<string>(
    "Login page throws exception when submitting invalid email format."
  );
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

// const postCommentMut = useMutation<any, Error, { issueKey: string; comment: string }>({
//   mutationFn: ({ issueKey, comment }) => postJiraComment(issueKey, comment),
//   // optimistic UI: set updating flag
//   onMutate: ({ issueKey }) => {
//     setUpdating(issueKey, true);
//     return { issueKey };
//   },
//   onSuccess: (data, variables) => {
//     showMessage(`Comment posted to ${variables.issueKey}.`);
//     // optionally, you may also invalidate queries to refresh issues
//     queryClient.invalidateQueries({ queryKey: ["issues", selectedSprint] });
//   },
//   onError: (err, variables) => {
//     console.error("Failed to post Jira comment", err);
//     showMessage("Failed to post comment: " + (err?.message || "unknown error"));
//   },
//   onSettled: (_data, _err, variables) => {
//     if (variables?.issueKey) setUpdating(variables.issueKey, false);
//   },
// });

 

  /* --- New: Sprint-based bulk prediction (use cached live sprints) --- */

  // small helper — shallow equality for issues arrays so we only set local state when data actually changed.
  const shallowIssuesEqual = (a: IssueRow[] | undefined, b: IssueRow[] | undefined) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;

  // Compare each row's key + the few fields that matter visually: severity, prediction, confidence_score.
  // Keep it cheap: straight loop, no JSON.stringify (avoid allocation churn).
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] || ({} as IssueRow);
    const bi = b[i] || ({} as IssueRow);
    if ((ai.issue_key ?? "") !== (bi.issue_key ?? "")) return false;
    if ((ai.severity ?? "") !== (bi.severity ?? "")) return false;
    if ((ai.prediction ?? "") !== (bi.prediction ?? "")) return false;
    // normalize numeric/percent differences
    const ac = ai.confidence_score == null ? "" : String(ai.confidence_score);
    const bc = bi.confidence_score == null ? "" : String(bi.confidence_score);
    if (ac !== bc) return false;
  }
  return true;
};


  // useQuery for sprints: avoid aggressive refetching to reduce UI churn during sync
  const {
    data: sprints = [],
    isLoading: sprintsLoading,
    refetch: refetchSprints,
  } = useQuery<string[]>({
    queryKey: ["sprints"],
    queryFn: () => getSprintsLive(false),
    staleTime: 30_000, // tolerate 30s staleness during sync
    refetchOnWindowFocus: false,
  });

  const [selectedSprint, setSelectedSprint] = useState<string>("");

  // set default selected sprint once when sprints arrive (do NOT depend on selectedSprint)
  useEffect(() => {
    if (!selectedSprint && Array.isArray(sprints) && sprints.length > 0) {
      setSelectedSprint(sprints[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprints]); // only when sprints list changes

  const {
    data: issuesFromApi = [],
    isLoading: issuesLoading,
    refetch : refetchIssues,
  } = useQuery<IssueRow[]>({
    queryKey: ["issues", selectedSprint],
    queryFn: () => getIssues(selectedSprint, true),
    enabled: !!selectedSprint,
  });

  // --- Jira sync helper state ---
  const [syncing, setSyncing] = useState<boolean>(false);
  const queryClient = useQueryClient();

  // Guard ref to avoid double-starting if strict-mode calls twice (syncing state also guards)
  const syncInProgressRef = useRef(false);

  // DEV: capture unhandled promise rejections to reduce noisy console spam while debugging.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      const onUnhandled = (ev: PromiseRejectionEvent) => {
        // Log reason but do not swallow app errors — useful to spot extension-origin issues.
        console.warn("Unhandled promise rejection captured (dev only):", ev.reason);
      };
      window.addEventListener("unhandledrejection", onUnhandled);
      return () => window.removeEventListener("unhandledrejection", onUnhandled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


    /* ========== In-app confirm / message dialogs ========== */
  // confirm dialog state + resolver ref to allow awaiting user's choice
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [confirmMessage, setConfirmMessage] = useState<string>("");
  const confirmResolveRef = useRef<((val: boolean) => void) | null>(null);

  // message dialog state (informational)
  const [msgOpen, setMsgOpen] = useState<boolean>(false);
  const [msgText, setMsgText] = useState<string>("");

  // Helper to show confirm dialog and await boolean result
  const showConfirm = (message: string): Promise<boolean> => {
    setConfirmMessage(message);
    setConfirmOpen(true);
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
    });
  };

  // Close confirm and resolve
  const _closeConfirm = (ok: boolean) => {
    setConfirmOpen(false);
    // resolve the awaiting promise
    try { confirmResolveRef.current?.(ok); } catch (e) { /* ignore */ }
    confirmResolveRef.current = null;
  };

  // show a simple message dialog
  const showMessage = (text: string) => {
    setMsgText(text);
    setMsgOpen(true);
  };
  const closeMessage = () => setMsgOpen(false);

  // keyboard: ESC closes dialogs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmOpen) _closeConfirm(false);
        if (msgOpen) closeMessage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, msgOpen]);


  const handleRefreshFromJira = async () => {
    // immediate guard so we never start twice (race-safe)
    if (syncInProgressRef.current || syncing) {
      console.warn("Sync already in progress — ignoring duplicate request.");
      return;
    }
    const userOk = await showConfirm("Refresh from Jira now? This will fetch latest sprints/issues from Jira.");
    if (!userOk) return;


    // mark in-progress immediately (prevents double-start)
    syncInProgressRef.current = true;
    setSyncing(true);

    try {
      // capture current sprints snapshot
      const prevSprints: string[] = (queryClient.getQueryData(["sprints"]) as string[]) || (sprints || []);

      // call syncJira and ensure we catch any rejection
      let startRes: any;
      try {
        startRes = await syncJira(selectedSprint || undefined, true);
      } catch (e) {
        console.error("syncJira request failed:", e);
        showMessage("Failed to request Jira sync:");
        return;
      }

      console.info("syncJira start response:", startRes);

      if (!startRes || (startRes.status !== "started" && startRes.status !== "ok" && startRes.status !== "cached")) {
        showMessage("Sync request returned: " + JSON.stringify(startRes));

      }


            // robust polling: compare issue-level content instead of relying on sprints list alone
      const prevMap = new Map<string, { severity?: string; prediction?: string }>();
      for (const it of (issues || [])) {
        if (it && it.issue_key) prevMap.set(it.issue_key, { severity: it.severity, prediction: it.prediction });
      }

      const maxAttempts = 10;
      const delayMs = 2000;
      let success = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // wait before polling (allow backend to finish work)
        await new Promise((res) => setTimeout(res, delayMs));

        // force network fetch of issues (bypass caches)
        try {
          const params: any = {};
          if (selectedSprint) params.sprint = selectedSprint;
          // backend GET /issues respects openOnly param; default behavior is fine, but include explicitly
          params.openOnly = true;

          const resp = await api.get("/issues", {
            params,
            headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          });
          const freshIssues: IssueRow[] = Array.isArray(resp?.data) ? resp.data : [];

          // quick heuristic: if number of issues changed, accept as update
          // if (freshIssues.length !== (issues?.length ?? 0)) {
          //   queryClient.setQueryData(["issues", selectedSprint], freshIssues);
          //   success = true;
          //   break;
          // }
                    if (freshIssues.length !== (issues?.length ?? 0)) {
            // Update react-query cache so subscribers see updated list
            queryClient.setQueryData(["issues", selectedSprint], freshIssues);
            // Also update local component state we render from
            setIssues(Array.isArray(freshIssues) ? [...freshIssues] : []);
            // Ensure hook consumers do a fresh network fetch (defensive)
            try {
              await refetchIssues?.();
            } catch (e) {
              console.warn("refetchIssues failed after sync:", e);
            }
            success = true;
            break;
          }


          // compare per-issue important fields (severity, prediction). If any difference, we have fresh data.
          let foundDiff = false;
          for (const f of freshIssues) {
            if (!f || !f.issue_key) continue;
            const prev = prevMap.get(f.issue_key);
            // if issue didn't exist before or key not in prevMap => new entry
            if (!prev) {
              foundDiff = true;
              break;
            }
            const prevSev = (prev.severity || "").trim();
            const prevPred = (prev.prediction || "").trim();
            const curSev = (f.severity || "").trim();
            const curPred = (f.prediction || "").trim();
            if (prevSev !== curSev || prevPred !== curPred) {
              foundDiff = true;
              break;
            }
          }

          // if (foundDiff) {
          //   // write fresh issues into react-query cache so UI updates immediately
          //   queryClient.setQueryData(["issues", selectedSprint], freshIssues);
          //   // mark stale/invalidate to keep react-query happy
          //   queryClient.invalidateQueries({ queryKey: ["issues", selectedSprint] });
          //   success = true;
          //   break;
          // }

                    if (foundDiff) {
            // write fresh issues into react-query cache so UI updates immediately
            queryClient.setQueryData(["issues", selectedSprint], freshIssues);
            // also update our local `issues` state so rows re-render instantly
            setIssues(Array.isArray(freshIssues) ? [...freshIssues] : []);
            // mark stale/invalidate to keep react-query happy
            queryClient.invalidateQueries({ queryKey: ["issues", selectedSprint] });
            // force a refetch to be 100% sure subscribers get the latest from server
            try {
              await refetchIssues?.();
            } catch (e) {
              console.warn("refetchIssues failed after sync diff:", e);
            }
            success = true;
            break;
          }


          // otherwise continue polling
        } catch (e) {
          console.warn("Polling /issues after sync failed (attempt):", attempt, e);
          // continue polling — backend might still be writing
        }

        // final attempt fallback: if this is last iteration try to force-set sprints if they exist
        if (attempt === maxAttempts - 1) {
          try {
            const finalSprints = await getSprintsLive(true);
            if (Array.isArray(finalSprints) && finalSprints.length > 0) {
              queryClient.setQueryData(["sprints"], finalSprints);
            }
          } catch (ee) {
            // ignore
          }
        }
      }


      if (success) {
        showMessage("Jira sync completed and sprints refreshed.");
      } else {
        showMessage("Sync started but new sprints not detected within timeout. Try Refresh again in a few seconds.");
        try {
          const final = await getSprintsLive(true);
          if (Array.isArray(final) && final.length > 0) queryClient.setQueryData(["sprints"], final);
        } catch (e) {
          // ignore
        }
      }
    } catch (err: any) {
      console.error("Sync from Jira failed:", err);
      showMessage("Sync failed: " + (err?.message || String(err)));
    } finally {
      setSyncing(false);
      syncInProgressRef.current = false;
    }
  };

//   const handlePostJiraComment = async (issueKey: string, prediction?: string) => {
//   if (!issueKey) return showMessage("Invalid issue key");
//   // if you want prediction included, require it
//   if (!prediction) return showMessage("No prediction available — run prediction first.");
//   const comment = `This is an automated message.\nDetected Issue: ${prediction}.\nKindly reach out to ${prediction} team.`;
//   const ok = await showConfirm(`Post the following comment to ${issueKey}?\n\n${comment}`);
//   if (!ok) return;
//   postCommentMut.mutate({ issueKey, comment });
// };

// open dialog when user clicks Update Jira button
const openUpdateDialog = (issueKey: string, prediction?: string) => {
  setUpdateDialogIssue({ issueKey, prediction });
  setUpdateLabelChecked(true);     // set sensible defaults
  setUpdateCommentChecked(true);
  // prefill editable comment text with default message (uses prediction if available)
  setUpdateCommentText(defaultAutomatedComment(prediction));
  setUpdateDialogOpen(true);
};

// confirm handler that actually performs API calls
const confirmUpdateDialog = async () => {
  if (!updateDialogIssue) return setUpdateDialogOpen(false);
  const { issueKey, prediction } = updateDialogIssue;
  if (!issueKey) return setUpdateDialogOpen(false);

  // if user chose label update but no prediction -> warn
  if (updateLabelChecked && !prediction) {
    showMessage("No prediction available to use as label.");
    return;
  }

    // If comment requested, ensure text is non-empty
  if (updateCommentChecked && (!updateCommentText || !updateCommentText.trim())) {
    showMessage("Comment is empty. Either uncheck 'Add comment' or provide comment text.");
    return;
  }
  setUpdateDialogOpen(false);

  // mark only this issue as loading
  setIssueLoading(issueKey, true);
  try {
    // perform label update first (if selected)
    if (updateLabelChecked && prediction) {
      try {
        await postJiraLabels(issueKey, prediction, "add");
      } catch (err) {
        console.error("Failed to update label:", err);
        showMessage("Failed to update label: " + (err as any)?.message || "");
      }
    }

    // perform comment add (if selected)
    if (updateCommentChecked) {
      try {
        await postJiraComment(issueKey, updateCommentText);
      } catch (err) {
        console.error("Failed to post comment:", err);
        showMessage("Failed to post comment: " + (err as any)?.message || "");
      }
    }

    showMessage("Jira update(s) completed.");
  } finally {
    setIssueLoading(issueKey, false);
  }
};



  // --- add this inside the Predict() component (e.g. right after handleRefreshFromJira) ---
const handleLoadIssuesForce = async () => {
  if (!selectedSprint) return;
  try {
    // optional quick UI guard: we already have issuesLoading from useQuery so reuse that for disabling button
    // Force a network fetch (bypass caches) and get the freshest issues for the selected sprint
    const resp = await api.get("/issues", {
      params: { sprint: selectedSprint, max_results: 5000 },
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    const freshIssues: IssueRow[] = Array.isArray(resp?.data) ? resp.data : [];

    // Immediately update react-query cache so UI updates instantly
    queryClient.setQueryData(["issues", selectedSprint], freshIssues);
    // Mark queries stale/invalidate so react-query consumers update cleanly
    queryClient.invalidateQueries({ queryKey: ["issues", selectedSprint] });

    // (optional) also update local state if you want immediate setIssues — not required because useQuery consumers will read cache
    setIssues(Array.isArray(freshIssues) ? [...freshIssues] : []);
  } catch (err) {
    console.error("Failed to force-load issues:", err);
    showMessage("Failed to load issues from server. Try Refresh from Jira.");
  }
};

 
  // keep local `issues` state but only update it when content actually changed (prevents setState churn)
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const prevIssuesRef = useRef<IssueRow[] | undefined>(undefined);

  useEffect(() => {
    if (!shallowIssuesEqual(issuesFromApi, prevIssuesRef.current)) {
      prevIssuesRef.current = issuesFromApi ? [...issuesFromApi] : undefined;
      setIssues(Array.isArray(issuesFromApi) ? [...issuesFromApi] : []);
    }
    // depend only on the data itself
  }, [issuesFromApi]);

  // per-issue "posting" map to show posting state only for the clicked row
const [updatingMap, setUpdatingMap] = useState<Record<string, boolean>>({});
const setUpdating = (key: string, val: boolean) => setUpdatingMap(p => ({ ...p, [key]: val }));

// dialog state for update options:
const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
const [updateDialogIssue, setUpdateDialogIssue] = useState<{ issueKey: string; prediction?: string } | null>(null);
const [updateLabelChecked, setUpdateLabelChecked] = useState(true);
const [updateCommentChecked, setUpdateCommentChecked] = useState(true);

// helper to set per-issue loading
const setIssueLoading = (key: string | null, val: boolean) => {
  if (!key) return;
  setUpdatingMap(prev => ({ ...prev, [key]: val }));
};

// NEW: editable comment text shown in dialog
const defaultAutomatedComment = (pred?: string) =>
  `This is an automated message.\nDetected: ${pred ?? "<prediction>"}.\nKindly reach out to XYZ team.`;
const [updateCommentText, setUpdateCommentText] = useState<string>("");

  // Modal state for recommendations popup
  const [recsModalOpen, setRecsModalOpen] = useState<boolean>(false);
  const [recsModalItems, setRecsModalItems] = useState<any[] | null>(null);
  const [recsModalTitle, setRecsModalTitle] = useState<string>("");

// open modal helper

  const openRecsModal = (items: any[] | null | undefined, title = "") => {
    setRecsModalItems(items ?? []);
    setRecsModalTitle(title || "Recommendations");
    setRecsModalOpen(true);
  };


// close modal helper
  const closeRecsModal = () => {
    setRecsModalOpen(false);
    // small delay to clear content (optional)
    setTimeout(() => {
      setRecsModalItems(null);
      setRecsModalTitle("");
    }, 160);
  };


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
    { predictions: any[] },
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
      // keep inputs as-is
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
    if (!label || !label.trim()) return showMessage("Enter a label to save as feedback.");
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
    if (entries.length === 0) return showMessage("Enter labels in the input boxes for selected rows.");
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
            <button className="btn-dark" disabled={singlePredLoading}>{singlePredLoading ? "Classifying…" : "Classify"}</button>
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
                    showMessage("Enter a label");
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

         {/* <button
            onClick={handleLoadIssuesForce}
            disabled={!selectedSprint || issuesLoading}
            className="btn btn-dark btn-pill"
          >
            {issuesLoading ? <span className="spinner" /> : "Load issues"}
          </button> */}



          <button
            onClick={handleRefreshFromJira}
            disabled={syncing}
            className={`btn btn-warning btn-pill`}
            title="Fetch latest sprints & issues from Jira"
          >
            {syncing ? <><span className="spinner" /> Syncing…</> : "Refresh from Jira"}
          </button>


          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn btn-dark" onClick={() => selectAllVisible(true)}>Select all</button>
            <button className="btn btn-dark" onClick={() => selectAllVisible(false)}>Clear</button>
            <button className="btn btn-dark" onClick={handlePredictSelected} disabled={bulkPredictLoading || selectedKeys.length === 0}>
              {bulkPredictLoading ? "Predicting…" : `Predict selected (${selectedKeys.length})`}
            </button>
            <button className="btn btn-dark" onClick={handlePredictAllVisible} disabled={bulkPredictLoading || issues.length === 0}>
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
              {issues.map((it, idx) => {
                const isUpdating = !!updatingMap[it.issue_key ?? ""];
                return(
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
                    <button className="btn-primary" onClick={() => handleRowPredict(it.issue_key)}>Predict</button>
                    <input placeholder="Correct label" value={fbInputs[it.issue_key] || ""} onChange={(e) => setFbInput(it.issue_key, e.target.value)} style={{ width: 130 }} />
                    <button className="btn-dark btn-pill" onClick={() => handleRowFeedback(it)}>Save</button>
                    {/* open in Jira */}
                    <a
                      className="btn-jira"
                      href={`${JIRA_HOST}/browse/${it.issue_key}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open in Jira"
                      style={{ marginLeft: 6 }}
                    >
                      ➤
                    </a>

                    {/* update (comment) in Jira */}
                    {/* <button
                        className="btn btn-dark btn-pill"
                        onClick={() => handlePostJiraComment(it.issue_key!, it.prediction)}
                        disabled={!!updatingMap[it.issue_key!] || !it.prediction}
                        style={{ marginLeft: 6 }}
                        title="Post automated comment to Jira"
                      >
                        {updatingMap[it.issue_key!] ? "Posting…" : "Update Jira"}
                      </button> */}
 

                      <button
                        className="btn btn-dark"
                        onClick={() => openUpdateDialog(it.issue_key!, it.prediction)}
                        disabled={isUpdating || !it.prediction}
                        style={{ marginLeft: 6 }}
                        title="Post automated updates to Jira"
                      >
                        {isUpdating ? "Posting…" : "Update Jira"}
                      </button>


                    {/* replace old Recs button with this */}
                    {!!it.recommendations?.length && (
                      <button
                        className="btn-dark"
                        style={{ marginLeft: 6 }}
                        onClick={() => openRecsModal(it.recommendations ?? null, `Similar tickets — ${it.issue_key}`)}
                        aria-label={`Open similar tickets for ${it.issue_key}`}
                        type="button"
                      >
                        View similar
                      </button>
                      
                    )}


                  </td>
                </tr>
                );
            })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button className="btn-dark" onClick={handleBulkFeedbackFromSelected} disabled={bulkFeedbackLoading || selectedKeys.length === 0}>
            {bulkFeedbackLoading ? "Saving…" : `Save feedback for selected (${selectedKeys.length})`}
          </button>
        </div>
      </div>
      {/* Recommendations modal */}
{recsModalOpen && (
  <div
    role="dialog"
    aria-modal="true"
    className="modal-overlay"
    onClick={(e) => {
      // click on overlay closes modal
      if (e.target === e.currentTarget) closeRecsModal();
    }}
  >
    <div className="modal-panel" role="document">
      <button className="modal-close" onClick={closeRecsModal} aria-label="Close recommendations">✕</button>
      <h3 style={{ marginTop: 0 }}>{recsModalTitle}</h3>
      <div style={{ maxHeight: "60vh", overflow: "auto", marginTop: 8 }}>
        {Array.isArray(recsModalItems) && recsModalItems.length > 0 ? (
          recsModalItems.map((r: any, i: number) => (
            <div key={i} style={{ padding: 10, borderBottom: "1px solid #f3f3f3", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{r.issue_key || "(no key)"} {r.label ? <span style={{ fontWeight: 500, marginLeft: 8, color: "#666" }}>— {r.label}</span> : null}</div>
                <div style={{ marginTop: 6 }}>{r.summary}</div>
                <small className="mono">similarity: {typeof r.similarity === "number" ? r.similarity.toFixed(3) : "-"}</small>
              </div>

              <div style={{ marginLeft: 12, display: "flex", gap: 8, alignItems: "center" }}>
                {!!r.url && (
                  <a
                    className="btn-jira"
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open in Jira"
                    onClick={(e) => {
                      // keep default behaviour (open in new tab)
                    }}
                  >
                    ➜
                  </a>
                )}
              </div>
            </div>
          ))
        ) : (
          <div style={{ padding: 12 }}>No recommendations available.</div>
        )}
      </div>
    </div>
  </div>
)}

{/* ===== Confirm modal (awaitable) ===== */}
{confirmOpen && (
  <div className="modal-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) _closeConfirm(false); }}>
    <div className="modal-panel" role="document" style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>Confirm</h3>
      <div style={{ marginTop: 8, color: "var(--muted)" }}>{confirmMessage}</div>

      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 18 }}>
        <button className="btn btn-ghost btn-pill" onClick={() => _closeConfirm(false)} type="button">Cancel</button>
        <button className="btn btn-primary btn-pill" onClick={() => _closeConfirm(true)} type="button">OK</button>
      </div>
    </div>
  </div>
)}

{/* ===== Message modal (informational) ===== */}
{msgOpen && (
  <div className="modal-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) closeMessage(); }}>
    <div className="modal-panel" role="document" style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>Message</h3>
      <div style={{ marginTop: 8, color: "var(--muted)" }}>{msgText}</div>

      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 18 }}>
        <button className="btn btn-primary btn-pill" onClick={() => closeMessage()} type="button">OK</button>
      </div>
    </div>
  </div>
)}

{updateDialogOpen && updateDialogIssue && (
  <div
    className="modal-overlay"
    role="dialog"
    aria-modal="true"
    onClick={(e) => { if (e.target === e.currentTarget) setUpdateDialogOpen(false); }}
  >
    <div className="modal-panel" role="document" style={{ maxWidth: 520 }}>
      <h3 style={{ marginTop: 0 }}>Update Jira — {updateDialogIssue.issueKey}</h3>

      <div style={{ marginTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={updateLabelChecked}
            onChange={(e) => setUpdateLabelChecked(e.target.checked)}
          />
          <span>
            Update label to predicted value{" "}
            <small style={{ color: "#666", marginLeft: 6 }}>
              {updateDialogIssue.prediction ? `(${updateDialogIssue.prediction})` : "(no prediction)"}
            </small>
          </span>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={updateCommentChecked}
            onChange={(e) => setUpdateCommentChecked(e.target.checked)}
          />
          <span>Add / edit the automated comment</span>
        </label>

        {/* NEW: editable comment textarea */}
        <div style={{ marginTop: 10 }}>
          <textarea
            value={updateCommentText}
            onChange={(e) => setUpdateCommentText(e.target.value)}
            rows={6}
            style={{
              width: "100%",
              resize: "vertical",
              padding: 8,
              fontFamily: "inherit",
              fontSize: 14,
              borderRadius: 6,
              border: "1px solid #ddd",
            }}
            disabled={!updateCommentChecked}
          />
          <div style={{ marginTop: 6, color: "#666", fontSize: 12, display: "flex", justifyContent: "space-between" }}>
            <div>{updateCommentText.length} characters</div>
            <div>{updateCommentText.split("\n").length} lines</div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
        <button className="btn btn-ghost btn-pill" onClick={() => setUpdateDialogOpen(false)} type="button">Cancel</button>
        <button className="btn btn-primary btn-pill" onClick={confirmUpdateDialog} type="button">OK</button>
      </div>
    </div>
  </div>
)}



    </div>
  );
}
