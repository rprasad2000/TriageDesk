# backend/routers/ml_router.py
from fastapi import APIRouter, HTTPException, UploadFile, File, Body, Query
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import yaml, os, math
import pandas as pd
import json
import tempfile
import time
from fastapi import BackgroundTasks
import asyncio


from services.model_service import (
    DATA_DIR,
    CORPUS_PATH,
    train_from_dataframe,
    classify_and_recommend,
    save_feedback,
    retrain_with_feedback,
    build_df_from_jira_issues,
)
from utilities.jira_utility import JiraUtility

router = APIRouter(prefix="/api/v1/ml", tags=["ML"])

# ---- Config ----
with open("config.yaml", "r") as f:
    CFG = yaml.safe_load(f)
HOST = CFG["JIRA"]["HOST"]
USERNAME = CFG["JIRA"]["USERNAME"]
API_TOKEN = CFG["JIRA"]["API_TOKEN"]
PROJECT_KEY = CFG["JIRA"]["PROJECT_KEY"]


# ---- Schemas ----
class TrainJiraRequest(BaseModel):
    jql: Optional[str] = None
    max_results: int = 500


class TrainCsvRequest(BaseModel):
    csv_path: str  # CSV must include: issue_key, summary, ticket_description/description, label(optional), url(optional)


class PredictRequest(BaseModel):
    text: str
    top_k: int = 5


class FeedbackRequest(BaseModel):
    text: str
    true_label: str
    source: Optional[str] = "user"

class BulkPredictRequest(BaseModel):
    # either issue_keys (list) or texts (list); prefer issue_keys so UI can pass issue_key and backend fetches text
    issue_keys: Optional[List[str]] = None
    texts: Optional[List[str]] = None
    top_k: int = 3

class BulkPredictResponseItem(BaseModel):
    issue_key: Optional[str]
    prediction: str
    confidence: float
    recommendations: List[Dict[str, Any]]


# Helper to attempt prediction safely
def _safe_predict(text: str, top_k: int = 3) -> Dict[str, Any]:
    try:
        out = classify_and_recommend(text, top_k=top_k)
        return out
    except FileNotFoundError:
        # model not trained yet
        return {"prediction": "", "confidence": 0.0, "recommendations": []}
    except Exception:
        return {"prediction": "", "confidence": 0.0, "recommendations": []}
    
