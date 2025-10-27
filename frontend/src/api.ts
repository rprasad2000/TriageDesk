import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001/api/v1/ml";
export const api = axios.create({ baseURL: API_URL });

// --- Legacy-path redirect (compatibility) ---
api.interceptors.request.use(
  (config) => {
    if (config && typeof config.url === "string" && config.url.includes("/incidents/for-scatter")) {
      config.url = config.url.replace("/incidents/for-scatter", "/incidents");
      // If the old code included query parameters inside the url string, axios will keep them.
    }
    return config;
  },
  (err) => Promise.reject(err)
);


export type TrainResponse = { message: string; trained: boolean; classes: string[]; n_samples: number; metrics: any };
export type PredictResponse = { prediction: string; confidence: number; recommendations: any[] };

export const trainCsv = (csv_path: string) => api.post<TrainResponse>("/train/csv", { csv_path }).then(r => r.data);
export const trainJira = (jql?: string, max_results = 5000) => api.post<TrainResponse>("/train/jira", { jql, max_results }).then(r => r.data);
export const predict = (text: string, top_k = 5) => api.post<PredictResponse>("/predict", { text, top_k }).then(r => r.data);
export const feedback = (text: string, true_label: string, source = "user") => api.post("/feedback", { text, true_label, source }).then(r => r.data);
export const retrain = () => api.post<TrainResponse>("/retrain").then(r => r.data);

export const trainUpload = (file: File) => {
  const formData = new FormData();
  formData.append("file", file);
  return api.post<TrainResponse>("/train/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" }
  }).then(r => r.data);
};

export const syncBoard = (max_results = 2000) => api.post("/sync/board", { max_results }).then(r => r.data);
export const getIncidents = (max_results = 2000) =>
  api.get("/incidents", { params: { max_results } }).then((r) => r.data);

// Backwards-compatible alias in case code still calls the old `for-scatter` path
export const getIncidentsForScatter = (max_results = 1000) => getIncidents(max_results);

export const getDashboard = (start?: string, end?: string, group = "month", max_issues = 2000) => {
  const q = new URLSearchParams();
  if (start) q.set("start", start);
  if (end) q.set("end", end);
  q.set("group", group);
  q.set("max_issues", `${max_issues}`);
  return api.get(`/dashboard?${q.toString()}`).then(r => r.data);
};

/* --- New endpoints for Predict page --- */
export const getSprints = () => api.get<string[]>("/sprints").then(r => r.data);
export const getIssues = (sprint?: string, openOnly = true) => api.get(`/issues?sprint=${encodeURIComponent(sprint||"")}&openOnly=${openOnly}`).then(r => r.data);
export const predictBulk = (issue_keys?: string[], texts?: string[], top_k = 3) => api.post("/predict/bulk", { issue_keys, texts, top_k }).then(r => r.data);
export const feedbackBulk = (entries: { issue_key?: string; text?: string; true_label: string; source?: string }[]) => api.post("/feedback/bulk", { entries }).then(r => r.data);

export const getSprintsLive = (refresh = false) =>
  api.get<string[]>(`/sprints?refresh=${refresh}`).then(r => r.data);

export const syncJira = (sprint?: string, force = false) => {
  const q = new URLSearchParams();
  if (sprint) q.set("sprint", sprint);
  if (force) q.set("force", "true");
  return api.post(`/sync/jira?${q.toString()}`).then(r => r.data);
};



// Fetch aggregated label breakdown (open/closed/total counts)
export const getLabelBreakdown = async (status: "open" | "closed" | "both" = "both") => {
  const res = await api.get("/labels", { params: { status } });
  return res.data; // { labels: [...], other_count, total_labels }
};

// Fetch issues for a given label (with status filter)
export const getLabelIssues = async (
  label: string,
  status: "open" | "closed" | "both" = "both",
  max_results = 2000
) => {
  const res = await api.get(`/labels/${encodeURIComponent(label)}/issues`, {
    params: { status, max_results },
  });
  return res.data; // { label, status, count, issues: [...] }
};

// export const postJiraComment = (issueKey: string, comment: string) =>
//   api.post(`/issues/${issueKey}/comment`, { comment });

