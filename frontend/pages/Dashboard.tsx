// src/pages/Dashboard.tsx
import React, { useMemo, useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, syncBoard, getSprintsLive, getLabelBreakdown   } from "../src/api";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Brush, BarChart, Bar, PieChart, Pie, Cell,
} from "recharts";
import dayjs from "dayjs";
import quarterOfYear from "dayjs/plugin/quarterOfYear";
dayjs.extend(quarterOfYear);
import LabelBreakdownChart from "../src/components/LabelBreakdownChart";
import LabelIssuesModal from "../src/components/LabelIssuesModal";
const JIRA_HOST = import.meta.env.VITE_JIRA_HOST || "";


type Incident = {
  incident_no: string;
  creation_time: string;
  priority: string;
  brief_detail: string;
  description: string;
  status: string;
  severity: string;
  root_cause: string;
  prediction: string;
  confidence_score: number;
  recommendation?: any;
  Sprint?: string;
};

type KPIData = {
  total: number;
  open: number;
  closed: number;
  highSeverity: number;
};

const parseDate = (s?: string) => {
  if (!s) return null;
  const iso = dayjs(s);
  if (iso.isValid()) return iso;
  const a = dayjs(s, "YYYY-MM-DD", true);
  if (a.isValid()) return a;
  const b = dayjs(s, "DD-MM-YYYY", true);
  if (b.isValid()) return b;
  return null;
};

const sprintSortKey = (label: string): [number, number] => {
  const m = label?.match(/Sprint\s+(\d+)\s*\((\d{4})\)/i);
  if (m) return [parseInt(m[2], 10), parseInt(m[1], 10)];
  const d = dayjs(label, "MMM-YYYY", true);
  if (d.isValid()) return [d.year(), d.month() + 1];
  return [9999, 9999];
};

const QUARTER_LABEL = (d: dayjs.Dayjs) => `Q${d.quarter()}-${d.year()}`;
const COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff7f50", "#8dd1e1", "#a4de6c", "#d0ed57", "#d66ad1"];
// Updated HIGH_SEV to actual severity values (Blocker, Critical, Major)
const HIGH_SEV = new Set(["Blocker", "Critical", "Major"]);
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [yearFilter, setYearFilter] = useState<string>("All");
  const [viewBy, setViewBy] = useState<"sprint" | "month" | "quarter">("sprint");
  const [monthFilter, setMonthFilter] = useState<string>("All"); // '1'..'12' or 'All'
  const [sprintFilter, setSprintFilter] = useState<string>("All");
  const [syncingBoard, setSyncingBoard] = useState<boolean>(false);
  const [liveKPIs, setLiveKPIs] = useState<KPIData | null>(null);

const [labelsData, setLabelsData] = useState<any[]>([]);
const [labelModal, setLabelModal] = useState<string | null>(null);


const {
  data: labelsQueryData,
  refetch: refetchLabelBreakdown,
} = useQuery({
  queryKey: ["labelBreakdown"],
  queryFn: () => getLabelBreakdown("both").then((r) => r || { labels: [] }),
  staleTime: 60_000, // 1 minute
});

useEffect(() => {
  setLabelsData((labelsQueryData && labelsQueryData.labels) || []);
}, [labelsQueryData]);



  // Priority modal state (add near other useState declarations)
const [priorityModalOpen, setPriorityModalOpen] = useState(false);
const [priorityModalKey, setPriorityModalKey] = useState<string | null>(null);
const [priorityFilterText, setPriorityFilterText] = useState("");
const [priorityPage, setPriorityPage] = useState<number>(0);
const PRIORITY_PAGE_SIZE = 25;

const openPriorityModal = (pkey: string) => {
  setPriorityModalKey(pkey);
  setPriorityFilterText("");
  setPriorityPage(0);
  setPriorityModalOpen(true);
};
const closePriorityModal = () => setPriorityModalOpen(false);
  
// modal state
const [labelModalOpen, setLabelModalOpen] = useState(false);
const [labelModalName, setLabelModalName] = useState<string | null>(null);

