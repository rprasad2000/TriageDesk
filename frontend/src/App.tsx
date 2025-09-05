// frontend/src/App.tsx
import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Train from "./pages/Train";
import Predict from "./pages/Predict";
import Retrain from "./pages/Retrain";
import Incidents from "./pages/Incidents";

export default function App() {
  return (
    <div className="container">
      <header>
        <h1>Defect Classification</h1>
        <nav>
          {/* <NavLink to="/" end>Dashboard</NavLink> */}
          <NavLink to="/" end>Incidents</NavLink>
          <NavLink to="/train">Train</NavLink>
          <NavLink to="/predict">Predict</NavLink>
          <NavLink to="/retrain">Retrain</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          {/* <Route path="/" element={<Dashboard />} /> */}
          <Route path="/" element={<Incidents />} />
          <Route path="/train" element={<Train />} />
          <Route path="/predict" element={<Predict />} />
          <Route path="/retrain" element={<Retrain />} />
        </Routes>
      </main>
    </div>
  );
}