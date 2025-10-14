from fastapi import APIRouter, HTTPException, UploadFile, File, Body, Query
import numpy as np
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import yaml, os, math
import pandas as pd
import json
import tempfile
import time
from fastapi import BackgroundTasks
import asyncio
import httpx
from urllib.parse import quote as url_quote
import logging

from fastapi import Query, HTTPException
from typing import Optional

from services.model_service import (
    DATA_DIR,
    CORPUS_PATH,
    FEEDBACK_PATH,
    _host_issue_url,
    train_from_dataframe,
    classify_and_recommend,
    save_feedback,
    retrain_with_feedback,
    build_df_from_jira_issues,
    get_issues_for_label,
    compute_label_breakdown
    
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


# logging
logger = logging.getLogger("ml_router")
logging.basicConfig(level=logging.INFO)


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


# --- New helper: normalize Jira payloads (accept raw dict or list)
def _normalize_jira_issues_payload(payload) -> List[Dict[str, Any]]:
    """
    Accept either:
      - a list of issue dicts (what the rest of the code expects)
      - the raw Jira response dict that contains 'issues' key
    Return a list (possibly empty).
    """
    if payload is None:
        return []
    # If already a list of issues
    if isinstance(payload, list):
        return payload
    # If payload is a dict returned by httpx/requests.json()
    if isinstance(payload, dict):
        if "issues" in payload and isinstance(payload["issues"], list):
            return payload["issues"]
        # some helpers wrap under 'data'
        if "data" in payload and isinstance(payload["data"], dict) and "issues" in payload["data"]:
            return payload["data"]["issues"]
        # otherwise try heuristics: return first list value
        for v in payload.values():
            if isinstance(v, list):
                return v
    # fallback
    return []

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
                raw = await jira.get_issues(jql=jql, max_results=max_results)
                issues = _normalize_jira_issues_payload(raw)
                logger.info(f"_try_get_issues attempt={attempt+1} fetched {len(issues)} issues")
                return issues or []
            except Exception as e:
                last_exc = e
                await asyncio.sleep(backoff * (attempt + 1))
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
                raw = await jira.get_issues(jql=jql, max_results=max_results)
                issues = _normalize_jira_issues_payload(raw)
                logger.info(f"_sync_jira_worker fetched {len(issues)} issues for no-sprint sync")
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
            sprints = sorted([
                str(s).strip()
                for s in combined.get("sprint", pd.Series([], dtype=object)).dropna().unique()
                if str(s).strip().lower() not in ("", "nan", "none")
            ])
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
        raw = await jira.get_issues(jql=jql, max_results=max_results)
        issues = _normalize_jira_issues_payload(raw)
        logger.info(f"/sync/board: fetched {len(issues)} issues from Jira (raw type {type(raw)})")
        if not issues:
            return {"status": "ok", "message": "no issues found", "updated_sprints": [], "n_issues": 0, "last_sync": pd.Timestamp.now().isoformat()}

        df = build_df_from_jira_issues(issues, HOST)

        # compute sprints found (parsed by build_df_from_jira_issues)
        sprints = sorted([s for s in df["sprint"].astype(str).unique() if s and str(s).strip()])

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
        logger.exception("sync_board failed")
        return {"status": "error", "detail": str(e)}


_OPEN_STATUSES = {"open", "in progress", "inprogress", "reopened", "re-opened", "re-open", "re open"}

@router.get("/incidents")
async def get_incidents(
    max_results: int = Query(2000, description="Max issues to fetch"),
    issuetype: Optional[str] = Query("Bug", description="Jira issuetype to query (e.g. Bug, Story). Set to '' to not filter by issuetype"),
    sprint: Optional[str] = Query(None, description="Sprint name to filter (exact match)"),
):
    """
    Return enriched issues for Dashboard (no unlabeled/status-only filtering here).
    """
    # build JQL
    jql_parts = [f"project = '{PROJECT_KEY}'"]
    if issuetype and str(issuetype).strip():
        safe_it = str(issuetype).replace('"', '\\"')
        jql_parts.append(f'issuetype = "{safe_it}"')
    if sprint and str(sprint).strip():
        safe_sprint = str(sprint).replace('"', '\\"')
        jql_parts.append(f'sprint = "{safe_sprint}"')

    jql = " AND ".join(jql_parts) + " ORDER BY created DESC"

    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    try:
        raw = await jira.get_issues(jql=jql, max_results=max_results)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query Jira: {e}")

    issues = _normalize_jira_issues_payload(raw)
    logger.info(f"GET /incidents -> Jira returned raw type {type(raw)}, normalized issues: {len(issues)}")

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
            "Sprint": row.get("sprint", "") if "sprint" in row else "",
            # include raw labels too so dashboard can consume them if needed
            "labels": (row.get("labels") if "labels" in row else []),
            "label": row.get("label", "")
        })
    return enriched

