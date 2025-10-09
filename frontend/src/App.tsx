// frontend/src/App.tsx
import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "../pages/Dashboard";
import Train from "../pages/Train";
import Predict from "../pages/Predict";
import Retrain from "../pages/Retrain";

export default function App() {
  return (
    <div className="container-fluid">
      {/* Full-bleed blue band behind the header */}
      <header className="app-hero-full" role="banner" aria-label="Site header">
        <div className="container" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>Defect Classification</h1>

          <nav aria-label="Main navigation" style={{ display: "flex", gap: 14 }}>
            {/* NavLink uses class function to inject active class */}
            <NavLink to="/" end className={({ isActive }) => isActive ? "nav-pill active" : "nav-pill"}>Dashboard</NavLink>
            <NavLink to="/train" className={({ isActive }) => isActive ? "nav-pill active" : "nav-pill"}>Train</NavLink>
            <NavLink to="/predict" className={({ isActive }) => isActive ? "nav-pill active" : "nav-pill"}>Predict</NavLink>
            <NavLink to="/retrain" className={({ isActive }) => isActive ? "nav-pill active" : "nav-pill"}>Retrain</NavLink>
          </nav>
        </div>
      </header>

      {/* Main content area remains inside .container (white panel) for readability */}
      <main>
        <div className="container">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/train" element={<Train />} />
            <Route path="/predict" element={<Predict />} />
            <Route path="/retrain" element={<Retrain />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
