# backend/routers/ml_router.py
from fastapi import APIRouter, HTTPException, UploadFile, File, Body, Query
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import yaml, os, math
import pandas as pd

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

# ---- Endpoints ----

@router.get("/incidents")
async def get_incidents(max_results: int = Query(2000, description="Max issues to fetch")):
    """
    Fetch issues from Jira, enrich with predictions.
    Returns full list (up to max_results).
    """
    jql = f"""project = '{PROJECT_KEY}' AND issuetype = Bug ORDER BY created DESC"""
    jira = JiraUtility(HOST, USERNAME, API_TOKEN)
    issues = await jira.get_issues(jql=jql, max_results=max_results)

    if not issues:
        raise HTTPException(status_code=404, detail="No Jira issues found.")

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