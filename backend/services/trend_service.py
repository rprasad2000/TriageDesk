# backend/services/trend_service.py
import json
import os
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

import pandas as pd
import numpy as np

from services.model_service import CORPUS_PATH, DATA_DIR

TREND_CACHE_PATH = DATA_DIR / "trend_cache.json"


# ----------------- NEW: Import sprint list from sprint service -----------------
def _get_canonical_sprint_order() -> List[str]:
    """
    Get sprint order from Jira metadata (last_sync.json) ONLY.
    Never reads from corpus to prevent CSV sprint pollution.
    """
    try:
        from pathlib import Path
        import json
        
        DATA_DIR = Path("backend/data")
        LAST_SYNC_PATH = DATA_DIR / "last_sync.json"
        
        if LAST_SYNC_PATH.exists():
            with open(LAST_SYNC_PATH, "r") as f:
                meta = json.load(f)
                sprints = meta.get("sprints", [])
                if sprints and isinstance(sprints, list):
                    # Filter to only show recent/active sprints (optional)
                    # You can add logic here to filter by year if needed
                    return sprints
    except Exception as e:
        print(f"[trend_service] Failed to load sprints from metadata: {e}")
    
    # Fallback: return empty (better than using CSV sprints)
    return []


def _load_corpus() -> pd.DataFrame:
    """
    Load corpus parquet (dedupe by issue_key keep last). Return empty DF if file missing.
    """
    if not CORPUS_PATH.exists():
        return pd.DataFrame()
    try:
        df = pd.read_parquet(CORPUS_PATH)
    except Exception as e:
        print(f"[trend_service] failed to read corpus: {e}")
        return pd.DataFrame()
    
    if "Sprint" in df.columns and "sprint" not in df.columns:
        df = df.rename(columns={"Sprint": "sprint"})
    
    if "issue_key" in df.columns:
        try:
            df = df.drop_duplicates(subset=["issue_key"], keep="last").reset_index(drop=True)
        except Exception:
            pass
    return df


def _sprint_order(df: pd.DataFrame) -> List[str]:
    """
    Return list of sprint names ordered chronologically.
    
    NEW STRATEGY:
      1. First try to get canonical order from sprint service
      2. If that fails, fall back to extracting numeric sprint numbers
      3. Final fallback: lexicographic sort
    """
    import re

    if df is None or df.shape[0] == 0 or "sprint" not in df.columns:
        return []

    # Get all unique sprints from the dataframe
    df_sprints = [str(s).strip() for s in df["sprint"].unique() 
                  if str(s).strip() and str(s).strip().lower() not in ("nan", "none", "")]
    
    if not df_sprints:
        return []

    # Strategy 1: Use canonical sprint order from sprint service
    canonical_order = _get_canonical_sprint_order()
    if canonical_order:
        print(f"[trend_service] Using canonical sprint order: {canonical_order}")
        
        # Create a ranking map
        sprint_rank = {s: i for i, s in enumerate(canonical_order)}
        
        # Sort df_sprints according to canonical order
        # Sprints not in canonical list go to the end
        sorted_sprints = sorted(df_sprints, 
                               key=lambda s: sprint_rank.get(s, 999999))
        return sorted_sprints

    # Strategy 2: Extract numeric sprint numbers (e.g., "Sprint 3" -> 3)
    def extract_sprint_number(name: str) -> float:
        if not isinstance(name, str):
            return float("inf")
        match = re.search(r"(\d+)", name)
        if match:
            return float(match.group(1))
        return float("inf")

    df_sprints_with_nums = [(s, extract_sprint_number(s)) for s in df_sprints]
    df_sprints_with_nums.sort(key=lambda x: (x[1], x[0]))
    
    return [s for s, _ in df_sprints_with_nums]