const openLabelModal = (name: string) => { setLabelModalName(name); setLabelModalOpen(true); };
const closeLabelModal = () => { setLabelModalOpen(false); setLabelModalName(null); };









  /* ===== in-app confirm/message dialogs (replaces window.confirm/alert) ===== */
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [confirmMessage, setConfirmMessage] = useState<string>("");
  const confirmResolveRef = useRef<((val: boolean) => void) | null>(null);

  const [msgOpen, setMsgOpen] = useState<boolean>(false);
  const [msgText, setMsgText] = useState<string>("");

  const showConfirm = (message: string): Promise<boolean> => {
    setConfirmMessage(message);
    setConfirmOpen(true);
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
    });
  };
  const _closeConfirm = (ok: boolean) => {
    setConfirmOpen(false);
    try { confirmResolveRef.current?.(ok); } catch (e) { /* ignore */ }
    confirmResolveRef.current = null;
  };

  const showMessage = (text: string) => {
    setMsgText(text);
    setMsgOpen(true);
  };
  const closeMessage = () => setMsgOpen(false);

  // ESC to close dialogs
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

  // inside Dashboard component — replace existing handleRefreshBoard with this
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


  const computeKpisFromIncidents = (incidents: Incident[] | undefined) => {
    if (!Array.isArray(incidents)) return { total: 0, open: 0, closed: 0, highSeverity: 0 };
    const total = incidents.length;
    let open = 0, closed = 0, highSeverity = 0;
    const HIGH_SEVERITIES = new Set(["Blocker", "Critical", "Major"]);
    for (const it of incidents) {
      const st = (it.status || "").toLowerCase();
      if (st.includes("done") || st.includes("closed") || st.includes("resolved")) closed++;
      else open++;
      if (HIGH_SEV.has((it.severity || "").trim())) highSeverity++;
    }
    return { total, open, closed, highSeverity };
  };


  // replace your existing handleRefreshBoard with this exact function