@router.get("/incidents/for-scatter")
async def incidents_for_scatter(
    max_results: int = Query(1000, description="Max issues to fetch for scatter"),
    issuetype: Optional[str] = Query("Bug", description="Jira issuetype to query"),
    sprint: Optional[str] = Query(None, description="Sprint name to filter (exact match)"),
):
    """
    Lightweight endpoint used by Predict.tsx scatter chart.
    Returns only issues that:
      - have NO labels (labels array empty and 'label' canonical field empty)
      - and status is in open-like statuses (Open / In Progress / Reopened)
    Does NOT perform predictions here — frontend will call predict/bulk as needed.
    """
    # build JQL (same base as /incidents)
    jql_parts = [f"project = '{PROJECT_KEY}'"]
    if issuetype and str(issuetype).strip():
        safe_it = str(issuetype).replace('"', '\\"')
        jql_parts.append(f'issuetype = "{safe_it}"')
    if sprint and str(sprint).strip():
        safe_sprint = str(sprint).replace('"', '\\"')
        jql_parts.append(f'sprint = "{safe_sprint}"')

    jql = " AND ".join(jql_parts) + " ORDER BY created DESC"

    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    try:
        raw = await jira.get_issues(jql=jql, max_results=max_results)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query Jira for scatter: {e}")

    issues = _normalize_jira_issues_payload(raw)
    logger.info(f"GET /incidents/for-scatter -> Jira returned raw type {type(raw)}, normalized issues: {len(issues)}")

    # If no issues -> empty list
    if not issues:
        return []

    # Build quick map of labels from raw Jira payload (so we don't depend on build_df_from_jira_issues)
    labels_map = {}
    for r in issues:
        key = r.get("key") or (r.get("fields") or {}).get("key") or r.get("id")
        if not key:
            continue
        key = str(key)
        raw_labels = (r.get("fields") or {}).get("labels", []) or []
        if isinstance(raw_labels, list):
            labels_map[key] = raw_labels
        else:
            labels_map[key] = [s.strip() for s in str(raw_labels).split(",") if s.strip()] if str(raw_labels).strip() else []

    # We'll reuse build_df_from_jira_issues to get textual fields, sprint, status etc.
    df = build_df_from_jira_issues(issues, HOST)

    out = []
    for _, row in df.iterrows():
        issue_key = str(row.get("issue_key", "") or "")
        status_val = (row.get("status", "") or "").strip()
        status_norm = status_val.lower().replace("_", " ").replace("-", " ").strip()

        # 1) status must be open-like
        if status_norm not in _OPEN_STATUSES:
            continue

        # 2) labels must be empty (both raw labels and canonical 'label' should be empty)
        raw_labels = labels_map.get(issue_key, [])
        canonical_label = (row.get("label", "") or "").strip()
        # if (isinstance(raw_labels, list) and len(raw_labels) > 0) or canonical_label != "":
        #     # skip labeled issues
        #     continue

        # produce lightweight payload expected by Predict.tsx scatter loader
        out.append({
            "issue_key": issue_key,
            "summary": row.get("summary", "") or "",
            "ticket_description": row.get("ticket_description", "") or "",
            "severity": row.get("severity", "") or "",
            "prediction": "",          # leave empty so frontend can bulk-predict
            "confidence_score": 0,     # frontend will normalize or fill if needed
            "url": _host_issue_url(HOST, issue_key) if issue_key else "",
            "status": status_val,
            "Sprint": row.get("sprint", "") if "sprint" in row else "",
        })

    return out