# move/define a sync worker that performs the heavy lifting (refactor of existing code)
async def _sync_jira_worker(sprint: Optional[str], max_results: int, warnings_out: Optional[list] = None):
    """
    Worker that performs the actual Jira fetch and updates CORPUS_PATH and last_sync metadata.
    This is run in background (non-blocking to HTTP request).
    """
    warn_list = warnings_out if isinstance(warnings_out, list) else []
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)

    async def _try_get_issues(jql: str, max_attempts: int = 3, backoff: float = 1.0):
        last_exc = None
        for attempt in range(max_attempts):
            try:
                issues = await jira.get_issues(jql=jql, max_results=max_results)
                return issues or []
            except Exception as e:
                last_exc = e
                time.sleep(backoff * (attempt + 1))
        # if all attempts failed, raise last exception
        raise last_exc

    try:
        if sprint:
            safe_sprint = str(sprint).replace('"', '\\"')
            jql = f"""project = '{PROJECT_KEY}' AND issuetype = Bug AND sprint = "{safe_sprint}" ORDER BY created DESC"""
            try:
                issues = await _try_get_issues(jql)
            except Exception as e:
                warn_list.append(f"Jira query by sprint failed: {e}")
                issues = []

            if not issues:
                warn_list.append(f'No issues returned by sprint-JQL for "{sprint}". Falling back to scanning recent issues and filtering locally.')
                all_jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
                try:
                    all_issues = await _try_get_issues(all_jql)
                except Exception as e:
                    warn_list.append(f"Failed to fetch recent issues fallback: {e}")
                    all_issues = []
                if not all_issues:
                    # nothing to do
                    return {"status": "ok", "message": "No issues found in Jira during fallback", "warnings": warn_list}
                df_all = build_df_from_jira_issues(all_issues, HOST)
                matched = df_all[df_all["sprint"].astype(str).str.strip().str.lower() == str(sprint).strip().lower()]
                if matched.shape[0] == 0:
                    warn_list.append(f'After fallback scan, no issues had parsed sprint matching "{sprint}". Merging full recent dataset.')
                    df_new = df_all
                else:
                    df_new = matched.reset_index(drop=True)
            else:
                df_new = build_df_from_jira_issues(issues, HOST)
        else:
            jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
            try:
                issues = await _try_get_issues(jql)
            except Exception as e:
                warn_list.append(f"Failed to fetch issues from Jira: {e}")
                issues = []
            if not issues:
                return {"status": "ok", "message": "No issues found in Jira", "warnings": warn_list}
            df_new = build_df_from_jira_issues(issues, HOST)

        # Merge/update corpus
        if CORPUS_PATH.exists():
            try:
                df_existing = pd.read_parquet(CORPUS_PATH)
                combined = pd.concat([df_existing, df_new], ignore_index=True)
                combined = combined.drop_duplicates(subset=["issue_key"], keep="last").reset_index(drop=True)
            except Exception as e:
                warn_list.append(f"Failed to merge existing corpus: {e}; using new df.")
                combined = df_new.copy()
        else:
            combined = df_new.copy()

        # atomic write
        try:
            tmp_path = CORPUS_PATH.with_suffix(".tmp.parquet")
            cols = ["issue_key","summary","ticket_description","url","label","created","priority","status","severity","root_cause","sprint"]
            available = [c for c in cols if c in combined.columns]
            combined[available].to_parquet(tmp_path, index=False)
            os.replace(str(tmp_path), str(CORPUS_PATH))
        except Exception as e:
            warn_list.append(f"Failed to write corpus file: {e}")
            return {"status": "error", "detail": f"Failed to write corpus file: {e}", "warnings": warn_list}

        # update metadata
        try:
            sprints = sorted([s for s in combined["sprint"].astype(str).unique() if s and str(s).strip()])
            meta = {"last_sync": pd.Timestamp.now().isoformat(), "sprints": sprints, "n_issues": int(combined.shape[0])}
            LAST_SYNC_PATH.write_text(json.dumps(meta))
        except Exception as e:
            warn_list.append(f"Failed to write last_sync metadata: {e}")

        return {"status": "ok", "updated_sprints": sprints, "n_issues": int(combined.shape[0]), "warnings": warn_list}
    except Exception as e:
        warn_list.append(f"Unexpected sync error: {e}")
        return {"status": "error", "detail": str(e), "warnings": warn_list}

# ---- Endpoints ----

@router.post("/sync/board")
async def sync_board(max_results: int = 2000):
    """
    Fetch recent Jira issues and return dashboard-only metadata (sprints list, counts, last_sync).
    This endpoint does NOT modify the shared corpus or write files — it's read-only for dashboard use.
    """
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    try:
        jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
        issues = await jira.get_issues(jql=jql, max_results=max_results)
        if not issues:
            return {"status": "ok", "message": "no issues found", "updated_sprints": [], "n_issues": 0, "last_sync": pd.Timestamp.now().isoformat()}

        df = build_df_from_jira_issues(issues, HOST)

        # compute sprints found (parsed by build_df_from_jira_issues)
        sprints = sorted([s for s in df["sprint"].astype(str).unique() if s and str(s).strip()])

        # basic counts for dashboard KPIs
        # total = int(df.shape[0])
        # open_count = int(df[~df["status"].str.lower().isin(["done","closed","resolved"])].shape[0]) if "status" in df.columns else total
        # closed_count = total - open_count
        # high_sev_vals = {"Blocker","Critical","High"}
        # high_sev_count = int(df[df.get("severity", "").astype(str).isin(high_sev_vals)].shape[0]) if "severity" in df.columns else 0
                # basic counts for dashboard KPIs (defensive / canonical)
        total = int(df.shape[0])
        # normalize lower-case status safely
        if "status" in df.columns:
            status_series = df["status"].astype(str).str.strip().str.lower()
            open_count = int(status_series[~status_series.isin(["done", "closed", "resolved", "cancelled"])].shape[0])
        else:
            open_count = total
        closed_count = total - open_count

        # canonical high severity values (keep in sync with frontend HIGH_SEV)
        high_sev_vals = {"Blocker", "Critical", "Major"}
        if "severity" in df.columns:
            # ensure strings and exact-match set membership
            sev_series = df["severity"].astype(str).str.strip()
            high_sev_count = int(sev_series[sev_series.isin(high_sev_vals)].shape[0])
        else:
            high_sev_count = 0


        return {
            "status": "ok",
            "updated_sprints": sprints,
            "n_issues": total,
            "last_sync": pd.Timestamp.now().isoformat(),
            "kpis": {"total": total, "open": open_count, "closed": closed_count, "highSeverity": high_sev_count}
        }
    except Exception as e:
        return {"status": "error", "detail": str(e)}


