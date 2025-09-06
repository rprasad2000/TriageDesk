# backend/services/model_service.py
import os, re, yaml, joblib, numpy as np, pandas as pd
from typing import List, Dict, Any, Optional
from datetime import datetime
from pathlib import Path
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics.pairwise import linear_kernel
from sklearn.model_selection import GroupShuffleSplit
from sklearn.metrics import accuracy_score, classification_report
from sklearn.metrics.pairwise import linear_kernel

# ---------------- Paths & artifacts ----------------
MODELS_DIR = Path("backend/models")
DATA_DIR = Path("backend/data")
MODELS_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

MODEL_PATH   = MODELS_DIR / "clf_mnb.joblib"
VECT_PATH    = MODELS_DIR / "tfidf.joblib"
ENC_PATH     = MODELS_DIR / "label_encoder.joblib"
MATRIX_PATH  = MODELS_DIR / "tfidf_matrix.npz"
CORPUS_PATH  = MODELS_DIR / "corpus.parquet"
FEEDBACK_PATH = DATA_DIR / "feedback.parquet"

# ---------------- Label aliases (config-driven, optional) ----------------
def _load_aliases() -> List[Dict[str, str]]:
    try:
        with open("config.yaml", "r") as f:
            cfg = yaml.safe_load(f) or {}
        return (cfg.get("LABELS") or {}).get("ALIASES", []) or []
    except Exception:
        return []

_ALIAS_PATTERNS = [
    (re.compile(a["pattern"]), a["map_to"]) for a in _load_aliases()
    if isinstance(a, dict) and "pattern" in a and "map_to" in a
]

def _alias_map(raw: str) -> str:
    s = (str(raw) if raw is not None else "").strip()
    if not s:
        return ""
    for rx, target in _ALIAS_PATTERNS:
        if rx.search(s):
            return target
    return s  # keep unknown/new labels (open taxonomy)

def normalize_df_labels_config(df: pd.DataFrame, col: str = "label") -> pd.DataFrame:
    if col not in df.columns:
        df[col] = ""
    df[col] = df[col].map(_alias_map).astype(str).str.strip()
    return df

# ---------------- Utils ----------------
def _flatten_adf(adf: Any) -> str:
    if isinstance(adf, str):
        return adf
    if isinstance(adf, dict) and adf.get("content"):
        out = []
        for para in adf["content"]:
            for item in para.get("content", []):
                if item.get("type") == "text":
                    out.append(item.get("text", ""))
        return " ".join(out)
    return ""

def _ensure_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    cols = {c.lower().strip(): c for c in df.columns}

    def pick_col(possible: List[str], default: Optional[str] = None) -> pd.Series:
        for k in possible:
            if k in cols:
                return df[cols[k]]
        if default is not None and default in df.columns:
            return df[default]
        # if nothing found return a blank series
        return pd.Series([""] * len(df))

    issue_key = pick_col(["issue key", "issue_key", "key", "ticket_id", "id"]).astype(str)
    summary = pick_col(["summary", "short_description"]).astype(str)
    # description fallback
    if "ticket_description" in cols:
        desc = df[cols["ticket_description"]].astype(str)
    elif "description" in cols:
        desc = df[cols["description"]].astype(str)
    else:
        desc = summary.astype(str)

    # label candidates
    label = pick_col(["classify label", "label", "labels", "category", "type"]).astype(str)

    url = pick_col(["url", "link"]).astype(str)

    # metadata: look for common date names (Created, created_at, created)
    created = pick_col(["created", "created_at", "created date", "creation_date", "createdon", "created_on", "created"]).astype(str)

    priority = pick_col(["priority"]).astype(str)
    status = pick_col(["status"]).astype(str)
    severity = pick_col(["severity", "customfield_10106"]).astype(str)
    root_cause = pick_col(["root_cause", "rootcause", "customfield_10104"]).astype(str)

    # sprint: any column name containing 'sprint'
    sprint_col = next((cols[k] for k in cols if "sprint" in k), None)
    if sprint_col:
        sprint = df[sprint_col].astype(str)
    else:
        sprint = pd.Series([""] * len(df))

    return pd.DataFrame({
        "issue_key": issue_key,
        "summary": summary,
        "ticket_description": desc,
        "url": url,
        "label": label,
        "created": created,
        "priority": priority,
        "status": status,
        "severity": severity,
        "root_cause": root_cause,
        "sprint": sprint
    })


