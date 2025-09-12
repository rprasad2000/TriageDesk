// frontend/src/App.tsx
import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "../pages/Dashboard";
import Train from "../pages/Train";
import Predict from "../pages/Predict";
import Retrain from "../pages/Retrain";

export default function App() {
  return (
    <div className="container-fluid">
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 0" }}>
        <h1 style={{ margin: 0 }}>Defect Classification</h1>
        <nav style={{ display: "flex", gap: 16 }}>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/train">Train</NavLink>
          <NavLink to="/predict">Predict</NavLink>
          <NavLink to="/retrain">Retrain</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/train" element={<Train />} />
          <Route path="/predict" element={<Predict />} />
          <Route path="/retrain" element={<Retrain />} />
        </Routes>
      </main>
    </div>
  );
}