@router.get("/dashboard")
async def get_dashboard(start: Optional[str] = Query(None), end: Optional[str] = Query(None), group: str = Query("month"), max_issues: int = Query(2000)):
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
            raw = await jira.get_issues(jql=jql, max_results=max_issues)  # NOTE: sync call inside sync endpoint
            issues = _normalize_jira_issues_payload(raw)
            logger.info(f"/dashboard fetched {len(issues)} raw issues from Jira")
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
    if group == "sprint" and ("Sprint" in df.columns or "sprint" in df.columns):
        # accept both forms; prefer lower-case 'sprint' if present
        if "sprint" in df.columns:
            sprint_series = df.groupby(df["sprint"].astype(str)).size().reset_index(name="count")
            sprint_out = sprint_series.sort_values("sprint").to_dict(orient="records")
        else:
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
    raw = await jira.get_issues(jql=jql, max_results=req.max_results)
    issues = _normalize_jira_issues_payload(raw)
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


@router.post("/train/upload")
async def train_from_upload(file: UploadFile = File(...)):
    """
    Train model from uploaded CSV file.
    Required columns: Issue Key (or issue_key), Summary, Description (or ticket_description)
    Optional: Labels, Priority, Severity, Status, Root Cause, Sprint
    """
    if not file.filename or not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed")
    
    try:
        # Read uploaded file into pandas
        contents = await file.read()
        from io import BytesIO
        df = pd.read_csv(BytesIO(contents))
        
        # Validate required columns (case-insensitive check)
        cols_lower = {c.lower().strip(): c for c in df.columns}
        
        # Check for issue key
        if not any(k in cols_lower for k in ["issue key", "issue_key", "key"]):
            raise HTTPException(
                status_code=400, 
                detail="Missing required column: 'Issue Key' or 'issue_key'"
            )
        
        # Check for summary
        if "summary" not in cols_lower:
            raise HTTPException(status_code=400, detail="Missing required column: 'Summary'")
        
        # Check for description
        if not any(k in cols_lower for k in ["description", "ticket_description"]):
            raise HTTPException(
                status_code=400, 
                detail="Missing required column: 'Description' or 'ticket_description'"
            )
        
        # Train with the uploaded dataframe
        result = train_from_dataframe(df)
        return {"message": f"Training complete from uploaded file: {file.filename}", **result}
        
    except pd.errors.EmptyDataError:
        raise HTTPException(status_code=400, detail="Uploaded CSV is empty")
    except Exception as e:
        logger.exception("Failed to train from uploaded CSV")
        raise HTTPException(status_code=500, detail=f"Training failed: {str(e)}")

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
    raw = await jira.get_issues(jql=jql, max_results=max_results)
    return _normalize_jira_issues_payload(raw)

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
    raw = await jira.get_issues(jql=jql, max_results=3000)
    issues = _normalize_jira_issues_payload(raw)
    logger.info(f"get_sprints fetched {len(issues)} issues from Jira for sprint discovery")
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
        logger.warning(f"[WARN] corpus merge failed: {e}")
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

@router.post("/issues/{issue_key}/comment")
async def post_jira_comment(issue_key: str, comment: Dict[str, str] = Body(...)):
    """
    Post a plain-text comment to a Jira issue.
    Body: { "comment": "text to post" }
    """
    if not issue_key:
        raise HTTPException(status_code=400, detail="Missing issue key")
    text = comment.get("comment") if isinstance(comment, dict) else None
    if not text or not str(text).strip():
        raise HTTPException(status_code=400, detail="Missing comment text")

    jira = JiraUtility(HOST, USERNAME, API_TOKEN)

    # Try existing helper methods on JiraUtility first (support both sync/async)
    try:
        if hasattr(jira, "add_comment"):
            maybe = jira.add_comment(issue_key, text)
            if asyncio.iscoroutine(maybe):
                resp = await maybe
            else:
                resp = maybe
            return {"ok": True, "data": resp}
        if hasattr(jira, "post_comment"):
            maybe = jira.post_comment(issue_key, text)
            if asyncio.iscoroutine(maybe):
                resp = await maybe
            else:
                resp = maybe
            return {"ok": True, "data": resp}
    except Exception as e:
        # log and continue to REST fallback (don't fail immediately)
        logger.warning(f"[WARN] JiraUtility comment helper failed: {e}")

    # REST fallback using Jira Cloud API
    try:
        auth = httpx.BasicAuth(USERNAME, API_TOKEN)
        base = HOST.rstrip("/")
        quoted_key = url_quote(issue_key, safe="")
        url = f"{base}/rest/api/2/issue/{quoted_key}/comment"

        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, json={"body": text}, auth=auth, headers={"Content-Type": "application/json"})
            resp.raise_for_status()
            return {"ok": True, "data": resp.json()}
    except httpx.HTTPStatusError as he:
        body = "<unreadable response body>"
        try:
            body = he.response.text
        except Exception:
            pass
        # HTTP upstream error — surface as 502
        raise HTTPException(status_code=502, detail=f"Jira returned status {he.response.status_code}: {body}")
    except Exception as e:
        # unexpected failure posting comment
        raise HTTPException(status_code=500, detail=f"Failed to post comment to Jira: {e}")

