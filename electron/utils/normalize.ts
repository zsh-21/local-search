export function normalizeAppGroupKey(name: string) {
  // 将“主应用/卸载/升级/服务/修复”等条目归为同一组：用于把周边应用一起展示出来
  // 例如：搜索“QQ音乐”时，也能补齐“卸载 QQ音乐”“QQ音乐升级服务”等关联项
  const raw = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!raw) return '';
  let s = raw;
  s = s.replace(/（.*?）|\(.*?\)|【.*?】|\[.*?\]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(卸载|uninstall)\s+/g, '');
  s = s.replace(/\s+(卸载|uninstall)$/g, '');
  s = s.replace(
    /(升级|更新|update|updater|upgrade|installer|setup|repair|service|服务|助手|helper|daemon|后台|background)\b/g,
    ' '
  );
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