def _save_sparse(mat, path: Path): sparse.save_npz(str(path), mat)
def _load_sparse(path: Path): return sparse.load_npz(str(path))
def _host_issue_url(host: str, key: str) -> str: return f"{host.rstrip('/')}/browse/{key}"

# strong, order-insensitive fingerprint to group near-duplicates (prevents leakage)
_STOP = set("a an and are as at be but by for if in into is it of on or such that the their then there these this to was were will with your you from not can could should would".split())
def _canon_fingerprint(s: str) -> str:
    t = str(s).lower()
    t = re.sub(r"https?://\S+|www\.\S+"," ", t)
    t = re.sub(r"\d+","#", t)
    t = re.sub(r"[^a-z#\s]"," ", t)
    toks = [w for w in t.split() if w not in _STOP and len(w)>1]
    uniq = sorted(set(toks))
    return " ".join(uniq[:24]) if uniq else ""

# ---------------- Train (leak-free eval, concise) ----------------
def train_from_dataframe(df: pd.DataFrame) -> Dict[str, Any]:
    df = _ensure_dataframe(df).dropna(subset=["ticket_description"]).reset_index(drop=True)
    df = normalize_df_labels_config(df, "label")

    # supervised subset
    has_labels = df["label"].astype(str).str.strip().ne("").any()
    df_l = df[df["label"].astype(str).str.strip() != ""].reset_index(drop=True) if has_labels else df.copy()

    metrics: Dict[str, Any] = {}
    trained = False
    classes_out: List[str] = []

    if has_labels and df_l["label"].nunique() >= 2:
        # group-aware split (no leakage)
        df_l["__grp"] = df_l["ticket_description"].astype(str).map(_canon_fingerprint)
        X_all = df_l["ticket_description"].astype(str)
        y_all = df_l["label"].astype(str).str.strip()
        groups = df_l["__grp"]

        enc_eval = LabelEncoder()
        y_all_enc = enc_eval.fit_transform(y_all)

        gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
        tr, te = next(gss.split(X_all, y_all_enc, groups))

        vec_eval = TfidfVectorizer(max_features=8000, ngram_range=(1,2))
        X_tr = vec_eval.fit_transform(X_all.iloc[tr])
        X_te = vec_eval.transform(X_all.iloc[te])

        clf_eval = MultinomialNB()
        clf_eval.fit(X_tr, y_all_enc[tr])
        y_pred = clf_eval.predict(X_te)

        acc = accuracy_score(y_all_enc[te], y_pred)
        all_idx = np.arange(len(enc_eval.classes_))
        metrics = {
            "accuracy": float(acc),
            "report": classification_report(
                y_all_enc[te], y_pred,
                labels=all_idx,
                target_names=list(enc_eval.classes_),
                zero_division=0,
            ),
        }

        # -------- Production artifacts (fit on FULL data) --------
        vec = TfidfVectorizer(max_features=8000, ngram_range=(1,2))
        X_full = vec.fit_transform(df["ticket_description"].astype(str))

        enc = LabelEncoder().fit(df_l["label"].astype(str))
        y_full_enc = enc.transform(df_l["label"].astype(str))
        X_full_labeled = vec.transform(df_l["ticket_description"].astype(str))

        clf = MultinomialNB().fit(X_full_labeled, y_full_enc)

        joblib.dump(clf, MODEL_PATH)
        joblib.dump(enc,  ENC_PATH)
        joblib.dump(vec,  VECT_PATH)
        _save_sparse(X_full, MATRIX_PATH)

        trained = True
        classes_out = list(enc.classes_)

    else:
        # no labels → recommendations only
        vec = TfidfVectorizer(max_features=8000, ngram_range=(1,2))
        X_full = vec.fit_transform(df["ticket_description"].astype(str))
        joblib.dump(vec, VECT_PATH)
        _save_sparse(X_full, MATRIX_PATH)

    # persist corpus for recommendations
    # persist corpus for recommendations + metadata required by dashboard
    cols_to_save = [
        "issue_key",
        "summary",
        "ticket_description",
        "url",
        "label",
        "created",      # <--- needed by /dashboard
        "priority",
        "status",
        "severity",
        "root_cause",
        "sprint"
    ]
    # keep only columns that exist in df to avoid KeyError
    cols_to_save = [c for c in cols_to_save if c in df.columns]
    df[cols_to_save].to_parquet(CORPUS_PATH, index=False)

    return {
        "trained": trained,
        "classes": classes_out,
        "n_samples": int(df.shape[0]),
        "metrics": metrics
    }