@router.get("/incidents")
async def get_incidents(
    max_results: int = Query(2000, description="Max issues to fetch"),
    issuetype: Optional[str] = Query("Bug", description="Jira issuetype to query (e.g. Bug, Story). Set to '' to not filter by issuetype")
):
    """
    Fetch issues from Jira, enrich with predictions.
    Returns full list (up to max_results). If no issues found, returns an empty list (200).
    """
    # build JQL depending on issuetype param (allow empty to skip issuetype filter)
    if issuetype and str(issuetype).strip():
        jql = f"""project = '{PROJECT_KEY}' AND issuetype = {issuetype} ORDER BY created DESC"""
    else:
        jql = f"""project = '{PROJECT_KEY}' ORDER BY created DESC"""

    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    try:
        issues = await jira.get_issues(jql=jql, max_results=max_results)
    except Exception as e:
        # surface upstream errors clearly
        raise HTTPException(status_code=502, detail=f"Failed to query Jira: {e}")

    # If no issues found, return an empty list (frontend can show message)
    if not issues:
        return []

    df = build_df_from_jira_issues(issues, HOST)

    enriched = []
    for _, row in df.iterrows():
        pred = _safe_predict(row["ticket_description"], top_k=3)
        enriched.append({
            "incident_no": row.get("issue_key", ""),
            "creation_time": row.get("created", ""),
            "priority": row.get("priority", ""),
            "brief_detail": row.get("summary", ""),
            "description": row.get("ticket_description", ""),
            "status": row.get("status", ""),
            "severity": row.get("severity", ""),
            "root_cause": row.get("root_cause", ""),
            "prediction": pred.get("prediction", ""),
            "confidence_score": round(pred.get("confidence", 0.0) * 100, 2),
            "recommendation": pred.get("recommendations", []),
            # also include sprint if present in Jira payload
            "Sprint": row.get("sprint", "") if "sprint" in row else "",
        })
    return enriched


