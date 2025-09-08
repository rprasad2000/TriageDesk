// import { useMemo, useState } from "react";
// import { useQuery } from "@tanstack/react-query";
// import { api } from "../api";
// import {
//   LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
//   ResponsiveContainer, Brush, BarChart, Bar, PieChart, Pie, Cell,
// } from "recharts";
// import dayjs from "dayjs";
// import quarterOfYear from "dayjs/plugin/quarterOfYear";
// dayjs.extend(quarterOfYear);

// type Incident = {
//   incident_no: string;
//   creation_time: string;   // ISO or 'YYYY-MM-DD' or 'DD-MM-YYYY'
//   priority: string;
//   brief_detail: string;
//   description: string;
//   status: string;
//   severity: string;
//   root_cause: string;
//   prediction: string;
//   confidence_score: number;
//   recommendation: any;
//   Sprint?: string;
// };

// // ---------- helpers ----------
// const parseDate = (s?: string) => {
//   if (!s) return null;
//   const iso = dayjs(s);
//   if (iso.isValid()) return iso;
//   const a = dayjs(s, "YYYY-MM-DD", true);
//   if (a.isValid()) return a;
//   const b = dayjs(s, "DD-MM-YYYY", true);
//   if (b.isValid()) return b;
//   return null;
// };

// const sprintSortKey = (label: string): [number, number] => {
//   // "Sprint 7 (2024)" or "Jan-2025"
//   const m = label?.match(/Sprint\s+(\d+)\s*\((\d{4})\)/i);
//   if (m) return [parseInt(m[2], 10), parseInt(m[1], 10)];
//   const d = dayjs(label, "MMM-YYYY", true);
//   if (d.isValid()) return [d.year(), d.month() + 1];
//   return [9999, 9999];
// };

// const QUARTER_LABEL = (d: dayjs.Dayjs) => `Q${d.quarter()}-${d.year()}`;
// const COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff7f50", "#8dd1e1", "#a4de6c", "#d0ed57", "#d66ad1"];
// const HIGH_SEV = new Set(["Blocker", "Critical", "High"]);

// // ---------- component ----------
// export default function Incidents() {
//   // hooks must be top-level and stable across renders
//   const [yearFilter, setYearFilter] = useState<string>("All");

//   const { data, isLoading, isError, error } = useQuery<Incident[]>({
//     queryKey: ["incidents", "2024-01-01", "2025-12-31"],
//     queryFn: () =>
//       api.get("/incidents", {
//         params: { start: "2024-01-01", end: "2025-12-31", max_results: 1000 },
//       }).then(r => r.data),
//     staleTime: 60_000,
//   });

//   // Always call useMemo (hook order stable). The callback can handle undefined data.
//   const {
//     yearsInData,
//     rows,
//     sprintSeries,
//     quarterSeveritySeries,
//     severitiesOrdered,
//     priorityBreakdown,
//     kpis,
//   } = useMemo(() => {
//     const yearsSet = new Set<number>();
//     const filtered: Incident[] = [];

//     if (Array.isArray(data)) {
//       for (const i of data) {
//         const d = parseDate(i.creation_time);
//         if (!d) continue;
//         yearsSet.add(d.year());
//         if (yearFilter !== "All" && String(d.year()) !== yearFilter) continue;
//         filtered.push(i);
//       }
//     }

//     // KPIs
//     const total = filtered.length;
//     let open = 0, closed = 0, highSeverity = 0;
//     for (const i of filtered) {
//       const st = (i.status || "").toLowerCase();
//       if (st.includes("done") || st.includes("closed") || st.includes("resolved")) closed++;
//       else open++;
//       if (HIGH_SEV.has((i.severity || "").trim())) highSeverity++;
//     }

