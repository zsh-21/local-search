/**
 * 从 iconfont.cn 拉取一组单色 SVG，并生成项目使用的 symbol sprite。
 *
 * 为什么要做这个脚本：
 * - 设置页/搜索页图标需要“风格统一、语义清晰、不过度花哨”，而 iconfont 搜索结果不稳定，手工复制容易出错。
 * - 用脚本把“选型规则”固化下来，后续要补图标时只改映射表即可复用。
 *
 * 注意：
 * - 该脚本只依赖 Node 18+ 自带的 fetch；不需要登录（仅使用公开搜索接口）。
 * - 会尽量挑选 `fills=1` 的单色图标，并移除 SVG 内部的硬编码颜色，让颜色由页面 CSS 控制（currentColor）。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const ICONFONT_SEARCH_ENDPOINT = "https://www.iconfont.cn/api/icon/search.json";

/**
 * 需要生成到 sprite 的图标列表。
 * - `symbolId`：最终写入 sprite 的 <symbol id="...">
 * - `keywords`：用于从 iconfont 搜索的关键词（按顺序尝试）
 */
const ICON_SPECS = [
  { symbolId: "l-icon-sousuo", keywords: ["搜索", "search"] },
  { symbolId: "l-icon-shezhi", keywords: ["设置", "setting", "settings"] },
  { symbolId: "l-icon-jichu", keywords: ["通用", "应用", "仪表盘", "grid"] },
  { symbolId: "l-icon-liucheng", keywords: ["快捷键", "键盘", "流程", "shortcut"] },
  { symbolId: "l-icon-shaixuan", keywords: ["外观", "主题", "调色板", "palette"] },
  {
    symbolId: "l-icon-renyuan1",
    keywords: ["账号", "用户", "person", "user"],
    mustNameIncludes: ["用户", "账号", "person", "user"],
  },
  {
    symbolId: "l-icon-zhongzhi",
    keywords: ["电源开关", "电源", "关机", "poweroff", "power"],
    // “电源”关键词里经常混入“充电”等语义，强制过滤，避免 UI 语义错位。
    mustNameIncludes: ["电源", "关机", "开关", "poweroff", "power"],
    banNameIncludes: ["充电"],
  },
  { symbolId: "l-icon-quxian", keywords: ["状态", "趋势", "曲线", "chart"] },
  { symbolId: "l-icon-banben", keywords: ["历史", "时间", "clock", "history"] },
  { symbolId: "l-icon-jichuxinxi", keywords: ["信息", "提示", "info"] },

  // 下面这些是原来语义不准确的图标：现在按更明确的功能补齐
  { symbolId: "l-icon-folder", keywords: ["文件夹", "folder"] },
  { symbolId: "l-icon-folder-open", keywords: ["打开文件夹", "文件夹 打开", "folder open"] },
  { symbolId: "l-icon-copy", keywords: ["复制", "copy"] },
  {
    symbolId: "l-icon-shield",
    keywords: ["盾牌", "管理员", "安全", "shield"],
    // “管理员”会搜到一些行业图标（例如商家），这里强制语义匹配。
    mustNameIncludes: ["盾牌", "安全", "管理员", "shield"],
    banNameIncludes: ["商家", "女商家", "广告主"],
  },
  { symbolId: "l-icon-trash", keywords: ["删除", "垃圾", "trash"] },
  { symbolId: "l-icon-clear", keywords: ["清空", "关闭", "clear", "close"] },
  { symbolId: "l-icon-refresh", keywords: ["刷新", "reload", "refresh"] },
  { symbolId: "l-icon-link", keywords: ["外链", "链接", "link"] },
  {
    symbolId: "l-icon-pin",
    keywords: ["钉住", "图钉", "pushpin", "pin", "固定"],
    mustNameIncludes: ["钉住", "图钉", "pushpin", "pin", "置顶"],
    banNameIncludes: ["定位"],
  },
  {
    symbolId: "l-icon-pin-off",
    keywords: ["取消钉住", "取消固定", "unpin", "解钉"],
    mustNameIncludes: ["取消钉住", "取消固定", "unpin", "解钉"],
  },
  { symbolId: "l-icon-command", keywords: ["命令", "终端", "terminal", "command"] },
  {
    symbolId: "l-icon-file",
    keywords: ["文件", "文档", "file", "document"],
    mustNameIncludes: ["文件", "文档", "file", "document"],
    banNameIncludes: ["文件夹", "folder"],
  },
  { symbolId: "l-icon-calc", keywords: ["计算器", "计算", "calculator"] },
  { symbolId: "l-icon-chevron-up", keywords: ["上箭头", "向上", "chevron up"] },
];

function buildSearchBody(keyword, pageSize) {
  return new URLSearchParams({
    q: keyword,
    page: "1",
    pageSize: String(pageSize),
    sortType: "updated_at",
    t: String(Date.now()),
  });
}