@router.get("/dashboard")
def get_dashboard(start: Optional[str] = Query(None), end: Optional[str] = Query(None), group: str = Query("month"), max_issues: int = Query(2000)):
    """
    Return analytics + full incidents list (for the requested date range).
    start/end optional, ISO dates (YYYY-MM-DD) — default last 12 months.
    group = "month"|"quarter"|"sprint"
    """
    # try fetch CSV first
    if (DATA_DIR / "QA_Defects_Issues.csv").exists():
        df = pd.read_csv(DATA_DIR / "QA_Defects_Issues.csv")
    else:
        # fallback: try to use corpus.parquet if exists (same idea)
        from services.model_service import CORPUS_PATH
        if CORPUS_PATH.exists():
            df = pd.read_parquet(CORPUS_PATH)
        else:
            # If no local dataset, fetch from Jira directly
            jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
            jira = JiraUtility(HOST, USERNAME, API_TOKEN)
            issues = jira.get_issues(jql=jql, max_results=max_issues)  # NOTE: sync call inside sync endpoint
            if not issues:
                raise HTTPException(status_code=404, detail="No dataset found locally and Jira returned no issues.")
            df = build_df_from_jira_issues(issues, HOST)

    # normalize date column name choices
    created_col_candidates = [c for c in df.columns if c.lower().strip() in ("created", "created_at", "created date", "creation_date", "createdon", "created_on")]
    created_col = created_col_candidates[0] if created_col_candidates else None
    if not created_col:
        # try contains 'created'
        found = next((c for c in df.columns if "created" in c.lower()), None)
        created_col = found

    if created_col is None:
        raise HTTPException(status_code=400, detail=f"No created date column found. Available columns: {list(df.columns)[:20]}")

    # robust parsing
    df[created_col] = pd.to_datetime(df[created_col], errors="coerce", dayfirst=True, infer_datetime_format=True)
    df = df.dropna(subset=[created_col]).copy()

    # default start/end -> last 12 months
    if end:
        end_dt = pd.to_datetime(end)
    else:
        end_dt = pd.Timestamp.now()
    if start:
        start_dt = pd.to_datetime(start)
    else:
        start_dt = end_dt - pd.DateOffset(months=12)

    df = df[(df[created_col] >= start_dt) & (df[created_col] <= end_dt)].copy()
    if df.shape[0] == 0:
        return {"sprints": [], "quarters": [], "incidents": [], "note": "no incidents in date range"}

    # prepare series
    if group == "sprint" and "Sprint" in df.columns:
        # use Sprint column (don't recompute)
        sprint_series = df.groupby(df["Sprint"].astype(str)).size().reset_index(name="count")
        sprint_out = sprint_series.sort_values("Sprint").to_dict(orient="records")
    else:
        # use month labels
        df["_month"] = df[created_col].dt.to_period("M").astype(str)
        sprint_series = df.groupby("_month").size().reset_index(name="count").sort_values("_month")
        sprint_out = [{"period": r["_month"], "label": pd.Period(r["_month"], freq="M").strftime("%b-%Y"), "count": int(r["count"])} for _, r in sprint_series.iterrows()]

    # quarter
    df["_quarter"] = df[created_col].dt.to_period("Q").astype(str)
    quarter_series = df.groupby("_quarter").size().reset_index(name="count").sort_values("_quarter")
    quarter_out = [{"period": r["_quarter"], "count": int(r["count"])} for _, r in quarter_series.iterrows()]

    # build incidents enriched with predictions (but non-blocking if model missing)
    incidents = []
    for _, row in df.iterrows():
        pred = _safe_predict(row.get("ticket_description", ""), top_k=3)
        incidents.append({
            "incident_no": row.get("issue_key", ""),
            "creation_time": row.get(created_col).strftime("%Y-%m-%d") if pd.notnull(row.get(created_col)) else "",
            "priority": row.get("priority", ""),
            "brief_detail": row.get("summary", ""),
            "description": row.get("ticket_description", ""),
            "status": row.get("status", ""),
            "severity": row.get("severity", ""),
            "root_cause": row.get("root_cause", ""),
            "prediction": pred.get("prediction", ""),
            "confidence_score": round(pred.get("confidence", 0.0) * 100, 2),
            "recommendation": pred.get("recommendations", []),
            "Sprint": row.get("Sprint", "")
        })

    return {
        "sprints": sprint_out,
        "quarters": quarter_out,
        "incidents": incidents,
        "count": len(incidents),
    }


@router.post("/train/jira")
async def train_from_jira(req: TrainJiraRequest):
    """
    Train model using issues pulled from Jira.
    """
    jql = f"""project = '{PROJECT_KEY}' 
              AND issuetype = Bug 
              AND statusCategory IN ("To Do", "In Progress", "Done") 
              ORDER BY created DESC"""
    
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    issues = await jira.get_issues(jql=jql, max_results=req.max_results)
    if not issues:
        raise HTTPException(status_code=404, detail="No Jira issues returned for training.")
    
    df = build_df_from_jira_issues(issues, HOST)
    result = train_from_dataframe(df)
    return {"message": "Training complete", **result}


@router.post("/train/csv")
def train_from_csv(req: TrainCsvRequest):
    """
    Train model from CSV (ALWAYS overwrites previous corpus).
    """
    if not os.path.exists(req.csv_path):
        raise HTTPException(status_code=404, detail="CSV not found.")
    df = pd.read_csv(req.csv_path)

    # Ensure ticket_description exists (fallbacks)
    lower = {c.lower(): c for c in df.columns}
    if "ticket_description" not in lower:
        if "summary" in lower and "description" in lower:
            df["ticket_description"] = (
                df[lower["summary"]].astype(str)
                + " "
                + df[lower["description"]].astype(str)
            ).str.strip()
        elif "description" in lower:
            df["ticket_description"] = df[lower["description"]].astype(str)
        elif "summary" in lower:
            df["ticket_description"] = df[lower["summary"]].astype(str)
        else:
            df["ticket_description"] = ""

    # Normalize label column name
    if "labels" in lower and lower["labels"] != "label":
        df.rename(columns={lower["labels"]: "label"}, inplace=True)
    elif "label" not in lower:
        df["label"] = ""

    result = train_from_dataframe(df)
    return {"message": "Training complete", **result}


@router.post("/predict")
def predict(req: PredictRequest):
    try:
        return classify_and_recommend(req.text, top_k=req.top_k)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/feedback")