# ---------------- Jira → DataFrame ----------------
def build_df_from_jira_issues(issues: List[Dict[str, Any]], host: str) -> pd.DataFrame:
    """
    Build a normalized DataFrame from Jira issues and include Sprint when present.

    Notes on Sprint field:
    - In classic Jira it is usually `customfield_10020`
    - The value can be:
        * a list of dicts: [{"id": "...", "name": "Sprint 3 (2024)", ...}, ...]
        * a list of strings: ["com.atlassian.greenhopper.service.sprint.Sprint@...name=Sprint 3,...", ...]
        * a single dict or string
    We try to parse any of the above and take the *latest* sprint name if multiple exist.
    """
    def _extract_sprint_name(fields: Dict[str, Any]) -> str:
        # 1) Prefer well-known key
        candidates = []
        if "customfield_10020" in fields:
            candidates.append(("customfield_10020", fields.get("customfield_10020")))

        # 2) Fallback: scan any key that looks like 'sprint' (case-insensitive)
        for k, v in fields.items():
            if "sprint" in str(k).lower() and k != "customfield_10020":
                candidates.append((k, v))

        def _parse_one(val: Any) -> list[str]:
            names: list[str] = []
            if isinstance(val, list):
                for item in val:
                    names.extend(_parse_one(item))
            elif isinstance(val, dict):
                # Most modern Jira return dicts with "name"
                n = val.get("name")
                if isinstance(n, str) and n.strip():
                    names.append(n.strip())
            elif isinstance(val, str):
                # Old Agile plugin returns string blobs; pull name=... until comma or ]
                m = re.search(r"name=([^,\]]+)", val)
                if m:
                    names.append(m.group(1).strip())
            return names

        for _k, v in candidates:
            names = _parse_one(v)
            if names:
                # if multiple sprints, take the last (usually the most recent board sprint)
                return names[-1]
        return ""
   
    rows = []
    for raw in issues:
        key = raw.get("key")
        fields = raw.get("fields", {}) or {}

        summary = (fields.get("summary") or "") or ""
        desc_block = fields.get("description", "")
        description = _flatten_adf(desc_block) if isinstance(desc_block, dict) else (desc_block or "")
        text = (summary + " " + description).strip()

        # common fields
        created = fields.get("created", "") or ""
        status = (fields.get("status") or {}).get("name", "") or ""
        priority = (fields.get("priority") or {}).get("name", "") or ""

        # your project’s custom fields (adjust IDs if different)
        severity = fields.get("customfield_10106", "") or ""
        root_cause = fields.get("customfield_10104", "") or ""

        # labels (single-label for classifier)
        labels_list = fields.get("labels") or []
        label_value = labels_list[0] if isinstance(labels_list, list) and labels_list else ""

        # sprint
        sprint_name = _extract_sprint_name(fields)
        


        url = _host_issue_url(host, key) if key else ""

        rows.append({
            "issue_key": key,
            "summary": summary,
            "ticket_description": text,
            "url": url,
            "label": label_value,
            "created": created,
            "priority": priority,
            "status": status,
            "severity": severity,
            "root_cause": root_cause,
            "sprint": sprint_name,   # <-- ✅ new
        })

    return pd.DataFrame(rows)



# ---------------- Predict + Recommend ----------------
def _load_artifacts(require_classifier: bool = True):
    if not VECT_PATH.exists() or not MATRIX_PATH.exists() or not CORPUS_PATH.exists():
        raise FileNotFoundError("Model artifacts not found. Train first.")
    vectorizer = joblib.load(VECT_PATH)
    tfidf_matrix = _load_sparse(MATRIX_PATH)
    corpus = pd.read_parquet(CORPUS_PATH)

    # Defensive alignment: ensure tfidf_matrix rows and corpus rows match.
    try:
        n_mat = int(tfidf_matrix.shape[0])
        n_corpus = len(corpus)
        if n_mat != n_corpus:
            # truncate both to the smaller dimension to avoid indexing errors
            m = min(n_mat, n_corpus)
            # slice sparse matrix and dataframe
            tfidf_matrix = tfidf_matrix[:m]
            corpus = corpus.iloc[:m].reset_index(drop=True)
            # log a clear warning so future debugging is easy
            print(f"[WARN] artifact row-count mismatch: tfidf_matrix={n_mat}, corpus={n_corpus}. Truncated to {m}.")
    except Exception as e:
        # be defensive but continue if something odd happens
        print(f"[WARN] failed to validate artifact shapes: {e}")

    clf = enc = None
    if require_classifier:
        if not MODEL_PATH.exists() or not ENC_PATH.exists():
            raise FileNotFoundError("Classifier artifacts not found. Train with labeled data.")
        clf = joblib.load(MODEL_PATH)
        enc = joblib.load(ENC_PATH)
    return vectorizer, tfidf_matrix, corpus, clf, enc