def build_defect_time_series(df: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate corpus -> DataFrame of rows {sprint, label, defect_count}.
    Ensures the returned DataFrame is sorted by label then by chronological sprint order.
    """
    if df is None or df.shape[0] == 0:
        return pd.DataFrame(columns=["sprint", "label", "defect_count"])

    if "label" not in df.columns and "labels" in df.columns:
        df = df.rename(columns={"labels": "label"})
    if "label" not in df.columns:
        return pd.DataFrame(columns=["sprint", "label", "defect_count"])

    if "sprint" not in df.columns:
        df["sprint"] = ""

    def _extract_first_label(v):
        if isinstance(v, list):
            return v[0] if len(v) > 0 else ""
        s = str(v) if v is not None else ""
        if "," in s:
            return s.split(",")[0].strip()
        return s.strip()

    tmp = df[["sprint", "label"]].copy()
    tmp["label"] = tmp["label"].apply(_extract_first_label)
    tmp["sprint"] = tmp["sprint"].astype(str)
    tmp = tmp[tmp["label"].astype(str).str.strip() != ""].copy()

    agg = tmp.groupby(["sprint", "label"]).size().reset_index(name="defect_count")

    # Apply global sprint order
    sprint_ord = _sprint_order(df)
    if sprint_ord:
        sprint_rank = {s: i for i, s in enumerate(sprint_ord)}
        agg["sprint_rank"] = agg["sprint"].map(lambda x: sprint_rank.get(x, 999999))
        agg = agg.sort_values(["label", "sprint_rank", "sprint"]).drop(columns=["sprint_rank"])
    else:
        agg = agg.sort_values(["label", "sprint"])

    agg = agg.reset_index(drop=True)
    return agg[["sprint", "label", "defect_count"]]


def _forecast_for_series(series: List[float], steps: int = 3) -> List[float]:
    """
    MVP forecasting: capped smoothed-growth based on last-change.
    """
    if not series or len(series) == 0:
        return [0.0] * steps
    if len(series) == 1:
        return [float(series[-1])] * steps

    last = float(series[-1])
    prev = float(series[-2]) if series[-2] is not None else 0.0

    if prev == 0:
        recent_growth = 0.0 if last == 0 else 1.0
    else:
        recent_growth = (last - prev) / prev

    recent_growth = max(min(recent_growth, 1.0), -0.8)

    forecast = []
    next_val = last
    for _ in range(steps):
        next_val = max(0.0, next_val * (1.0 + recent_growth))
        forecast.append(round(next_val, 2))
    return forecast


def forecast_defect_trends(ts_df: pd.DataFrame, forecast_steps: int = 3) -> Dict[str, Dict[str, Any]]:
    """
    Given time-series DataFrame (sprint,label,defect_count), produce per-label forecast dict.
    Uses the global sprint order to ensure chronological consistency.
    """
    results: Dict[str, Dict[str, Any]] = {}
    if ts_df is None or ts_df.shape[0] == 0:
        return results

    sprint_ord = _sprint_order(ts_df)
    sprint_rank = {s: i for i, s in enumerate(sprint_ord)} if sprint_ord else {}

    labels = ts_df["label"].unique().tolist()
    for lab in labels:
        sub = ts_df[ts_df["label"] == lab].copy()

        if sprint_rank:
            sub["sprint_rank"] = sub["sprint"].map(lambda x: sprint_rank.get(x, 999999))
            sub = sub.sort_values(["sprint_rank", "sprint"]).drop(columns=["sprint_rank"])
        else:
            sub = sub.sort_values("sprint")

        history = [float(x) for x in sub["defect_count"].tolist()]
        sprints = [str(x) for x in sub["sprint"].tolist()]

        if len(history) < 2:
            forecast = [round(history[-1], 2) if history else 0.0 for _ in range(forecast_steps)]
        else:
            forecast = _forecast_for_series(history, steps=forecast_steps)

        results[lab] = {
            "sprints": sprints,
            "history": history,
            "forecast": forecast,
            "n_history": len(history),
            "delta_next": round(((forecast[0] - history[-1]) / history[-1] * 100) if history and history[-1] != 0 else 0.0, 2)
        }

    return results


def get_trend_insights(forecast_dict: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Build simple one-line insights per label based on last two history points.
    """
    out = []
    for lab, d in forecast_dict.items():
        hist = d.get("history", [])
        if len(hist) < 2:
            out.append({
                "label": lab,
                "trend": "insufficient_history",
                "growth_rate": 0.0,
                "message": f"Not enough history for '{lab}' to infer a trend."
            })
            continue
        prev = hist[-2]
        last = hist[-1]
        if prev == 0:
            growth = float("inf") if last > 0 else 0.0
        else:
            growth = ((last - prev) / prev) * 100.0
        trend = "upward" if growth > 5 else "downward" if growth < -5 else "stable"
        msg = f"{lab} defects showing a {trend} trend ({'∞' if growth==float('inf') else f'{growth:.1f}%'} change)."
        out.append({
            "label": lab,
            "trend": trend,
            "growth_rate": (0.0 if growth == float("inf") else round(growth, 2)),
            "message": msg
        })
    return out


def save_trend_cache(data: Dict[str, Any]) -> None:
    """Save cache atomically to TREND_CACHE_PATH."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = TREND_CACHE_PATH.with_suffix(".tmp.json")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(str(tmp), str(TREND_CACHE_PATH))
    except Exception as e:
        print(f"[trend_service] failed to write cache: {e}")


def load_trend_cache() -> Optional[Dict[str, Any]]:
    """Load cached trend data if exists."""
    if not TREND_CACHE_PATH.exists():
        return None
    try:
        with open(TREND_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[trend_service] failed to read cache: {e}")
        return None


def generate_forecast(forecast_steps: int = 3, use_cache_if_present: bool = True) -> Dict[str, Any]:
    """
    Loads corpus, builds time series, computes forecasts + insights.
    If use_cache_if_present and cache exists, returns cache.
    """
    if use_cache_if_present:
        cache = load_trend_cache()
        if cache:
            try:
                if "forecast" in cache and "insights" in cache:
                    return cache
            except Exception:
                pass

    df = _load_corpus()
    ts = build_defect_time_series(df)
    forecast_dict = forecast_defect_trends(ts, forecast_steps=forecast_steps)
    insights = get_trend_insights(forecast_dict)
    out = {"forecast": forecast_dict, "insights": insights}
    return out