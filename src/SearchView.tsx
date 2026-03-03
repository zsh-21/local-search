import { SearchViewImpl } from "./search/SearchViewImpl";

// 入口组件：保持对外导出路径稳定，内部实现拆分到 search 目录
export function SearchView() {
  return <SearchViewImpl />;
}
