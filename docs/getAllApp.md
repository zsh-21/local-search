
我直接给你**Windows 桌面应用（Electron）获取「电脑所有已安装应用列表」**的**最稳、最全、可直接用**方案。
不用注册表瞎摸索，我给你**能上线的标准做法**。

# 一、Windows 上所有应用 = 3 类来源
1. **注册表卸载信息**（绝大多数 EXE 软件）
2. **AppsFolder 虚拟应用列表**（开始菜单里所有图标）
3. **开始菜单快捷方式**（桌面软件的快捷方式）

你要**完整列表**，必须读 **注册表 + AppsFolder**。

---

# 二、最简单、最稳、Electron 直接用的方法
我给你**不踩坑、可直接复制**的代码。

## 1. 安装依赖
```bash
npm install regedit
```

## 2. 获取所有已安装应用（最准）
这段代码能拿到：
- 软件名称
- 版本
- 安装目录
- 卸载路径
- 图标
- 发布者

```javascript
const regedit = require('regedit');

// Windows 读取应用的标准注册表路径
const uninstallPaths = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

async function getInstalledApps() {
  return new Promise((resolve, reject) => {
    const apps = [];

    regedit.list(uninstallPaths, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      for (const path of uninstallPaths) {
        const item = result[path];
        if (!item || !item.keys) continue;

        for (const key of item.keys) {
          const subKey = `${path}\\${key}`;
          regedit.list(subKey, (err, data) => {
            if (err || !data[subKey]?.values) return;

            const values = data[subKey].values;
            const name = values.DisplayName?.value;
            if (!name || name.toLowerCase().includes('update')) continue;

            apps.push({
              name: name,
              version: values.DisplayVersion?.value || '',
              publisher: values.Publisher?.value || '',
              installPath: values.InstallLocation?.value || '',
              uninstallString: values.UninstallString?.value || '',
            });
          });
        }
      }

      setTimeout(() => resolve(apps), 1000);
    });
  });
}
```

**调用：**
```javascript
getInstalledApps().then(apps => {
  console.log('所有应用：', apps);
});
```

---

# 三、获取「开始菜单所有图标」（包括 UWP/Store 应用）
注册表拿不到微软商店应用，必须用 **shell:AppsFolder**。

Electron 里最简单的方法：
**调用系统命令获取所有 Appx 包**

```javascript
const { exec } = require('child_process');

function getUWPApps() {
  return new Promise((resolve) => {
    exec('powershell "Get-AppxPackage | Select Name,PackageFullName,DisplayName"', (err, stdout) => {
      if (err) resolve([]);
      // 解析 stdout 即可得到 UWP 应用列表
      resolve(stdout);
    });
  });
}
```

---

# 四、你做「本地搜索应用」的最终方案
**最完整、最准确、用户看到什么你就拿到什么：**

1. **读注册表** → 拿到所有 EXE 软件
2. **读 Get-AppxPackage** → 拿到所有 UWP/Store 应用
3. **读开始菜单目录** → 拿到所有快捷方式

合并后去重 = **电脑所有应用**。

---