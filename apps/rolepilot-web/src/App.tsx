import { Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { HomePage } from "./pages/HomePage";
import { NewRunPage } from "./pages/NewRunPage";
import { SettingsPage } from "./pages/SettingsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RunPage } from "./pages/RunPage";
import { RunFlowPrototypePage } from "./pages/RunFlowPrototypePage";

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/new" element={<NewRunPage />} />
        <Route path="/runs/:runId" element={<RunPage />} />
        <Route path="/prototype/run-flow" element={<RunFlowPrototypePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Shell>
  );
}