@router.post("/issues/{issue_key}/labels")
async def post_jira_labels(issue_key: str, payload: Dict[str, Any] = Body(...)):
    """
    Update labels for a Jira issue.
    Body: { "label": "NewLabel", "mode": "add" | "replace" }
    - 'add' appends label (if not present)
    - 'replace' overwrites labels with provided label
    """
    if not issue_key:
        raise HTTPException(status_code=400, detail="Missing issue key")
    label = payload.get("label") if isinstance(payload, dict) else None
    mode = (payload.get("mode") if isinstance(payload, dict) else "add") or "add"
    if not label or not str(label).strip():
        raise HTTPException(status_code=400, detail="Missing label")

    # sanitize label for Jira: labels are tokens (no spaces preferred)
    label_str = str(label).strip()
    # optionally replace spaces with underscore to avoid Jira label rules
    sanitized = label_str.replace(" ", "_")

    jira = JiraUtility(HOST, USERNAME, API_TOKEN)

    # try helper on JiraUtility if available
    try:
        # Some utilities may expose add_label / set_labels / update_issue_fields
        if hasattr(jira, "add_label"):
            maybe = jira.add_label(issue_key, sanitized)
            if asyncio.iscoroutine(maybe):
                resp = await maybe
            else:
                resp = maybe
            return {"ok": True, "labels": resp}
        if hasattr(jira, "set_labels"):
            if mode == "replace":
                maybe = jira.set_labels(issue_key, [sanitized])
            else:
                maybe = jira.set_labels(issue_key, [sanitized], append=True)  # if signature supports append
            if asyncio.iscoroutine(maybe):
                resp = await maybe
            else:
                resp = maybe
            return {"ok": True, "labels": resp}
        if hasattr(jira, "update_issue_fields"):
            # attempt to fetch current then update
            maybe_issue = jira.get_issue(issue_key)
            if asyncio.iscoroutine(maybe_issue):
                issue_info = await maybe_issue
            else:
                issue_info = maybe_issue
            current = issue_info.get("fields", {}).get("labels", []) if issue_info else []
            if mode == "replace":
                new_labels = [sanitized]
            else:
                new_labels = list(dict.fromkeys((current or []) + [sanitized]))
            upd = jira.update_issue_fields(issue_key, {"labels": new_labels})
            if asyncio.iscoroutine(upd):
                await upd
            return {"ok": True, "labels": new_labels}
    except Exception as e:
        logger.warning(f"[WARN] JiraUtility labels helper failed: {e}")

    # REST fallback: fetch issue then edit fields.labels using issue edit (PUT)
    try:
        auth = httpx.BasicAuth(USERNAME, API_TOKEN)
        base = HOST.rstrip("/")
        quoted_key = url_quote(issue_key, safe="")
        get_url = f"{base}/rest/api/2/issue/{quoted_key}?fields=labels"
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(get_url, auth=auth, headers={"Accept": "application/json"})
            r.raise_for_status()
            issue_json = r.json()
            current_labels = issue_json.get("fields", {}).get("labels", []) or []

            if mode == "replace":
                new_labels = [sanitized]
            else:
                # append if not exists
                new_labels = list(dict.fromkeys(current_labels + [sanitized]))

            edit_url = f"{base}/rest/api/2/issue/{quoted_key}"
            # Jira edit payload: {"update": {"labels":[{"set": [...]}]}} or fields direct
            # Simpler: use "fields" to replace labels in one go
            payload = {"fields": {"labels": new_labels}}
            resp = await client.put(edit_url, json=payload, auth=auth, headers={"Content-Type": "application/json"})
            resp.raise_for_status()
            return {"ok": True, "labels": new_labels}
    except httpx.HTTPStatusError as he:
        body = "<unreadable response body>"
        try:
            body = he.response.text
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Jira returned status {he.response.status_code}: {body}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update labels: {e}")


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