//     // Sprint line series (prefer Jira Sprint; else month label)
//     const sprintCounts: Record<string, number> = {};
//     for (const i of filtered) {
//       const d = parseDate(i.creation_time);
//       if (!d) continue;
//       const label = (i.Sprint && i.Sprint.trim()) ? i.Sprint.trim() : d.format("MMM-YYYY");
//       sprintCounts[label] = (sprintCounts[label] || 0) + 1;
//     }
//     const sprintSeries = Object.entries(sprintCounts)
//       .map(([sprint, count]) => ({ sprint, count }))
//       .sort((a, b) => {
//         const [ya, sa] = sprintSortKey(a.sprint);
//         const [yb, sb] = sprintSortKey(b.sprint);
//         return ya === yb ? sa - sb : ya - yb;
//       });

//     // Quarter × Severity stacked bars
//     const quarterMap: Record<string, Record<string, number>> = {};
//     const sevSet = new Set<string>();
//     for (const i of filtered) {
//       const d = parseDate(i.creation_time);
//       if (!d) continue;
//       const q = QUARTER_LABEL(d);
//       const sev = (i.severity || "Unknown").trim();
//       sevSet.add(sev);
//       quarterMap[q] ??= {};
//       quarterMap[q][sev] = (quarterMap[q][sev] || 0) + 1;
//     }
//     const severitiesOrdered = Array.from(sevSet);
//     const quarterSeveritySeries = Object.entries(quarterMap)
//       .map(([quarter, sevCounts]) => ({ quarter, ...sevCounts }))
//       .sort((a, b) => {
//         const ma = a.quarter.match(/Q(\d)-(\d{4})/);
//         const mb = b.quarter.match(/Q(\d)-(\d{4})/);
//         if (ma && mb) {
//           const ya = parseInt(ma[2], 10), yb = parseInt(mb[2], 10);
//           const qa = parseInt(ma[1], 10), qb = parseInt(mb[1], 10);
//           return ya === yb ? qa - qb : ya - yb;
//         }
//         return a.quarter.localeCompare(b.quarter);
//       });

//     // Priority breakdown (pie)
//     const prCounts: Record<string, number> = {};
//     for (const i of filtered) {
//       const p = (i.priority || "Unknown").trim();
//       prCounts[p] = (prCounts[p] || 0) + 1;
//     }
//     const priorityBreakdown = Object.entries(prCounts)
//       .map(([name, value]) => ({ name, value }))
//       .sort((a, b) => b.value - a.value);

//     return {
//       yearsInData: Array.from(yearsSet).sort(),
//       rows: filtered,
//       sprintSeries,
//       quarterSeveritySeries,
//       severitiesOrdered,
//       priorityBreakdown,
//       kpis: { total, open, closed, highSeverity },
//     };
//   }, [data, yearFilter]);

//   // derived widths for horizontal scroll
//   const sprintChartWidth = Math.max(900, sprintSeries.length * 120);
//   const quarterChartWidth = Math.max(800, quarterSeveritySeries.length * 160);

//   // ---------- render ----------
//   if (isLoading) return <p>Loading incidents...</p>;
//   if (isError) {
//     console.error("Error fetching incidents:", error);
//     return <p style={{ color: "crimson" }}>⚠ Error fetching incidents</p>;
//   }
//   if (!data || data.length === 0) return <p>No incidents found.</p>;

//   return (
//     <div style={{ padding: "2rem" }}>
//       <h2>Defect Dashboard</h2>

//       {/* Year filter */}
//       <div style={{ margin: "0 0 1rem 0" }}>
//         <label style={{ marginRight: 8 }}>Year:</label>
//         <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)}>
//           <option value="All">All</option>
//           {yearsInData.map((y) => <option key={y} value={String(y)}>{y}</option>)}
//         </select>
//       </div>

//       {/* KPI Cards */}
//       <div style={{
//         display: "grid",
//         gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
//         gap: "12px",
//         marginBottom: "1rem",
//       }}>
//         <KpiCard title="Total Defects" value={kpis.total} />
//         <KpiCard title="Open" value={kpis.open} />
//         <KpiCard title="Closed" value={kpis.closed} />
//         <KpiCard title="High Severity" value={kpis.highSeverity} />
//       </div>