async function searchIcons(keyword, pageSize = 80) {
  const resp = await fetch(ICONFONT_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      // iconfont 的接口对 UA 较敏感，显式补一个浏览器 UA，避免被返回 HTML。
      "User-Agent": "Mozilla/5.0",
    },
    body: buildSearchBody(keyword, pageSize),
  });

  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text();

  if (!ct.includes("application/json")) {
    throw new Error(
      `iconfont 搜索接口返回了非 JSON 内容（keyword="${keyword}"，content-type="${ct}"），可能被拦截。`,
    );
  }

  const data = JSON.parse(text);
  if (data?.code !== 200) throw new Error(data?.message || "iconfont 搜索失败");

  return Array.isArray(data?.data?.icons) ? data.data.icons : [];
}

function scoreIcon(icon) {
  const svg = String(icon?.show_svg || "");
  const pathCount = (svg.match(/<path\b/g) || []).length;
  const hasCurrentColor = /fill:\s*currentColor/i.test(svg) || /fill="currentColor"/i.test(svg);

  // 评分策略（越大越好）：
  // - 优先单色 fills=1
  // - 优先使用 currentColor（更容易做主题适配）
  // - 适度偏好 path 数量更少（更“克制”）
  let score = 0;
  score += Number(icon?.is_private === 0) * 50;
  score += Number(icon?.fills === 1) * 30;
  score += Number(hasCurrentColor) * 10;
  score += Math.max(0, 10 - Math.min(10, pathCount));

  return { score, pathCount, hasCurrentColor };
}

function sanitizeSvgToSymbolInner(svg) {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/i);
  const viewBox = viewBoxMatch?.[1] || "0 0 1024 1024";

  // 抽取 <svg> ... </svg> 的内容
  const innerMatch = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  let inner = (innerMatch?.[1] || "").trim();

  // 统一移除硬编码颜色/样式，避免出现“花哨”的多色图标或主题不一致。
  // 只保留结构属性（如 fill-rule / clip-rule 等）。
  inner = inner
    .replace(/\sstyle="[^"]*"/gi, "")
    .replace(/\sfill="(?!none\b|currentColor\b)[^"]*"/gi, "")
    .replace(/\sstroke="(?!none\b|currentColor\b)[^"]*"/gi, "")
    .replace(/\sstroke-width="[^"]*"/gi, "")
    .replace(/\swidth="[^"]*"/gi, "")
    .replace(/\sheight="[^"]*"/gi, "");

  return { viewBox, inner };
}

async function resolveIconByKeywords(spec) {
  let lastError = null;

  for (const kw of spec.keywords) {
    try {
      const icons = await searchIcons(kw);
      const candidates = icons.filter((it) => it && it.is_private === 0 && it.show_svg);
      if (candidates.length === 0) continue;

      const mustIncludes = Array.isArray(spec.mustNameIncludes)
        ? spec.mustNameIncludes.map((s) => String(s).toLowerCase()).filter(Boolean)
        : [];
      const banIncludes = Array.isArray(spec.banNameIncludes)
        ? spec.banNameIncludes.map((s) => String(s).toLowerCase()).filter(Boolean)
        : [];

      const filtered = candidates.filter((it) => {
        const name = String(it?.name || "").toLowerCase();
        if (banIncludes.some((bad) => bad && name.includes(bad))) return false;
        if (mustIncludes.length === 0) return true;
        return mustIncludes.some((m) => m && name.includes(m));
      });

      const finalCandidates = filtered.length > 0 ? filtered : candidates;

      const scored = finalCandidates
        .map((it) => ({ it, meta: scoreIcon(it) }))
        .sort((a, b) => b.meta.score - a.meta.score);

      return {
        keyword: kw,
        chosen: scored[0].it,
        chosenMeta: scored[0].meta,
      };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError || new Error(`未找到可用图标：${spec.symbolId}`);
}

async function main() {
  const outPath = path.resolve("public/iconfont-icons/sprite.svg");

  const symbols = [];
  const pickLog = [];

  for (const spec of ICON_SPECS) {
    const resolved = await resolveIconByKeywords(spec);
    const svg = String(resolved.chosen.show_svg);
    const { viewBox, inner } = sanitizeSvgToSymbolInner(svg);

    if (!inner) {
      throw new Error(
        `图标解析失败（symbolId="${spec.symbolId}"，iconId=${resolved.chosen.id}）。`,
      );
    }

    symbols.push(`<symbol id="${spec.symbolId}" viewBox="${viewBox}">${inner}</symbol>`);
    pickLog.push({
      symbolId: spec.symbolId,
      keyword: resolved.keyword,
      iconId: resolved.chosen.id,
      iconName: resolved.chosen.name,
      fills: resolved.chosen.fills,
      pathCount: resolved.chosenMeta.pathCount,
    });
  }

  const sprite =
    `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">` +
    `\n` +
    symbols.join("\n") +
    `\n</svg>\n`;

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, sprite, "utf8");

  // 输出一份简短日志，方便确认“选到了什么图标”
  console.log("[iconfont-sprite] 生成完成：", outPath);
  for (const row of pickLog) {
    console.log(
      `- ${row.symbolId} <= ${row.keyword} (id=${row.iconId}, name="${row.iconName}", fills=${row.fills}, paths=${row.pathCount})`,
    );
  }
}

main().catch((e) => {
  console.error("[iconfont-sprite] 生成失败：", e);
  process.exit(1);
});