const handleRefreshBoard = async () => {
  const ok = await showConfirm("Refresh board from Jira? This will fetch the latest dashboard data (no model changes).");
  if (!ok) return;
  setSyncingBoard(true);

  try {
    // Force backend to fetch fresh Jira data and update the corpus (synchronous path)
    // getSprintsLive(true) calls GET /sprints?refresh=true which merges/writes corpus on server
    const sprints = await getSprintsLive(true).catch((e) => {
      console.warn("getSprintsLive(refresh) failed:", e);
      return null;
    });

    // After refresh attempt, fetch fresh incidents (this will read the updated corpus on server)
    const freshIncidents = await api
      .get("/incidents", { params: { max_results: 5000 } })
      .then((r) => r.data)
      .catch((e) => {
        console.error("Failed to fetch incidents after sync:", e);
        return null;
      });

    if (Array.isArray(freshIncidents)) {
      // update the cached query so UI is updated immediately
      queryClient.setQueryData(["incidents", "all"], freshIncidents);
      // update sprints cache if backend returned them
      if (Array.isArray(sprints)) {
        queryClient.setQueryData(["sprints"], sprints);
      }
      // update live KPIs using the same client-side compute function
      setLiveKPIs(computeKpisFromIncidents(freshIncidents as any));
      // keep KPIs visible briefly so user sees new counts
      setTimeout(() => setLiveKPIs(null), 1200);
      showMessage("Jira sync completed and dashboard refreshed.");
      // ensure label breakdown is refreshed so right-side counts update
      try {
  // refetchLabelBreakdown() returns a QueryObserverResult — use its `.data`
  const refetchResult = await refetchLabelBreakdown?.();
  // refetchResult may be undefined (guard) or a QueryObserverResult with `.data`
  const newLabelsPayload = refetchResult?.data ?? refetchResult ?? null;

  // normalise/fallback: if the returned value is an object { labels: [...] } use it
  const newLabels = (newLabelsPayload && (newLabelsPayload.labels || newLabelsPayload)) || [];

  // set local state to the fresh labels array (ensures chart receives updated prop)
  setLabelsData(Array.isArray(newLabels) ? newLabels : (newLabels.labels ?? []));
} catch (e) {
  console.warn("Failed to refetch label breakdown:", e);
  // as fallback, invalidate so query eventually refreshes and useEffect will pick it up
  queryClient.invalidateQueries({ queryKey: ["labelBreakdown"] });
}


    } else {
      // fallback: if refresh endpoint failed, still try the server-side /sync/board (read-only)
      const res = await api.post("/sync/board", { max_results: 5000 }).then((r) => r.data).catch(() => null);
      if (res?.kpis) {
        setLiveKPIs({
          total: Number(res.kpis.total ?? res.n_issues ?? 0),
          open: Number(res.kpis.open ?? 0),
          closed: Number(res.kpis.closed ?? 0),
          highSeverity: Number(res.kpis.highSeverity ?? 0),
        });
      }
      // refresh incidents query in background
      queryClient.invalidateQueries({ queryKey: ["incidents", "all"] });
      showMessage("Sync started or completed (partial). If changes don't appear try Refresh again in a few seconds.");

      // ensure label breakdown is refreshed after a successful sync
      queryClient.invalidateQueries({ queryKey: ["labelBreakdown"] });

    }
  } catch (err: any) {
    console.error("Refresh board failed:", err);
    showMessage("Board refresh failed: " + (err?.message || String(err)));
    setLiveKPIs(null);
  } finally {
    setSyncingBoard(false);
  }
};



  const { data, isLoading, isError, error, refetch } = useQuery<Incident[]>({
    queryKey: ["incidents", "all"],
    queryFn: () => api.get("/incidents", { params: { max_results: 5000 } }).then(r => r.data),
    staleTime: 60_000,
  });

  const {
    yearsInData,
    rows,
    sprintSeries,
    monthSeries,
    quarterSeveritySeries,
    severitiesOrdered,
    priorityBreakdown,
    kpis,
    availableMonths,
    availableSprints
  } = useMemo(() => {
    const yearsSet = new Set<number>();
    const filtered: Incident[] = [];

    if (Array.isArray(data)) {
      for (const i of data) {
        const d = parseDate(i.creation_time);
        if (!d) continue;
        yearsSet.add(d.year());
        if (yearFilter !== "All" && String(d.year()) !== yearFilter) continue;
        filtered.push(i);
      }
    }

    const total = filtered.length;
    let open = 0, closed = 0, highSeverity = 0;
    for (const i of filtered) {
      const st = (i.status || "").toLowerCase();
      if (st.includes("done") || st.includes("closed") || st.includes("resolved")) closed++;
      else open++;
      if (HIGH_SEV.has((i.severity || "").trim())) highSeverity++;
    }

    // SPRINT series (counts per sprint or month fallback)
    const sprintCounts: Record<string, number> = {};
    const sprintsSet = new Set<string>();
    const monthsSet = new Set<number>();
    for (const i of filtered) {
      const d = parseDate(i.creation_time);
      if (!d) continue;
      const label = (i.Sprint && i.Sprint.trim()) ? i.Sprint.trim() : d.format("MMM-YYYY");
      sprintCounts[label] = (sprintCounts[label] || 0) + 1;
      if (i.Sprint && i.Sprint.trim()) sprintsSet.add(i.Sprint.trim());
      monthsSet.add(d.month() + 1);
    }
    const sprintSeries = Object.entries(sprintCounts)
      .map(([sprint, count]) => ({ sprint, count }))
      .sort((a, b) => {
        const [ya, sa] = sprintSortKey(a.sprint);
        const [yb, sb] = sprintSortKey(b.sprint);
        return ya === yb ? sa - sb : ya - yb;
      });

    // MONTH series: group by YYYY-MM (respect the year filter)
    const monthCounts: Record<string, number> = {};
    for (const i of filtered) {
      const d = parseDate(i.creation_time);
      if (!d) continue;
      // apply monthFilter if set
      if (monthFilter !== "All" && String(d.month() + 1) !== monthFilter) continue;
      // apply sprintFilter if set (when user wants to restrict by sprint)
      if (sprintFilter !== "All" && String(i.Sprint || "") !== sprintFilter) continue;
      const key = `${d.year()}-${String(d.month() + 1).padStart(2, "0")}`;
      monthCounts[key] = (monthCounts[key] || 0) + 1;
    }
    const monthSeries = Object.keys(monthCounts)
      .sort((a, b) => new Date(a + "-01").getTime() - new Date(b + "-01").getTime())
      .map(k => {
        const [y, m] = k.split("-");
        const monthLabel = monthNames[Number(m) - 1] ?? m;
        return { period: k, label: `${monthLabel}-${y}`, count: monthCounts[k] };
      });

    // Quarter vs severity
    const quarterMap: Record<string, Record<string, number>> = {};
    const sevSet = new Set<string>();
    for (const i of filtered) {
      const d = parseDate(i.creation_time);
      if (!d) continue;
      const q = `Q${d.quarter()}-${d.year()}`;
      const sev = (i.severity || "Unknown").trim();
      sevSet.add(sev);
      quarterMap[q] ??= {};
      quarterMap[q][sev] = (quarterMap[q][sev] || 0) + 1;
    }

    // canonical severity ordering for chart consistency
    const canonicalSeverityOrder = ["Blocker", "Critical", "Major", "Minor", "Unknown"];
    const severitiesOrdered = Array.from(sevSet).sort((a, b) => {
      const ia = canonicalSeverityOrder.indexOf(a);
      const ib = canonicalSeverityOrder.indexOf(b);
      if (ia === -1 && ib === -1) return String(a).localeCompare(String(b));
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    const quarterSeveritySeries = Object.entries(quarterMap)
      .map(([quarter, sevCounts]) => ({ quarter, ...sevCounts }))
      .sort((a, b) => {
        const ma = a.quarter.match(/Q(\d)-(\d{4})/);
        const mb = b.quarter.match(/Q(\d)-(\d{4})/);
        if (ma && mb) {
          const ya = parseInt(ma[2], 10), yb = parseInt(mb[2], 10);
          const qa = parseInt(ma[1], 10), qb = parseInt(mb[1], 10);
          return ya === yb ? qa - qb : ya - yb;
        }
        return a.quarter.localeCompare(b.quarter);
      });

    // priority breakdown (canonical order High, Medium, Low)
    const prCounts: Record<string, number> = {};
    for (const i of filtered) {
      const p = (i.priority || "Unknown").trim();
      prCounts[p] = (prCounts[p] || 0) + 1;
    }
    const canonicalPriorities = ["High", "Medium", "Low"];
    const priorityBreakdownOrdered = [
      ...canonicalPriorities.map(p => ({ name: p, value: prCounts[p] || 0 })).filter(x => x.value > 0),
      ...Object.entries(prCounts)
        .filter(([k]) => !canonicalPriorities.includes(k))
        .map(([name, value]) => ({ name, value }))
    ];

    return {
      yearsInData: Array.from(yearsSet).sort((a, b) => b - a),
      rows: filtered,
      sprintSeries,
      monthSeries,
      quarterSeveritySeries,
      severitiesOrdered,
      priorityBreakdown: priorityBreakdownOrdered,
      kpis: { total, open, closed, highSeverity },
      availableMonths: Array.from(monthsSet).sort((a, b) => a - b),
      availableSprints: Array.from(sprintsSet).sort(),
    };
  }, [data, yearFilter, monthFilter, sprintFilter]);

  // Priority mapping + grouping (add right after your big useMemo that yields `rows`)
const PRIORITY_MAP: Record<string, string> = {
  high: "P1",
  highest: "P1",
  medium: "P2",
  low: "P3",
  lowest: "P4",
};

const priorityGroups = useMemo(() => {
  type Group = { label: string; count: number; items: Incident[] };
  const groups: Record<string, Group> = {};
  // Ensure canonical buckets exist
  ["P1", "P2", "P3", "P4", "Other"].forEach((k) => {
    groups[k] = { label: k, count: 0, items: [] };
  });

  for (const r of (rows || [])) {
    const raw = (r.priority || "").toString().trim();
    const mapped = (PRIORITY_MAP[raw.toLowerCase()] || "Other");
    groups[mapped].count++;
    groups[mapped].items.push(r);
  }

  // set a human label for each P bucket from a sample item if available
  ["P1", "P2", "P3", "P4"].forEach((k) => {
    if (groups[k].items.length > 0) groups[k].label = groups[k].items[0].priority || groups[k].label;
  });

  return groups;
}, [rows]);


  // Use live KPIs if available, otherwise use computed KPIs
  const displayKPIs = liveKPIs || (kpis as any);

  const sprintChartWidth = Math.max(900, (viewBy === "sprint" ? sprintSeries.length : monthSeries.length) * 120);
  const quarterChartWidth = Math.max(800, quarterSeveritySeries.length * 160);

  // show a full-screen loading overlay while data loads (prettier than a plain text)
if (isLoading) {
  return (
    <div style={{ minHeight: "60vh", position: "relative" }}>
      <div className="modal-overlay" style={{ background: "rgba(0,0,0,0.05)", zIndex: 100 }}>
        <div
          className="modal-panel"
          style={{
            width: "min(520px, 92%)",
            padding: 20,
            textAlign: "center",
            boxShadow: "none",
            background: "transparent",
            transform: "none",
            animation: "none",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, marginTop: 20 }}>
            <div className="loading-bar" />
            <img className="rotating-img" src="/bug.png" alt="Loading..." />
            <div style={{ fontSize: 13, color: "#6B778C" }}>Fetching latest issues and KPIs...</div>
          </div>

        </div>
      </div>
    </div>
  );
}

  if (isError) {
    console.error("Error fetching incidents:", error);
    return <p style={{ color: "crimson" }}>⚠ Error fetching incidents</p>;
  }
  if (!data || data.length === 0) return <p>No incidents found.</p>;

  // choose series to render in top chart based on viewBy
  const topSeries = viewBy === "sprint"
    ? sprintSeries.map(s => ({ label: s.sprint, count: s.count }))
    : viewBy === "month"
      ? monthSeries.map(m => ({ label: m.label, count: m.count }))
      : // quarter grouping: convert quarterSeveritySeries into simple counts (sum of severities)
      quarterSeveritySeries.map(q => {
        const total = Object.keys(q).filter(k => k !== "quarter").reduce((acc, k) => acc + (q as any)[k], 0);
        return { label: q.quarter, count: total };
      });

  return (
    <div style={{ padding: "2rem" }}>
      <h2>Defect Dashboard</h2>

      <div style={{ margin: "0 0 1rem 0", display: "flex", gap: 12, alignItems: "center" }}>
        <div>
          <label style={{ marginRight: 8 }}>Year:</label>
          <select value={yearFilter} onChange={(e) => { setYearFilter(e.target.value); setMonthFilter("All"); setSprintFilter("All"); }}>
            <option value="All">All</option>
            {yearsInData.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
        </div>

        <div>
          <label style={{ marginLeft: 8, marginRight: 8 }}>View:</label>
          <select value={viewBy} onChange={(e) => setViewBy(e.target.value as any)}>
            <option value="sprint">Sprint</option>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
          </select>
        </div>

        <div>
          <label style={{ marginLeft: 8, marginRight: 8 }}>Month:</label>
          <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
            <option value="All">All</option>
            {availableMonths.map(m => <option key={m} value={String(m)}>{monthNames[m - 1]} ({m})</option>)}
          </select>
        </div>
        <button
          onClick={handleRefreshBoard}
          disabled={syncingBoard}
          className="btn btn-warning btn-pill"
          style={{ marginLeft: "auto" }}
          title="Refresh board from Jira"
        >
          {syncingBoard ? <><span className="spinner" /> Syncing…</> : "Refresh Board"}
        </button>

      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "12px",
        marginBottom: "1rem",
      }}>
        <KpiCard title="Total Defects" value={displayKPIs.total} />
        <KpiCard title="Open" value={displayKPIs.open} />
        <KpiCard title="Closed" value={displayKPIs.closed} />
        <KpiCard title="High Severity" value={displayKPIs.highSeverity} />
      </div>

      <h3>Bugs</h3>
            <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, overflowX: "auto", maxHeight: 420 }}>
        {/* scroll container — the inner div can be wider than viewport when many points exist */}
        <div style={{ width: sprintChartWidth, minWidth: "100%", height: 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={topSeries} margin={{ left: 12, right: 24, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" interval={0} angle={-20} dy={10} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="count" stroke="#8884d8" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

       
      {/* Label Classification — Open vs Closed */}
      <div style={{ marginTop: "2rem" }}>
        <LabelBreakdownChart labels={labelsData} onShowList={(name) => setLabelModal(name)} />
      </div> 

      {/* place Priority Breakdown first, Quarter vs Severity second to reduce congestion */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1fr) minmax(420px, 1fr)", gap: "16px", alignItems: "stretch", marginTop: "2rem" }}>
        {/* Priority Breakdown (left) */}
        <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8 }}>
          <h3 style={{ margin: "0 0 8px" }}>Priority Breakdown</h3>

          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {/* Pie chart (left) */}
            <div style={{ flex: 1, minWidth: 200, height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={priorityBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label>
                    {priorityBreakdown.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Quick priority counts + show list (right) */}
            <div style={{ maxWidth: 320, width: "40%" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {["P1", "P2", "P3", "P4", "Other"].map((pkey) => {
                  const g = (priorityGroups && (priorityGroups as any)[pkey]) || { count: 0, label: "" };
                  return (
                    <div key={pkey} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderRadius: 6 }}>
                      <div>
                        <div style={{ fontSize: 13, color: "#666" }}>{pkey} <small style={{ color: "#888" }}>{g.label}</small></div>
                        <div style={{ fontWeight: 700, fontSize: 18 }}>{g.count}</div>
                      </div>
                      <div>
                        <button className="btn-recs" onClick={() => openPriorityModal(pkey)} aria-label={`Show list for ${pkey}`}>
                          Show list
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

            </div>
          </div>
        </div>

        {/* Quarter vs Severity (right) */}
        <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, overflowX: "auto" }}>
          <h3 style={{ margin: "0 0 8px" }}>Quarter vs Severity</h3>
          <div style={{ width: quarterChartWidth, height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={quarterSeveritySeries} margin={{ left: 12, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="quarter" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                {severitiesOrdered.map((sev, idx) => <Bar key={sev} dataKey={sev} stackId="a" fill={COLORS[idx % COLORS.length]} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>


      <h3 style={{ marginTop: "2rem" }}>All Incidents</h3>
      <div style={{ maxHeight: "50vh", overflow: "auto", border: "1px solid #ccc" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ backgroundColor: "#f4f4f4" }}>
            <tr>
              <th>Incident No.</th>
              <th>Creation Time</th>
              <th>Priority</th>
              <th>Brief Detail</th>
              <th>Description</th>
              <th>Status</th>
              <th>Severity</th>
              <th>Root Cause</th>
              <th>Prediction</th>
              <th>Confidence</th>
              <th>Recommendation</th>
              <th>Sprint</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i, idx) => (
              <tr key={idx}>
                <td style={{ padding: 6 }}>{i.incident_no}</td>
                <td style={{ padding: 6 }}>{i.creation_time}</td>
                <td style={{ padding: 6 }}>{i.priority}</td>
                <td style={{ padding: 6 }}>{i.brief_detail}</td>
                <td style={{ padding: 6, maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.description}</td>
                <td style={{ padding: 6 }}>{i.status}</td>
                <td style={{ padding: 6 }}>{i.severity}</td>
                <td style={{ padding: 6 }}>{i.root_cause}</td>
                <td style={{ padding: 6 }}>{i.prediction}</td>
                <td style={{ padding: 6 }}>{i.confidence_score ? `${i.confidence_score}%` : "-"}</td>
                <td style={{ padding: 6 }}>{i.recommendation?.[0]?.summary || "-"}</td>
                <td style={{ padding: 6 }}>{i.Sprint || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Confirm modal */}
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

  {/* Message modal */}
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



  {/* Priority modal (list view) */}
{priorityModalOpen && priorityModalKey && (
  <div
    className="modal-overlay"
    role="dialog"
    aria-modal="true"
    onClick={(e) => { if (e.target === e.currentTarget) closePriorityModal(); }}
  >
    <div className="modal-panel" style={{ width: "min(980px, 96%)", maxHeight: "80vh", overflow: "auto" }}>
      <button className="modal-close" onClick={closePriorityModal} aria-label="Close">✕</button>

      <h3 style={{ marginTop: 0 }}>
        {priorityModalKey} — {(priorityGroups as any)[priorityModalKey]?.label || ""} &nbsp;
        <small style={{ color: "#666", fontWeight: 500 }}>({(priorityGroups as any)[priorityModalKey]?.count || 0})</small>
      </h3>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input
          placeholder="Search issue key or summary..."
          value={priorityFilterText}
          onChange={(e) => { setPriorityFilterText(e.target.value); setPriorityPage(0); }}
          style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
        />
        <div>
          <button className="btn btn-ghost" onClick={() => { setPriorityFilterText(""); }}>Clear</button>
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead style={{ background: "#fafafa", position: "sticky", top: 0, zIndex: 5 }}>
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
          {(() => {
            const groupItems: Incident[] = ((priorityGroups as any)[priorityModalKey]?.items || []) as Incident[];
            const filtered = groupItems.filter(it => {
              if (!priorityFilterText) return true;
              const q = priorityFilterText.toLowerCase();
              return String(it.incident_no || "").toLowerCase().includes(q) ||
                     String(it.brief_detail || it.description || "").toLowerCase().includes(q);
            });
            const start = priorityPage * PRIORITY_PAGE_SIZE;
            const pageItems = filtered.slice(start, start + PRIORITY_PAGE_SIZE);
            return pageItems.map((it, idx) => (
              <tr key={it.incident_no || idx} style={{ borderBottom: "1px solid #f3f3f3" }}>
                <td style={{ padding: 8 }}>{it.incident_no}</td>
                <td style={{ padding: 8, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.brief_detail || it.description}</td>
                <td style={{ padding: 8 }}>{it.priority}</td>
                <td style={{ padding: 8 }}>{it.severity}</td>
                <td style={{ padding: 8 }}>{it.status}</td>
                <td style={{ padding: 8 }}>{it.Sprint || "-"}</td>
                <td style={{ padding: 8 }}>{it.creation_time}</td>
                <td style={{ padding: 8 }}>
                  {/* Replace `https://your-jira-host` with your Jira host OR use item.url if you persist it */}
                  <a className="btn-jira" href={`${JIRA_HOST}/browse/${it.incident_no}`} target="_blank" rel="noreferrer" title="Open in Jira">➤</a>
                </td>
              </tr>
            ));
          })()}
        </tbody>
      </table>

      {/* Pagination */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
        <div>
          <small style={{ color: "#666" }}>
            Showing {(priorityPage * PRIORITY_PAGE_SIZE) + 1} - {Math.min((priorityPage + 1) * PRIORITY_PAGE_SIZE, ((priorityGroups as any)[priorityModalKey]?.items || []).length)} of {(priorityGroups as any)[priorityModalKey]?.items?.length || 0}
          </small>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setPriorityPage(p => Math.max(0, p - 1))} disabled={priorityPage === 0}>Prev</button>
          <button className="btn btn-ghost" onClick={() => setPriorityPage(p => p + 1)} disabled={(priorityPage + 1) * PRIORITY_PAGE_SIZE >= ((priorityGroups as any)[priorityModalKey]?.items || []).length}>Next</button>
        </div>
      </div>
    </div>
  </div>
)}
    
    {labelModal && (
  <LabelIssuesModal label={labelModal} onClose={() => setLabelModal(null)} />
)}


    </div>
  );
}

function KpiCard({ title, value }: { title: string; value: number | string }) {
  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e7e7e7",
      borderRadius: 8,
      padding: "14px 16px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{ fontSize: 12, color: "#666" }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>{value}</div>
    </div>
  );
}