# ================================================
# Label Breakdown & Issues (for Label Classification chart)
# ================================================

@router.get("/labels")
def get_labels(top_n: int = 20, status: str = "both"):
    """
    Return label classification breakdown with counts of open/closed/total.
    status: 'open' | 'closed' | 'both'
    """
    try:
        breakdown = compute_label_breakdown(top_n=top_n, status_filter=status)
        return breakdown
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to compute label breakdown: {e}")


@router.get("/labels/{label_name}/issues")
def get_label_issues(label_name: str, status: str = "both", max_results: int = 2000):
    """
    Return list of issues for a given label.
    status: 'open' | 'closed' | 'both'
    """
    try:
        issues = get_issues_for_label(label_name, status_filter=status, max_results=max_results)
        return {"label": label_name, "status": status, "count": len(issues), "issues": issues}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch issues for label '{label_name}': {e}")


@router.get("/validate-jira")
async def validate_jira():
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    jql = f"project = '{PROJECT_KEY}'"
    try:
        raw = await jira.get_issues(jql=jql, max_results=1)
        issues = _normalize_jira_issues_payload(raw)
        if issues is None:
            return {"ok": False, "detail": "No response from Jira - check network/host/auth"}
        return {"ok": True, "n_issues": len(issues)}
    except Exception as e:
        return {"ok": False, "detail": str(e)}

# @router.get("/debug/jira-sample")
# async def debug_jira_sample(max_results: int = 5):
#     """
#     Debug helper: fetch a small number of Jira issues with the current JQL and return raw payload.
#     Use from Swagger to inspect exactly what Jira returns (which fields contain sprint).
#     """
#     jira = JiraUtility(HOST, USERNAME, API_TOKEN)
#     jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
#     try:
#         raw = await jira.get_issues(jql=jql, max_results=max_results)
#     except Exception as e:
#         raise HTTPException(status_code=502, detail=f"Jira fetch failed: {e}")
#     issues = _normalize_jira_issues_payload(raw)
#     if not issues:
#         return {"n_issues": 0, "issues": []}
#     # sample first 3 issues (strip large fields)
#     out = []
#     for raw_issue in issues[:3]:
#         out.append({
#             "key": raw_issue.get("key"),
#             "summary": (raw_issue.get("fields") or {}).get("summary"),
#             "sprint_fields_keys": [k for k in (raw_issue.get("fields") or {}).keys() if "sprint" in str(k).lower()],
#             "fields_sample": {k: (raw_issue.get("fields") or {}).get(k) for k in sorted(list(raw_issue.get("fields") or {}).keys())[:20]}
#         })
#     return {"n_issues": len(issues), "issues_sample": out}
@router.get("/debug/jira-sample")
async def debug_jira_sample(max_results: int = 5):
    """
    Debug helper: fetch a small number of Jira issues with the current JQL and return raw payload.
    Use from Swagger to inspect exactly what Jira returns (which fields contain sprint).
    Defensive against unexpected shapes for 'fields' (dict/list/other).
    """
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    jql = f"project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"
    try:
        raw = await jira.get_issues(jql=jql, max_results=max_results)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Jira fetch failed: {e}")

    issues = _normalize_jira_issues_payload(raw)
    if not issues:
        return {"n_issues": 0, "issues": []}

    out = []
    # Inspect up to first 3 issues in the normalized list
    for raw_issue in issues[:3]:
        key = raw_issue.get("key")
        fields = raw_issue.get("fields") or {}

        # Prepare a safe sample of fields (max ~20 keys when dict-like)
        if isinstance(fields, dict):
            try:
                keys = sorted(list(fields.keys()))
            except Exception:
                keys = list(fields.keys()) if hasattr(fields, "keys") else []
            sample_keys = keys[:20]
            fields_sample = {k: fields.get(k) for k in sample_keys}
            sprint_fields_keys = [k for k in keys if "sprint" in str(k).lower()]
            summary = fields.get("summary")
        elif isinstance(fields, list):
            # If list of dicts, sample the first dict's keys; otherwise provide a short string preview
            first = fields[0] if len(fields) > 0 else None
            if isinstance(first, dict):
                try:
                    keys = sorted(list(first.keys()))
                except Exception:
                    keys = list(first.keys()) if hasattr(first, "keys") else []
                sample_keys = keys[:20]
                fields_sample = {k: first.get(k) for k in sample_keys}
                sprint_fields_keys = [k for k in keys if "sprint" in str(k).lower()]
                summary = first.get("summary")
            else:
                # non-dict list; provide short preview
                fields_sample = {"raw_preview": str(fields)[:500]}
                sprint_fields_keys = []
                summary = None
        else:
            # fields is some other type (string/number/None) — stringify safely
            fields_sample = {"raw_preview": str(fields)[:500]}
            sprint_fields_keys = []
            summary = None

        out.append({
            "key": key,
            "summary": summary,
            "sprint_fields_keys": sprint_fields_keys,
            "fields_sample": fields_sample
        })

    return {"n_issues": len(issues), "issues_sample": out}

