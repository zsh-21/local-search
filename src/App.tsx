import { useMemo } from "react";
import "./App.css";
import { GlobalTitleTooltip } from "./components/GlobalTitleTooltip";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

export default function App() {
  const isSettings = useMemo(
    () => new URLSearchParams(window.location.search).get("view") === "settings",
    [],
  );
  return (
    <>
      {isSettings ? <SettingsView /> : <SearchView />}
      <GlobalTitleTooltip />
    </>
  );
}
