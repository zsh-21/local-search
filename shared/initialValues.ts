import type { AppSettings, ResultActionButtonId } from "./settingsTypes";

// 这里集中维护“跨渲染进程/主进程共享”的默认值：
// - 只放两端都必须一致的默认项（例如默认设置、默认快捷键、基础类型列表）
// - 渲染端/主进程各自独有的默认值仍放在各自的 constants/initialValues.ts 中

// 内置基础搜索类型：用于排序、禁用、下拉展示等逻辑的允许值集合
export const BASE_SEARCH_TYPE_IDS = ["all", "app", "file", "folder", "image", "video", "settings"] as const;

// 默认“呼出搜索窗口”的快捷键：
// - 这是用户最常看到的默认值之一，渲染端展示与主进程注册必须一致
export const DEFAULT_SEARCH_SHORTCUT = "Alt+S";
// 默认“打开设置窗口”的快捷键：
// - 同样需要与主进程注册保持一致
export const DEFAULT_SETTINGS_SHORTCUT = "Alt+Shift+S";

// 默认搜索结果“右侧操作按钮”顺序：
// - 当用户未配置或配置被清空时回落到这里
// - 最多展示三项，具体限制与过滤逻辑在主进程/渲染进程的设置归一化逻辑里处理
export const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ["openFolder", "copyPath", "deleteHistory"];

// 默认设置（跨进程唯一默认来源）：
// - 主进程：settings.json 读取失败/字段缺失时回落
// - 渲染端：主进程尚未返回设置或返回异常时回落
// - 若需要新增设置字段，应优先在 shared/settingsTypes.ts 增加类型，再在这里补默认值
export const DEFAULT_SETTINGS = {
  // 是否开机启动：主进程会根据该值调用 app.setLoginItemSettings
  autoStart: true,
  // 呼出搜索窗口快捷键
  searchShortcut: DEFAULT_SEARCH_SHORTCUT,
  // 打开设置窗口快捷键
  settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
  // 主题：影响渲染端 UI 与部分窗口背景色策略
  theme: "dark",
  // 历史记录最大展示条数：0 表示不展示历史
  historyLimit: 5,
  // 默认搜索类型：例如 all/app/file/folder...
  defaultSearchTypeId: "all",
  // 自定义扩展名搜索类型：形如 [".psd", ".md"]，最终会映射为 ext:psd 等
  customSearchTypes: [],
  // 默认类型顺序：包含“应用”类型，便于 Tab/Shift+Tab 快速切换
  searchTypeOrder: [...BASE_SEARCH_TYPE_IDS],
  // 被禁用的类型：例如用户不想看到 image/video
  disabledSearchTypeIds: [],
  // 索引时需要跳过的路径：用于加速与减少噪音
  ignoredPaths: [],
  // 关闭搜索窗口时是否保留输入/选择状态
  keepStateOnClose: true,
  // 默认显示路径：便于区分同名文件
  showResultPath: true,
  // 是否启用历史记录：关闭后不写入 history.json
  enableHistory: true,
  // 强调色：影响按钮/高亮等视觉元素
  accentColor: "#38bdf8",
  // 是否启用背景特效
  enableEffect: false,
  // 背景特效类型：粒子/星际/波纹
  effectType: "particles",
  // 背景图本地路径：渲染侧展示时会通过主进程转为可用的 dataUrl
  backgroundImagePath: "",
  // 背景图透明度：0~1
  backgroundImageOpacity: 0.25,
  // 自定义头像本地路径：渲染侧展示时会通过主进程转为可用的 dataUrl
  customAvatarPath: "",
  // 右侧按钮默认顺序：最多三项
  resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
  // 搜索窗口初始宽度：主进程创建窗口时使用
  searchWindowInitialWidth: 460,
  // 搜索窗口最大高度：渲染端自适应 resize 时会受该值限制
  searchWindowMaxHeight: 360,
  // 搜索结果最大展示条数：用于限制 UI 列表渲染成本
  searchDisplayLimit: 100,
  // 是否启用紧凑模式：影响列表项高度与整体密度
  compactMode: false,
  // 常用文件扩展名（用于优先索引）：办公/学习常见文档 + 常见代码/配置 + 常见压缩包
  // 说明：这里只影响“索引构建顺序”，不会限制最终索引范围
  preferredFileExtensions: [
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.pdf',
    '.txt',
    '.md',
    '.csv',
    '.json',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.java',
    '.exe',
    '.msi',
    '.zip',
    '.rar',
    '.7z',
  ],
} satisfies AppSettings;
