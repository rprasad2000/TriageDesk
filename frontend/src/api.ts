// src/api.ts
import axios from "axios";

const baseURL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001/api/v1/ml";
export const api = axios.create({ baseURL });

export type TrainResponse = { message: string; trained: boolean; classes: string[]; n_samples: number; metrics: any };
export type PredictResponse = { prediction: string; confidence: number; recommendations: any[] };

export const trainCsv = (csv_path: string) => api.post<TrainResponse>("/train/csv", { csv_path }).then(r => r.data);
export const trainJira = (jql?: string, max_results = 5000) => api.post<TrainResponse>("/train/jira", { jql, max_results }).then(r => r.data);
export const predict = (text: string, top_k = 5) => api.post<PredictResponse>("/predict", { text, top_k }).then(r => r.data);
export const feedback = (text: string, true_label: string, source = "user") => api.post("/feedback", { text, true_label, source }).then(r => r.data);
export const retrain = () => api.post<TrainResponse>("/retrain").then(r => r.data);

export const getIncidents = (max_results = 2000) => api.get(`/incidents?max_results=${max_results}`).then(r => r.data);
export const getDashboard = (start?: string, end?: string, group = "month", max_issues = 2000) => {
  const q = new URLSearchParams();
  if (start) q.set("start", start);
  if (end) q.set("end", end);
  q.set("group", group);
  q.set("max_issues", `${max_issues}`);
  return api.get(`/dashboard?${q.toString()}`).then(r => r.data);
};