export function getWindowsSettingsItems() {
  if (process.platform !== "win32") return [] as Array<{ name: string; uri: string }>;
  return [
    { name: "\u7cfb\u7edf\u8bbe\u7f6e", uri: "ms-settings:" },
    { name: "\u7f51\u7edc\u548c Internet", uri: "ms-settings:network" },
    { name: "Wi-Fi", uri: "ms-settings:network-wifi" },
    { name: "\u4ee5\u592a\u7f51", uri: "ms-settings:network-ethernet" },
    { name: "VPN", uri: "ms-settings:network-vpn" },
    { name: "\u4ee3\u7406", uri: "ms-settings:network-proxy" },
    { name: "\u84dd\u7259\u548c\u8bbe\u5907", uri: "ms-settings:bluetooth" },
    { name: "\u663e\u793a", uri: "ms-settings:display" },
    { name: "\u591c\u95f4\u6a21\u5f0f", uri: "ms-settings:nightlight" },
    { name: "\u58f0\u97f3", uri: "ms-settings:sound" },
    { name: "\u901a\u77e5", uri: "ms-settings:notifications" },
    { name: "\u7535\u6e90\u548c\u7535\u6c60", uri: "ms-settings:batterysaver" },
    { name: "\u5b58\u50a8", uri: "ms-settings:storagesense" },
    { name: "\u5e94\u7528", uri: "ms-settings:appsfeatures" },
    { name: "\u9ed8\u8ba4\u5e94\u7528", uri: "ms-settings:defaultapps" },
    { name: "\u542f\u52a8", uri: "ms-settings:startupapps" },
    { name: "\u65f6\u95f4\u548c\u8bed\u8a00", uri: "ms-settings:dateandtime" },
    { name: "\u8bed\u8a00", uri: "ms-settings:regionlanguage" },
    { name: "\u952e\u76d8", uri: "ms-settings:keyboard" },
    { name: "\u9f20\u6807", uri: "ms-settings:mousetouchpad" },
    { name: "\u4e2a\u6027\u5316", uri: "ms-settings:personalization" },
    { name: "\u4efb\u52a1\u680f", uri: "ms-settings:taskbar" },
    { name: "\u4e3b\u9898", uri: "ms-settings:themes" },
    { name: "\u8d26\u6237", uri: "ms-settings:yourinfo" },
    { name: "\u767b\u5f55\u9009\u9879", uri: "ms-settings:signinoptions" },
    { name: "Windows \u66f4\u65b0", uri: "ms-settings:windowsupdate" },
    { name: "\u9690\u79c1\u548c\u5b89\u5168\u6027", uri: "ms-settings:privacy" },
    { name: "\u5f00\u53d1\u8005\u9009\u9879", uri: "ms-settings:developers" },
    { name: "\u5173\u4e8e", uri: "ms-settings:about" },
  ];
}

export function searchSettingsItems(input: {
  searchTypeId: string;
  settingsItems: Array<{ name: string; uri: string }>;
}) {
  type SettingsSearchItem = {
    name: string;
    path: string;
    type: "settings";
    source: "settings";
    rawSource: "settings";
    sourceScore: number;
  };
  type SettingsSearchOnlyPayload = { results: SettingsSearchItem[]; totalCount: number } | null;

  const { searchTypeId, settingsItems } = input;
  if (searchTypeId !== "all" && searchTypeId !== "settings") {
    return { settingsResults: [] as SettingsSearchItem[], settingsOnly: null as SettingsSearchOnlyPayload };
  }

  const out: SettingsSearchItem[] = settingsItems.map((it) => ({
    name: it.name,
    path: it.uri,
    type: "settings",
    source: "settings",
    rawSource: "settings",
    sourceScore: 90,
  }));

  if (searchTypeId === "settings") {
    return { settingsResults: [] as SettingsSearchItem[], settingsOnly: { results: out, totalCount: out.length } };
  }

  return { settingsResults: out, settingsOnly: null as SettingsSearchOnlyPayload };
}
