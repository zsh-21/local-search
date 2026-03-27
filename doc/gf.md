# Electron + React + TypeScript 项目 **代码规范 & 最佳实践**
## （企业级、可直接落地、防屎山、高性能）

完全适配你的技术栈：**Electron + React + TypeScript**，包含**目录结构、命名、渲染进程/主进程、IPC、状态、性能、安全**全套规范。

---

# 一、项目目录结构（强制规范）
**清晰的结构 = 低维护成本**
```
src/
├── main/                 # 主进程（Electron 核心）
│   ├── index.ts          # 主进程入口
│   ├── ipc/              # IPC 处理（handle/invoke）
│   ├── services/          # 系统服务（文件、网络、打印）
│   └── utils/             # 主进程工具
├── renderer/              # 渲染进程（React + TS）
│   ├── assets/            # 静态资源
│   ├── components/        # 公共组件
│   ├── pages/             # 页面
│   ├── hooks/             # 自定义 Hooks
│   ├── store/             # 状态管理
│   ├── utils/             # 前端工具
│   ├── types/             # TS 类型定义
│   └── ipc/               # 渲染进程 IPC 调用
├── shared/                # 主进程 + 渲染进程共享代码
│   ├── constants/         # 常量
│   ├── ipc/               # IPC 通道名
│   └── types/             # 共享 TS 类型
```

---

# 二、命名规范（React + TS + Electron 专用）
## 1. 文件命名
- **组件/页面**：大驼峰 `UserLogin.tsx` `HomePage.tsx`
- **工具/函数**：小驼峰 `formatDate.ts` `request.ts`
- **常量**：短横线 `ipc-channels.ts` `app-config.ts`

## 2. 变量/函数/类
- **组件**：大驼峰 `UserForm` `TableList`
- **Hooks**：以 use 开头 `useUser` `useIpc`
- **接口/类型**：I 开头 / 后缀 Type
  ```ts
  interface UserInfo {}
  type UserStatus = 'online' | 'offline'
  ```
- **IPC 通道**：全小写 + 冒号分隔
  ```ts
  // shared/ipc/ipc-channels.ts
  export const IPC_USER_GET = 'user:get'
  export const IPC_FILE_SAVE = 'file:save'
  ```

---

# 三、TypeScript 强制最佳实践
## 1. 禁止 any
必须用 **interface / type** 定义结构
## 2. 共享类型放在 shared/types
主进程、渲染进程共用类型必须统一维护
## 3. 函数必须标注返回值
```ts
const getUser = async (id: string): Promise<UserInfo> => {}
```
## 4. 优先使用 const，少用 let，不用 var

---

# 四、React 最佳实践（渲染进程）
## 1. 组件必须拆分
- 一个组件 ≤ 150 行
- 逻辑抽成 **Custom Hooks**
## 2. 状态下放，减少重渲染
- 不滥用全局状态
- 相同 UI 逻辑抽成 Hooks
## 3. 禁止在 useEffect 写复杂业务
逻辑写在 Service / Hook 里，保持组件干净
## 4. 键值、常量统一管理
不写魔法字符串、魔法数字

---

# 五、Electron 核心最佳实践（最重要）
## 1. 主进程 / 渲染进程职责严格分离
### 主进程（main）
- 文件操作
- 系统调用
- 网络请求
- 数据库
- 启动、窗口管理
### 渲染进程（React）
- 只负责：UI展示、交互、调用IPC
- **绝对不写业务逻辑、系统操作**
## 2. IPC 通信必须规范化（防混乱、防bug）
### 统一 IPC 通道定义（shared）
```ts
// shared/ipc/ipc-channels.ts
export const IPC_FILE_OPEN = 'file:open'
```
### 主进程只处理 handle
```ts
// main/ipc/fileHandlers.ts
ipcMain.handle(IPC_FILE_OPEN, async () => {})
```
### 渲染进程只调用 invoke
```ts
// renderer/ipc/ipcFile.ts
export const openFile = () => ipcRenderer.invoke(IPC_FILE_OPEN)
```

## 3. 禁止在渲染进程直接访问 node API
必须通过 **IPC** 调用

## 4. 窗口统一管理
不分散创建窗口，统一放 `main/window/`

---

# 六、IPC 通信最佳实践（防屎山核心）
## 1. 一个 IPC 只做一件事
## 2. 统一错误处理
主进程所有 IPC 必须 **try/catch**
## 3. 统一返回格式
```ts
{
  success: boolean,
  data?: any,
  error?: string
}
```
## 4. 不写匿名 IPC
所有 IPC 必须**有名字、有注释、有类型**

---

# 七、代码复用最佳实践
## 1. 相同逻辑 > 2 次必须抽成公共函数
## 2. 相同常量统一放在 shared/constants
## 3. 工具函数分目录存放
- `renderer/utils` 前端通用
- `main/utils` 主进程通用
- `shared/utils` 全项目通用

---

# 八、注释最佳实践
1. IPC 必须写注释（作用、参数、返回）
2. 复杂业务逻辑写**为什么**，不写做什么
3. 公共函数必须写文档注释
4. 不保留废弃代码、调试代码

---

# 九、性能最佳实践
1. 不在主进程做阻塞操作
2. 大文件操作必须异步
3. React 组件用 `memo` 优化渲染
4. 不滥用全局状态
5. IPC 通信避免频繁大量数据传输

---

# 十、安全最佳实践（Electron 必须遵守）
1. 不开启 `nodeIntegration: true`
2. 不开启 `contextIsolation: false`
3. 不使用 `remote` 模块
4. IPC 必须校验参数
5. 不加载未知远程内容

---

# 十一、Git 提交规范
```
feat: 新增xxx功能
fix: 修复xxx问题
refactor: 重构xxx（无功能变化）
style: 格式调整
chore: 构建/依赖/配置
```

---

# 🔥 最终最强精简版（可直接贴团队手册）
1. **主进程管系统，渲染进程管UI，IPC只做桥梁**
2. **IPC通道统一管理，禁止匿名调用**
3. **TS 禁止 any，类型必须共享**
4. **组件拆分、逻辑抽Hooks**
5. **常量统一维护，禁止魔法值**
6. **函数单一职责，提前return**
7. **IPC必须try/catch，错误统一返回**
8. **不写重复代码，不复制粘贴**
9. **注释写原因，不写废话**
10. **安全规范必须遵守，不降低安全配置**

---