// add near postJiraComment in api.ts
export const postJiraComment = (issueKey: string, comment: string) =>
  api.post(`/issues/${encodeURIComponent(issueKey)}/comment`, { comment }).then(r => r.data);

export const postJiraLabels = (issueKey: string, label: string, mode: "add" | "replace" = "add") =>
  api.post(`/issues/${encodeURIComponent(issueKey)}/labels`, { label, mode }).then(r => r.data);

// Add after feedbackBulk (around line 60)

export const getFeedbackSummary = () => 
  api.get("/feedback/summary").then(r => r.data);

export const clearFeedback = () => 
  api.delete("/feedback/clear").then(r => r.data);

// Add to your existing api.ts file

export interface ForecastTrendResponse {
  sprints: string[];
  data: Array<{
    sprint: string;
    label: string;
    count: number;
    type: "actual" | "forecast";
    confidence?: number;
    lower_bound?: number;
    upper_bound?: number;
  }>;
  health_score: number;
  forecast_confidence: number;
  recommendations: Array<{
    type: "success" | "warning";
    message: string;
  }>;
  risks: Array<{
    label: string;
    type: string;
    percentage: string;
  }>;
  wins: Array<{
    label: string;
    type: string;
    percentage: string;
  }>;
  labels: string[];
  active_sprints: string[];
}

// Fetch forecast for active sprints only
export const getForecastTrendsActive = async (
  activeSprints?: string[],
  futurePeriods = 3
): Promise<ForecastTrendResponse> => {
  const params = new URLSearchParams();
  if (activeSprints && activeSprints.length > 0) {
    params.set("active_sprints", activeSprints.join(","));
  }
  params.set("future_periods", String(futurePeriods));
  
  const res = await api.get(`/forecast/trends/active?${params.toString()}`);
  return res.data;
};


// src/api.ts — replace existing getHeatmap implementation with this
export const getHeatmap = async (activeSprints?: string[], futurePeriods = 3) => {
  const params = new URLSearchParams();
  if (activeSprints && activeSprints.length) params.set("active_sprints", activeSprints.join(",")); // backend expects comma list
  params.set("future_periods", String(futurePeriods));

  // Try heatmap endpoint first (preferred). If it fails, attempt forecast endpoint and convert.
  try {
    const res = await api.get(`/heatmap?${params.toString()}`);
    // Expect res.data to be { sprints: string[], labels: string[], matrix: Record<string, number[]> }
    return res.data;
  } catch (heatErr: any) {
    // Log full server response if available (helps debugging backend 500)
    console.error("getHeatmap: /heatmap failed:", heatErr?.response?.status, heatErr?.response?.data || heatErr.message);

    // Fallback to forecast endpoint (convert into heatmap shape)
    try {
      const data = await api.get(`/forecast/trends/active?${params.toString()}`).then(r => r.data);
      const sprints = Array.isArray(data.sprints) ? data.sprints : [];
      const rows = Array.isArray(data.data) ? data.data : [];

      // Build labels as string[]
      const labels = Array.from(
        new Set(
          rows
            .map((r: any) => (r && r.label != null ? String(r.label) : ""))
            .filter((s: string) => s.trim() !== "")
        )
      ).sort() as string[];

      const matrix: Record<string, number[]> = {};
      labels.forEach((l) => (matrix[l] = sprints.map(() => 0)));

      rows.forEach((r: any) => {
        const lbl = r && r.label != null ? String(r.label) : "";
        if (!lbl) return;
        const i = sprints.indexOf(r.sprint);
        if (i >= 0) {
          matrix[lbl][i] = (matrix[lbl][i] || 0) + (Number(r.count) || 0);
        }
      });

      return { sprints, labels, matrix };
    } catch (fwErr: any) {
      // Both endpoints failed — log both errors and return a safe empty structure
      console.error("getHeatmap fallback: /forecast/trends/active failed:", fwErr?.response?.status, fwErr?.response?.data || fwErr.message);
      return { sprints: [], labels: [], matrix: {} as Record<string, number[]> };
    }
  }
};



export const getActiveSprints = async (): Promise<string[]> => {
  const allSprints = await getSprintsLive(false);
  return allSprints.slice(-2); // SIMPLE: Last 2 sprints
};