def classify_and_recommend(text: str, top_k: int = 5) -> Dict[str, Any]:
    vectorizer, tfidf_matrix, corpus, clf, enc = _load_artifacts(require_classifier=True)
    q_vec = vectorizer.transform([text])

    proba = clf.predict_proba(q_vec)[0]
    pred_idx = int(np.argmax(proba))
    pred_label = enc.inverse_transform([pred_idx])[0]
    confidence = float(proba[pred_idx])

    sims = linear_kernel(q_vec, tfidf_matrix).ravel()
    top_idx = sims.argsort()[::-1][:top_k]
    recs = [{
        "issue_key": corpus.iloc[i]["issue_key"],
        "summary": corpus.iloc[i]["summary"],
        "url": corpus.iloc[i]["url"],
        "similarity": float(sims[i]),
        "label": corpus.iloc[i].get("label", "")
    } for i in top_idx]

    return {"prediction": pred_label, "confidence": confidence, "recommendations": recs}

# ---------------- Feedback ----------------
def save_feedback(text: str, true_label: str, source: str = "user") -> None:
    rec = pd.DataFrame([{
        "text": text, "true_label": true_label,
        "when": datetime.utcnow().isoformat(), "source": source
    }])
    if FEEDBACK_PATH.exists():
        base = pd.read_parquet(FEEDBACK_PATH)
        pd.concat([base, rec], ignore_index=True).to_parquet(FEEDBACK_PATH, index=False)
    else:
        rec.to_parquet(FEEDBACK_PATH, index=False)

def retrain_with_feedback() -> Dict[str, Any]:
    if not CORPUS_PATH.exists():
        raise FileNotFoundError("No base corpus found. Train at least once.")
    corpus = pd.read_parquet(CORPUS_PATH)
    if FEEDBACK_PATH.exists():
        fb = pd.read_parquet(FEEDBACK_PATH)
        fb_df = pd.DataFrame({
            "issue_key": ["FEED-"+str(i) for i in range(len(fb))],
            "summary": "",
            "ticket_description": fb["text"].astype(str),
            "url": "",
            "label": fb["true_label"].astype(str)
        })
        merged = pd.concat([corpus, fb_df], ignore_index=True)
    else:
        merged = corpus
    return train_from_dataframe(merged)

def classify_and_recommend_batch(texts: List[str], top_k: int = 3) -> List[Dict[str, Any]]:
    """
    Return a list of dicts with keys: prediction, confidence, recommendations (list)
    for each input text. Uses vectorized operations.
    """
    vectorizer, tfidf_matrix, corpus, clf, enc = _load_artifacts(require_classifier=True)
    # vectorize all texts at once
    q_vec = vectorizer.transform([str(t) for t in texts])
    proba = clf.predict_proba(q_vec)  # shape: (n_texts, n_classes)
    pred_idx = np.argmax(proba, axis=1)
    confidences = proba[np.arange(len(pred_idx)), pred_idx].astype(float)
    pred_labels = enc.inverse_transform(pred_idx.tolist())

    # similarity matrix: compute row-wise linear_kernel between q_vec and tfidf_matrix
    sims = linear_kernel(q_vec, tfidf_matrix)  # shape: (n_texts, n_corpus)
    results = []
    for i in range(q_vec.shape[0]):
        sim_row = sims[i]
        top_idx = sim_row.argsort()[::-1][:top_k]
        recs = [{
            "issue_key": corpus.iloc[j]["issue_key"],
            "summary": corpus.iloc[j]["summary"],
            "url": corpus.iloc[j]["url"],
            "similarity": float(sim_row[j]),
            "label": corpus.iloc[j].get("label", "")
        } for j in top_idx]
        results.append({
            "prediction": str(pred_labels[i]),
            "confidence": float(confidences[i]),
            "recommendations": recs
        })
    return results