def feedback(req: FeedbackRequest):
    save_feedback(req.text, req.true_label, source=req.source or "user")
    return {"message": "Feedback saved. Run /retrain to incorporate it."}


@router.post("/retrain")
def retrain():
    try:
        result = retrain_with_feedback()
        return {"message": "Retraining complete", **result}
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    
#**************************************************************************************************
# Jira sync + refreshed sprints endpoint (non-breaking addition)

LAST_SYNC_PATH = DATA_DIR / "last_sync.json"
SYNC_TTL_MINUTES = 30  # default caching TTL for GET /sprints (can be tuned)

async def _fetch_issues_from_jira(jira: JiraUtility, jql: str, max_results: int):
    issues = await jira.get_issues(jql=jql, max_results=max_results)
    return issues or []

@router.post("/sync/jira")
async def sync_jira(sprint: Optional[str] = None, force: bool = False, max_results: int = 5000):
    """
    Start a Jira sync in background and return immediately.
    Use GET /sprints?refresh=true to retrieve updated sprint list after sync completes.
    """
    # If not forced and TTL is fresh, return cached immediately
    try:
        if not force and LAST_SYNC_PATH.exists():
            meta = json.loads(LAST_SYNC_PATH.read_text())
            last = pd.to_datetime(meta.get("last_sync"))
            if (pd.Timestamp.now() - last) < pd.Timedelta(minutes=SYNC_TTL_MINUTES):
                return {"status": "cached", "last_sync": meta.get("last_sync"), "sprints": meta.get("sprints", [])}
    except Exception:
        # ignore metadata parsing and proceed to start a background sync
        pass

    # schedule background worker using asyncio.create_task
    try:
        asyncio.create_task(_sync_jira_worker(sprint, max_results, []))
        return {"status": "started", "message": "Jira sync started in background. Poll /sprints or check last_sync.json for updates."}
    except Exception as e:
        # fallback: attempt to run synchronously and return the result
        try:
            res = await _sync_jira_worker(sprint, max_results, [])
            return res
        except Exception as ex:
            return {"status": "error", "detail": f"Failed to start background sync: {ex}"}



@router.get("/sprints")
async def get_sprints(refresh: bool = Query(False, description="If true, refresh from Jira")):
    """
    Return list of sprints known in corpus. If refresh=True, fetch fresh from Jira and update corpus.
    Returns a simple list of sprint names.
    """
    # If not refresh and we have last_sync metadata, return cached sprints
    if not refresh and LAST_SYNC_PATH.exists():
        try:
            meta = json.loads(LAST_SYNC_PATH.read_text())
            return meta.get("sprints", [])
        except Exception:
            pass

    # If corpus exists and not forcing refresh, derive sprints from corpus
    if CORPUS_PATH.exists() and not refresh:
        try:
            df = pd.read_parquet(CORPUS_PATH)
            # accept both 'sprint' and 'Sprint' column names
            if "sprint" not in df.columns and "Sprint" in df.columns:
                df = df.rename(columns={"Sprint": "sprint"})
            sprints = sorted([s for s in df["sprint"].astype(str).unique() if s and str(s).strip()])
            return sprints
        except Exception:
            pass

    # Fallback: fetch from Jira (may be heavier)
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
    issues = await jira.get_issues(jql=jql, max_results=3000)
    if not issues:
        return []
    df = build_df_from_jira_issues(issues, HOST)
    sprints = sorted([s for s in df["sprint"].astype(str).unique() if s and str(s).strip()])

    # Try merging into corpus (best-effort)
    try:
        if CORPUS_PATH.exists():
            existing = pd.read_parquet(CORPUS_PATH)

            if refresh:
                # Full refresh → overwrite corpus with fresh Jira issues (removes deleted ones)
                merged = df.copy()
            else:
                # Normal path → append new and update changed, keep old
                merged = pd.concat([existing, df], ignore_index=True).drop_duplicates(
                    subset=["issue_key"], keep="last"
                )

            tmp_merge = CORPUS_PATH.with_suffix(".tmp.parquet")
            merged.to_parquet(tmp_merge, index=False)
            os.replace(str(tmp_merge), str(CORPUS_PATH))
            LAST_SYNC_PATH.write_text(json.dumps({
                "last_sync": pd.Timestamp.now().isoformat(),
                "sprints": sprints,
                "n_issues": int(merged.shape[0])
            }))
        else:
            df.to_parquet(CORPUS_PATH, index=False)
            LAST_SYNC_PATH.write_text(json.dumps({
                "last_sync": pd.Timestamp.now().isoformat(),
                "sprints": sprints,
                "n_issues": int(df.shape[0])
            }))
    except Exception as e:
        print(f"[WARN] corpus merge failed: {e}")
        pass

    return sprints