# Add after the existing /feedback/bulk endpoint (around line 350)

@router.get("/feedback/summary")
def get_feedback_summary():
    """Return count and list of feedback entries waiting to be used in retraining."""
    if not FEEDBACK_PATH.exists():
        return {"count": 0, "labels": []}
    
    try:
        fb = pd.read_parquet(FEEDBACK_PATH)
        label_counts = fb["true_label"].value_counts().to_dict()
        return {
            "count": int(fb.shape[0]),
            "labels": [{"label": k, "count": int(v)} for k, v in label_counts.items()]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read feedback: {e}")


@router.delete("/feedback/clear")
def clear_feedback():
    """Clear all pending feedback entries."""
    try:
        if FEEDBACK_PATH.exists():
            FEEDBACK_PATH.unlink()
        return {"message": "Feedback cleared", "ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear feedback: {e}")
    

# Add this new endpoint to your ml_router.py

@router.get("/forecast/trends/active")
async def get_active_sprint_forecast(
    active_sprints: Optional[str] = Query(None, description="Comma-separated list of active sprint names"),
    future_periods: int = Query(3, description="Number of future sprints to forecast")
):
    """
    Generate forecast based on ACTIVE sprints only + predict 3 future sprints.
    Uses ML classifier predictions for unlabeled issues.
    """
    try:
        # Step 1: Determine active sprints
        if active_sprints:
            sprint_list = [s.strip() for s in active_sprints.split(",") if s.strip()]
        else:
            # Fallback: use last 5 sprints as "active"
            if not CORPUS_PATH.exists():
                raise HTTPException(status_code=404, detail="No corpus data. Run sync first.")
            df_all = pd.read_parquet(CORPUS_PATH)
            all_sprints = sorted([s for s in df_all["sprint"].dropna().unique() if str(s).strip()])
            sprint_list = all_sprints[-5:] if len(all_sprints) >= 5 else all_sprints

        if not sprint_list:
            raise HTTPException(status_code=400, detail="No active sprints provided or found")

        # Step 2: Fetch issues for these sprints from Jira (live data)
        jira = JiraUtility(HOST, USERNAME, API_TOKEN)
        all_issues = []
        
        for sprint_name in sprint_list:
            safe_sprint = sprint_name.replace('"', '\\"')
            jql = f'project = "{PROJECT_KEY}" AND issuetype = Bug AND sprint = "{safe_sprint}" ORDER BY created DESC'
            try:
                raw = await jira.get_issues(jql=jql, max_results=500)
                issues = _normalize_jira_issues_payload(raw)
                all_issues.extend(issues)
            except Exception as e:
                logger.warning(f"Failed to fetch sprint {sprint_name}: {e}")
                continue

        if not all_issues:
            raise HTTPException(status_code=404, detail="No issues found in active sprints")

        # Step 3: Build dataframe and classify unlabeled issues
        df = build_df_from_jira_issues(all_issues, HOST)
        
        # Identify unlabeled issues (no label or empty label)
        df["has_label"] = df["label"].astype(str).str.strip().ne("")
        unlabeled_mask = ~df["has_label"]
        
        # Predict labels for unlabeled issues using ML classifier
        if unlabeled_mask.sum() > 0:
            try:
                from services.model_service import classify_and_recommend_batch
                texts = df.loc[unlabeled_mask, "ticket_description"].tolist()
                predictions = classify_and_recommend_batch(texts, top_k=1)
                
                # Update dataframe with predictions
                pred_labels = [p["prediction"] for p in predictions]
                df.loc[unlabeled_mask, "label"] = pred_labels
                df.loc[unlabeled_mask, "confidence"] = [p["confidence"] for p in predictions]
            except FileNotFoundError:
                logger.warning("ML model not trained. Skipping predictions.")
                # Use "Unlabeled" as fallback
                df.loc[unlabeled_mask, "label"] = "Unlabeled"
                df.loc[unlabeled_mask, "confidence"] = 0.0

        # Step 4: Aggregate counts by sprint and label
        df_labeled = df[df["label"].astype(str).str.strip() != ""]
        sprint_label_counts = df_labeled.groupby(["sprint", "label"]).size().reset_index(name="count")
        
        # Step 5: Generate forecasts for each label
        all_labels = sprint_label_counts["label"].unique().tolist()
        forecast_data = []
        
        for label in all_labels:
            label_data = sprint_label_counts[sprint_label_counts["label"] == label]
            
            # Historical counts per sprint
            historical = {}
            for _, row in label_data.iterrows():
                historical[row["sprint"]] = int(row["count"])
            
            # Get time-series values
            counts = [historical.get(s, 0) for s in sprint_list]
            
            # Generate forecast using simple method
            if len(counts) < 2:
                # Not enough data - use last value
                forecast_vals = [counts[-1]] * future_periods if counts else [0] * future_periods
                confidence = 0.3
            else:
                # Use moving average + trend
                recent = counts[-3:] if len(counts) >= 3 else counts
                avg = np.mean(recent)
                trend = (recent[-1] - recent[0]) / len(recent) if len(recent) > 1 else 0
                
                forecast_vals = [max(0, int(avg + trend * (i + 1))) for i in range(future_periods)]
                confidence = min(0.9, 0.5 + (len(counts) * 0.05))
            
            # Add historical data points
            for sprint_name in sprint_list:
                forecast_data.append({
                    "sprint": sprint_name,
                    "label": label,
                    "count": historical.get(sprint_name, 0),
                    "type": "actual",
                    "confidence": None
                })
            
            # Add forecast data points
            for i, val in enumerate(forecast_vals):
                forecast_data.append({
                    "sprint": f"Future {i + 1}",
                    "label": label,
                    "count": val,
                    "type": "forecast",
                    "confidence": confidence,
                    "lower_bound": max(0, int(val * 0.8)),
                    "upper_bound": int(val * 1.2)
                })

                seen_pairs = set()
                forecast_data_deduped = []
                for item in forecast_data:
                    pair = (item["sprint"], item["label"])
                    if pair not in seen_pairs:
                        seen_pairs.add(pair)
                        forecast_data_deduped.append(item)

                # Replace forecast_data with the deduplicated version
                forecast_data = forecast_data_deduped
        
        # Step 6: Calculate health metrics
        health_score = _calculate_health_score(forecast_data, all_labels)
        avg_confidence = np.mean([d["confidence"] for d in forecast_data if d["type"] == "forecast"])
        
        # Step 7: Identify risks and wins
        risks, wins = _analyze_trends(forecast_data, sprint_list)
        
        # Step 8: Generate recommendations
        recommendations = _generate_recommendations(health_score, risks, wins)
        
        # Step 9: Build response
        all_sprint_names = sprint_list + [f"Future {i+1}" for i in range(future_periods)]
        seen = set()
        unique_sprints = []
        for s in all_sprint_names:
            if s not in seen:
                seen.add(s)
                unique_sprints.append(s)
        
        return {
            "sprints": unique_sprints,
            "data": forecast_data,
            "health_score": health_score,
            "forecast_confidence": int(avg_confidence * 100),
            "recommendations": recommendations,
            "risks": risks,
            "wins": wins,
            "labels": all_labels,
            "active_sprints": sprint_list
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to generate active sprint forecast")
        raise HTTPException(status_code=500, detail=f"Forecast failed: {str(e)}")


# Helper functions
def _calculate_health_score(forecast_data: list, labels: list) -> int:
    """Calculate overall health score (0-100)"""
    try:
        # Get last actual and first forecast for each label
        scores = []
        for label in labels:
            label_data = [d for d in forecast_data if d["label"] == label]
            actuals = [d for d in label_data if d["type"] == "actual"]
            forecasts = [d for d in label_data if d["type"] == "forecast"]
            
            if not actuals or not forecasts:
                continue
            
            last_actual = actuals[-1]["count"]
            first_forecast = forecasts[0]["count"]
            
            # Calculate change percentage
            if last_actual == 0:
                change = 0 if first_forecast == 0 else 100
            else:
                change = ((first_forecast - last_actual) / last_actual) * 100
            
            # Score: lower increase = better
            if change <= 0:
                scores.append(100)  # Decreasing is good
            elif change <= 20:
                scores.append(80)
            elif change <= 50:
                scores.append(60)
            else:
                scores.append(40)
        
        return int(np.mean(scores)) if scores else 65
    except Exception:
        return 65


def _analyze_trends(forecast_data: list, sprint_list: list) -> tuple:
    """Identify top risks (increasing) and wins (decreasing)"""
    risks = []
    wins = []
    
    labels = set(d["label"] for d in forecast_data)
    
    for label in labels:
        label_data = [d for d in forecast_data if d["label"] == label]
        actuals = [d for d in label_data if d["type"] == "actual"]
        forecasts = [d for d in label_data if d["type"] == "forecast"]
        
        if not actuals or not forecasts:
            continue
        
        last_actual = actuals[-1]["count"]
        first_forecast = forecasts[0]["count"]
        
        if last_actual == 0:
            if first_forecast > 0:
                pct = 100
            else:
                continue
        else:
            pct = ((first_forecast - last_actual) / last_actual) * 100
        
        if pct > 30:  # Increasing trend
            risks.append({
                "label": label,
                "type": "Increasing defects",
                "percentage": f"+{pct:.1f}%"
            })
        elif pct < -20:  # Decreasing trend
            wins.append({
                "label": label,
                "type": "Trend improving",
                "percentage": f"{pct:.1f}%"
            })
    
    # Sort and limit to top 3
    risks = sorted(risks, key=lambda x: float(x["percentage"].strip("+%")), reverse=True)[:3]
    wins = sorted(wins, key=lambda x: float(x["percentage"].strip("%")))[:3]
    
    return risks, wins


def _generate_recommendations(health_score: int, risks: list, wins: list) -> list:
    """Generate actionable recommendations"""
    recs = []
    
    if health_score >= 70:
        recs.append({"type": "success", "message": "✅ Continue current quality practices - trends are stable"})
    elif health_score >= 50:
        recs.append({"type": "warning", "message": "⚠️ Monitor emerging trends - some categories increasing"})
    else:
        recs.append({"type": "warning", "message": "🔴 Immediate action needed - significant defect increases predicted"})
    
    for risk in risks[:2]:
        recs.append({
            "type": "warning",
            "message": f"⚠️ Allocate additional QA resources for {risk['label']} testing"
        })
    
    for win in wins[:1]:
        recs.append({
            "type": "success",
            "message": f"🎯 {win['label']} trend improving - current mitigation effective"
        })
    
    return recs


@router.get("/sprints/active")
async def get_active_sprints():
    """Return list of currently active sprints based on Jira sprint state"""
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    
    # Fetch all sprints from your board
    board_id = "YOUR_BOARD_ID"  # Get from Jira board settings
    url = f"{HOST}/rest/agile/1.0/board/{board_id}/sprint?state=active"
    
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            auth=httpx.BasicAuth(USERNAME, API_TOKEN),
            headers={"Accept": "application/json"}
        )
        resp.raise_for_status()
        data = resp.json()
        
    active = [s["name"] for s in data.get("values", []) if s.get("state") == "active"]
    return active