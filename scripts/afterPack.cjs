const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async (context) => {
  const keep = new Set(['zh-CN.pak', 'en-US.pak']);
  const localesDir = path.join(context.appOutDir, 'locales');

  try {
    const entries = await fs.readdir(localesDir, { withFileTypes: true });
    const tasks = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      if (!name.endsWith('.pak')) continue;
      if (keep.has(name)) continue;
      tasks.push(fs.rm(path.join(localesDir, name), { force: true }));
    }
    if (tasks.length > 0) await Promise.all(tasks);
  } catch {}
};