# GET /issues?sprint=...&openOnly=true
@router.get("/issues")
def get_issues(sprint: Optional[str] = None, openOnly: bool = True):
    from services.model_service import CORPUS_PATH
    if CORPUS_PATH.exists():
        df = pd.read_parquet(CORPUS_PATH)
    elif (DATA_DIR / "QA_Defects_Issues.csv").exists():
        df = pd.read_csv(DATA_DIR / "QA_Defects_Issues.csv")
    else:
        raise HTTPException(status_code=404, detail="No local dataset available.")
    # normalize created etc if necessary
    if "sprint" in df.columns:
        if sprint:
            df = df[df["sprint"] == sprint]
    # consider status field:
    if openOnly and "status" in df.columns:
        df = df[~df["status"].str.lower().isin(["done","closed","resolved","cancelled"])]
    # return minimal per-issue payload
    out = []
    for _, r in df.iterrows():
        out.append({
            "issue_key": r.get("issue_key"),
            "summary": r.get("summary", ""),
            "ticket_description": r.get("ticket_description",""),
            "priority": r.get("priority",""),
            "severity": r.get("severity",""),
            "status": r.get("status",""),
            "created": r.get("created",""),
            "Sprint": r.get("sprint","")
        })
    return out

# POST /predict/bulk
@router.post("/predict/bulk")
def predict_bulk(req: BulkPredictRequest):
    # build texts
    texts = []
    issue_keys = []
    if req.issue_keys:
        # look up texts from corpus (or try Jira fetch per key)
        from services.model_service import CORPUS_PATH
        if CORPUS_PATH.exists():
            corpus = pd.read_parquet(CORPUS_PATH)
            for k in req.issue_keys:
                row = corpus[corpus["issue_key"]==k]
                if not row.empty:
                    texts.append(str(row.iloc[0]["ticket_description"]))
                    issue_keys.append(k)
                else:
                    texts.append("")  # safeguard
                    issue_keys.append(k)
        else:
            # fallback: call Jira per key (expensive) — implement if needed
            raise HTTPException(status_code=400, detail="Corpus not available to resolve issue_keys.")
    elif req.texts:
        texts = req.texts
        issue_keys = [None]*len(texts)
    else:
        raise HTTPException(status_code=400, detail="Provide issue_keys or texts.")
    # call batch classifier
    from services.model_service import classify_and_recommend_batch
    try:
        results = classify_and_recommend_batch(texts, top_k=req.top_k)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # attach issue_keys
    out = []
    for k, r in zip(issue_keys, results):
        out.append({"issue_key": k, **r})
    return {"predictions": out}

# POST /feedback/bulk
class BulkFeedbackRequest(BaseModel):
    entries: List[Dict[str, str]]  # each: {issue_key?:..., text?:..., true_label:..., source?:...}

@router.post("/feedback/bulk")
def feedback_bulk(req: BulkFeedbackRequest):
    from services.model_service import save_feedback
    for e in req.entries:
        txt = e.get("text") or ""
        if not txt and e.get("issue_key"):
            # try to resolve from corpus
            from services.model_service import CORPUS_PATH
            if CORPUS_PATH.exists():
                c = pd.read_parquet(CORPUS_PATH)
                r = c[c["issue_key"]==e["issue_key"]]
                if not r.empty:
                    txt = r.iloc[0]["ticket_description"]
        save_feedback(txt, e["true_label"], source=e.get("source","user"))
    return {"message": "saved", "n": len(req.entries)}

@router.get("/validate-jira")
async def validate_jira():
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    jql = f"project = '{PROJECT_KEY}'"
    try:
        issues = await jira.get_issues(jql=jql, max_results=1)
        if issues is None:
            return {"ok": False, "detail": "No response from Jira - check network/host/auth"}
        return {"ok": True, "n_issues": len(issues)}
    except Exception as e:
        return {"ok": False, "detail": str(e)}