//       {/* Sprint Line */}
//       <h3>Bugs per Sprint</h3>
//       <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, overflowX: "auto", maxHeight: 380 }}>
//         <div style={{ width: sprintChartWidth, height: 320 }}>
//           <ResponsiveContainer width="100%" height="100%">
//             <LineChart data={sprintSeries} margin={{ left: 12, right: 24 }}>
//               <CartesianGrid strokeDasharray="3 3" />
//               <XAxis dataKey="sprint" interval={0} angle={-20} dy={10} />
//               <YAxis allowDecimals={false} />
//               <Tooltip />
//               <Legend />
//               <Line type="monotone" dataKey="count" stroke="#8884d8" />
//               <Brush dataKey="sprint" height={18} />
//             </LineChart>
//           </ResponsiveContainer>
//         </div>
//       </div>

//       {/* Quarter × Severity + Priority */}
//       <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "16px", alignItems: "stretch", marginTop: "2rem" }}>
//         <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, overflowX: "auto" }}>
//           <h3 style={{ margin: "0 0 8px" }}>Quarter vs Severity</h3>
//           <div style={{ width: quarterChartWidth, height: 320 }}>
//             <ResponsiveContainer width="100%" height="100%">
//               <BarChart data={quarterSeveritySeries} margin={{ left: 12, right: 24 }}>
//                 <CartesianGrid strokeDasharray="3 3" />
//                 <XAxis dataKey="quarter" />
//                 <YAxis allowDecimals={false} />
//                 <Tooltip />
//                 <Legend />
//                 {severitiesOrdered.map((sev, idx) => <Bar key={sev} dataKey={sev} stackId="a" fill={COLORS[idx % COLORS.length]} />)}
//               </BarChart>
//             </ResponsiveContainer>
//           </div>
//         </div>

//         <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8 }}>
//           <h3 style={{ margin: "0 0 8px" }}>Priority Breakdown</h3>
//           <ResponsiveContainer width="100%" height={320}>
//             <PieChart>
//               <Pie data={priorityBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label>
//                 {priorityBreakdown.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
//               </Pie>
//               <Tooltip />
//               <Legend />
//             </PieChart>
//           </ResponsiveContainer>
//         </div>
//       </div>

//       {/* Table */}
//       <h3 style={{ marginTop: "2rem" }}>All Incidents</h3>
//       <div style={{ maxHeight: "50vh", overflow: "auto", border: "1px solid #ccc" }}>
//         <table border={1} cellPadding={6} style={{ width: "100%", borderCollapse: "collapse" }}>
//           <thead style={{ backgroundColor: "#f4f4f4" }}>
//             <tr>
//               <th>Incident No.</th>
//               <th>Creation Time</th>
//               <th>Priority</th>
//               <th>Brief Detail</th>
//               <th>Description</th>
//               <th>Status</th>
//               <th>Severity</th>
//               <th>Root Cause</th>
//               <th>Prediction</th>
//               <th>Confidence</th>
//               <th>Recommendation</th>
//               <th>Sprint</th>
//             </tr>
//           </thead>
//           <tbody>
//             {rows.map((i, idx) => (
//               <tr key={idx}>
//                 <td>{i.incident_no}</td>
//                 <td>{i.creation_time}</td>
//                 <td>{i.priority}</td>
//                 <td>{i.brief_detail}</td>
//                 <td style={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.description}</td>
//                 <td>{i.status}</td>
//                 <td>{i.severity}</td>
//                 <td>{i.root_cause}</td>
//                 <td>{i.prediction}</td>
//                 <td>{i.confidence_score}%</td>
//                 <td>{i.recommendation?.[0]?.summary || "-"}</td>
//                 <td>{i.Sprint || "-"}</td>
//               </tr>
//             ))}
//           </tbody>
//         </table>
//       </div>
//     </div>
//   );
// }

// // Simple KPI card
// function KpiCard({ title, value }: { title: string; value: number | string }) {
//   return (
//     <div style={{
//       background: "#fff",
//       border: "1px solid #e7e7e7",
//       borderRadius: 8,
//       padding: "14px 16px",
//       boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
//     }}>
//       <div style={{ fontSize: 12, color: "#666" }}>{title}</div>
//       <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>{value}</div>
//     </div>
//   );
// }
