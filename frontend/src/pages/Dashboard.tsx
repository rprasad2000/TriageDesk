// src/pages/Dashboard.tsx
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, syncBoard  } from "../api";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Brush, BarChart, Bar, PieChart, Pie, Cell,
} from "recharts";
import dayjs from "dayjs";
import quarterOfYear from "dayjs/plugin/quarterOfYear";
dayjs.extend(quarterOfYear);

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
const HIGH_SEV = new Set(["Blocker", "Critical", "High"]);
const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [yearFilter, setYearFilter] = useState<string>("All");
  const [viewBy, setViewBy] = useState<"sprint"|"month"|"quarter">("sprint");
  const [monthFilter, setMonthFilter] = useState<string>("All"); // '1'..'12' or 'All'
  const [sprintFilter, setSprintFilter] = useState<string>("All");
  const [syncingBoard, setSyncingBoard] = useState<boolean>(false);
  const [liveKPIs, setLiveKPIs] = useState<KPIData | null>(null);
  
  const handleRefreshBoard = async () => {
  if (!window.confirm("Refresh board from Jira? This will fetch the latest dashboard data (no model changes).")) return;
  setSyncingBoard(true);

  try {
    // Trigger backend sync
    const res = await syncBoard(5000);

    // Immediately update KPIs if provided
    if (res?.kpis) {
      setLiveKPIs({
        total: Number(res.kpis.total ?? 0),
        open: Number(res.kpis.open ?? 0),
        closed: Number(res.kpis.closed ?? 0),
        highSeverity: Number(res.kpis.highSeverity ?? 0),
      });
    }

    // ✅ Fire success alert immediately after updating KPIs
    alert("Board refresh started. Data will sync shortly.");

    // Kick off refetch in background to refresh all data
    await queryClient.invalidateQueries({ queryKey: ["incidents", "all"] });

    refetch().finally(() => setLiveKPIs(null));

  } catch (err: any) {
    console.error("Refresh board failed:", err);
    alert("Board refresh failed: " + (err?.message || err));
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
      if (monthFilter !== "All" && String(d.month()+1) !== monthFilter) continue;
      // apply sprintFilter if set (when user wants to restrict by sprint)
      if (sprintFilter !== "All" && String(i.Sprint || "") !== sprintFilter) continue;
      const key = `${d.year()}-${String(d.month()+1).padStart(2,"0")}`;
      monthCounts[key] = (monthCounts[key] || 0) + 1;
    }
    const monthSeries = Object.keys(monthCounts)
      .sort((a,b) => new Date(a + "-01").getTime() - new Date(b + "-01").getTime())
      .map(k => {
        const [y,m] = k.split("-");
        const monthLabel = monthNames[Number(m)-1] ?? m;
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
    const severitiesOrdered = Array.from(sevSet);
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

    // priority breakdown
    const prCounts: Record<string, number> = {};
    for (const i of filtered) {
      const p = (i.priority || "Unknown").trim();
      prCounts[p] = (prCounts[p] || 0) + 1;
    }
    const priorityBreakdown = Object.entries(prCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    return {
      yearsInData: Array.from(yearsSet).sort((a,b)=>b-a),
      rows: filtered,
      sprintSeries,
      monthSeries,
      quarterSeveritySeries,
      severitiesOrdered,
      priorityBreakdown,
      kpis: { total, open, closed, highSeverity },
      availableMonths: Array.from(monthsSet).sort((a,b)=>a-b),
      availableSprints: Array.from(sprintsSet).sort(),
    };
  }, [data, yearFilter, monthFilter, sprintFilter]);

  // Use live KPIs if available, otherwise use computed KPIs
  const displayKPIs = liveKPIs || kpis;

  const sprintChartWidth = Math.max(900, (viewBy === "sprint" ? sprintSeries.length : monthSeries.length) * 120);
  const quarterChartWidth = Math.max(800, quarterSeveritySeries.length * 160);

  if (isLoading) return <p>Loading dashboard...</p>;
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
            {availableMonths.map(m => <option key={m} value={String(m)}>{monthNames[m-1]} ({m})</option>)}
          </select>
        </div>
        <button
          onClick={handleRefreshBoard}
          disabled={syncingBoard}
          style={{ marginLeft: "auto", padding: "6px 12px", background: "black", color: "white", border: "none", borderRadius: 4 }}>
          {syncingBoard ? "Syncing..." : "Refresh Board"}
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
      <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, overflowX: "auto", maxHeight: 380 }}>
        <div style={{ width: sprintChartWidth, height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={topSeries} margin={{ left: 12, right: 24, bottom:40 }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "16px", alignItems: "stretch", marginTop: "2rem" }}>
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

        <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8 }}>
          <h3 style={{ margin: "0 0 8px" }}>Priority Breakdown</h3>
          <ResponsiveContainer width="100%" height={320}>
            <PieChart>
              <Pie data={priorityBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label>
                {priorityBreakdown.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
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