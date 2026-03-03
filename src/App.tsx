import { useMemo } from "react";
import "./App.css";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

export default function App() {
  // 通过 URL query 区分搜索窗口/设置窗口：主进程创建 settings 窗口时会携带 view=settings
  const isSettings = useMemo(
    () =>
      new URLSearchParams(window.location.search).get("view") === "settings",
    [],
  );
  return isSettings ? <SettingsView /> : <SearchView />;
}

